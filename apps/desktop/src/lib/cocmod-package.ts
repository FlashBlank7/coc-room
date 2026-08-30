import {
  assetDescriptorV1Schema,
  boardV1Schema,
  modulePackageSchema,
  type AssetDescriptorV1,
  type BoardV1,
  type ModulePackageV1,
} from "@coc-room/protocol";
import { unzipSync, zipSync } from "fflate";

const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 4_096;
const MAX_COMPRESSION_RATIO = 200;
const MANIFEST_PATH = "manifest.json";
const MODULE_PATH = "module.json";
export const COCMOD_CONTENTS_EXTENSION = "org.coc-room.package.v1";

export interface CocmodBoardInput {
  readonly id: string;
  readonly value: BoardV1;
}

export interface CocmodAssetInput extends AssetDescriptorV1 {
  readonly bytes: Uint8Array;
  readonly extension: string;
}

export interface StoredCocmodContentsV1 {
  readonly boards: readonly CocmodBoardInput[];
  readonly assets: readonly (AssetDescriptorV1 & { readonly extension: string })[];
}

interface CocmodManifestV1 {
  readonly format: "coc-room-module";
  readonly formatVersion: 1;
  readonly modulePath: typeof MODULE_PATH;
  readonly moduleSchemaVersion: number;
  readonly boards: readonly { id: string; path: string }[];
  readonly assets: readonly {
    schemaVersion: 1;
    assetId: string;
    mediaType: string;
    byteLength: number;
    width?: number;
    height?: number;
    durationMs?: number;
    path: string;
  }[];
}

export interface ImportedCocmodPackage {
  readonly module: ModulePackageV1;
  readonly boards: readonly CocmodBoardInput[];
  readonly assets: readonly CocmodAssetInput[];
}

/** Builds the only new module export format. Empty folders remain explicit. */
export async function createCocmodPackage(
  candidate: ModulePackageV1,
  options: {
    readonly boards?: readonly CocmodBoardInput[];
    readonly assets?: readonly CocmodAssetInput[];
  } = {},
): Promise<Uint8Array> {
  const modulePackage = modulePackageSchema.parse(candidate);
  const boards = options.boards ?? [];
  const assets = options.assets ?? [];
  const seenPaths = new Set<string>([MANIFEST_PATH, MODULE_PATH, "boards/", "assets/sha256/"]);

  const boardEntries = boards.map((board) => {
    const id = safePortableId(board.id, "board ID");
    const value = boardV1Schema.parse(board.value);
    if (value.boardId !== id) throw new Error(`Board value ID does not match manifest ID ${id}`);
    const path = `boards/${id}.json`;
    assertUniquePath(seenPaths, path);
    return { id, path, value };
  });
  const assetEntries = [] as Array<CocmodManifestV1["assets"][number] & { bytes: Uint8Array; extension: string }>;
  for (const asset of assets) {
    const { bytes: assetBytes, extension: assetExtension, ...candidateDescriptor } = asset;
    const descriptor = assetDescriptorV1Schema.parse(candidateDescriptor);
    const hash = parseAssetHash(descriptor.assetId);
    const extension = normalizeExtension(assetExtension);
    const path = `assets/sha256/${hash.slice(0, 2)}/${hash}.${extension}`;
    assertUniquePath(seenPaths, path);
    assertAssetSize(descriptor.mediaType, assetBytes.byteLength);
    if (assetBytes.byteLength !== descriptor.byteLength) throw new Error(`Asset ${descriptor.assetId} length does not match its descriptor`);
    const actualHash = await sha256Hex(assetBytes);
    if (actualHash !== hash) throw new Error(`Asset ${descriptor.assetId} failed SHA-256 verification`);
    assertAssetMimeMatchesBytes(descriptor.mediaType, extension, assetBytes);
    assetEntries.push({
      ...descriptor,
      path,
      bytes: assetBytes,
      extension,
    });
  }

  const manifest: CocmodManifestV1 = {
    format: "coc-room-module",
    formatVersion: 1,
    modulePath: MODULE_PATH,
    moduleSchemaVersion: modulePackage.schemaVersion,
    boards: boardEntries.map(({ id, path }) => ({ id, path })),
    assets: assetEntries.map(({ schemaVersion, assetId, mediaType, byteLength, width, height, durationMs, path }) => ({
      schemaVersion,
      assetId,
      mediaType,
      byteLength,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(durationMs === undefined ? {} : { durationMs }),
      path,
    })),
  };

  const files: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: encodeJson(manifest),
    [MODULE_PATH]: encodeJson(modulePackage),
    "boards/": new Uint8Array(),
    "assets/sha256/": new Uint8Array(),
  };
  for (const board of boardEntries) files[board.path] = encodeJson(board.value);
  for (const asset of assetEntries) files[asset.path] = copyBytes(asset.bytes);

  const output = zipSync(files, { level: 6 });
  if (output.byteLength > MAX_PACKAGE_BYTES) throw new Error("The .cocmod package exceeds 512 MiB");
  return output;
}

/** Parses a package only after inspecting its central directory and limits. */
export async function parseCocmodPackage(bytes: Uint8Array): Promise<ImportedCocmodPackage> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PACKAGE_BYTES) {
    throw new Error("The .cocmod package must be between 1 byte and 512 MiB");
  }
  const inspected = inspectZipCentralDirectory(bytes);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw new Error("Invalid or unsupported .cocmod ZIP data", { cause: error });
  }
  if (Object.keys(files).length !== inspected.size) throw new Error("ZIP entry directory is inconsistent");
  for (const [path, metadata] of inspected) {
    const file = files[path];
    if (file === undefined || file.byteLength !== metadata.expandedBytes) {
      throw new Error(`ZIP entry size mismatch for ${path}`);
    }
  }

  const manifest = parseManifest(requireFile(files, MANIFEST_PATH));
  const modulePackage = modulePackageSchema.parse(parseJsonFile(requireFile(files, MODULE_PATH), MODULE_PATH));
  if (manifest.moduleSchemaVersion !== modulePackage.schemaVersion) {
    throw new Error("Manifest and module schema versions do not match");
  }

  const expectedPaths = new Set([MANIFEST_PATH, MODULE_PATH, "boards/", "assets/sha256/"]);
  const boards = manifest.boards.map((entry) => {
    const id = safePortableId(entry.id, "board ID");
    if (entry.path !== `boards/${id}.json`) throw new Error(`Board path does not match ID ${id}`);
    assertUniquePath(expectedPaths, entry.path);
    const value = boardV1Schema.parse(parseJsonFile(requireFile(files, entry.path), entry.path));
    if (value.boardId !== id) throw new Error(`Board value ID does not match manifest ID ${id}`);
    return { id, value };
  });

  const assets: CocmodAssetInput[] = [];
  for (const entry of manifest.assets) {
    const hash = parseAssetHash(entry.assetId);
    if (!entry.path.startsWith(`assets/sha256/${hash.slice(0, 2)}/${hash}.`)) {
      throw new Error(`Asset path does not match hash ${entry.assetId}`);
    }
    assertUniquePath(expectedPaths, entry.path);
    const assetBytes = requireFile(files, entry.path);
    if (assetBytes.byteLength !== entry.byteLength) throw new Error(`Asset length mismatch for ${entry.assetId}`);
    assertAssetSize(entry.mediaType, assetBytes.byteLength);
    if (await sha256Hex(assetBytes) !== hash) throw new Error(`Asset hash mismatch for ${entry.assetId}`);
    const extension = entry.path.slice(entry.path.lastIndexOf(".") + 1).toLowerCase();
    assertAssetMimeMatchesBytes(entry.mediaType, extension, assetBytes);
    const { path: _path, ...descriptor } = entry;
    assets.push({
      ...assetDescriptorV1Schema.parse({ ...descriptor, assetId: `sha256:${hash}` }),
      bytes: assetBytes,
      extension,
    });
  }

  for (const path of inspected.keys()) {
    if (!expectedPaths.has(path)) throw new Error(`Unexpected package entry: ${path}`);
  }
  return { module: modulePackage, boards, assets };
}

export function withStoredCocmodContents(
  candidate: ModulePackageV1,
  contents: StoredCocmodContentsV1,
): ModulePackageV1 {
  const modulePackage = modulePackageSchema.parse(candidate);
  const boards = contents.boards.map(({ id, value }) => {
    const board = boardV1Schema.parse(value);
    if (safePortableId(id, "board ID") !== board.boardId) throw new Error(`Board value ID does not match ${id}`);
    return { id, value: board };
  });
  const assets = contents.assets.map((asset) => {
    const { extension, ...candidateDescriptor } = asset;
    return {
      ...assetDescriptorV1Schema.parse(candidateDescriptor),
      extension: normalizeExtension(extension),
    };
  });
  return modulePackageSchema.parse({
    ...modulePackage,
    extensions: {
      ...modulePackage.extensions,
      [COCMOD_CONTENTS_EXTENSION]: { boards, assets },
    },
  });
}

export function storedCocmodContents(candidate: ModulePackageV1): StoredCocmodContentsV1 {
  const modulePackage = modulePackageSchema.parse(candidate);
  const value = modulePackage.extensions[COCMOD_CONTENTS_EXTENSION];
  if (value === undefined) return { boards: [], assets: [] };
  if (typeof value !== "object" || value === null) throw new Error("Stored .cocmod contents are malformed");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.boards) || !Array.isArray(record.assets)) throw new Error("Stored .cocmod contents are malformed");
  const boards = record.boards.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error("Stored .cocmod board is malformed");
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string") throw new Error("Stored .cocmod board ID is malformed");
    const board = boardV1Schema.parse(item.value);
    if (safePortableId(item.id, "board ID") !== board.boardId) throw new Error(`Board value ID does not match ${item.id}`);
    return { id: item.id, value: board };
  });
  const assets = record.assets.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error("Stored .cocmod asset is malformed");
    const item = entry as Record<string, unknown>;
    if (typeof item.extension !== "string") throw new Error("Stored .cocmod asset extension is malformed");
    const { extension, ...candidateDescriptor } = item;
    return {
      ...assetDescriptorV1Schema.parse(candidateDescriptor),
      extension: normalizeExtension(String(extension)),
    };
  });
  return { boards, assets };
}

/** Legacy JSON remains import-only. */
export function parseLegacyCocmodJson(content: string): ModulePackageV1 {
  if (new TextEncoder().encode(content).byteLength > 16 * 1024 * 1024) {
    throw new Error("Legacy .cocmod.json exceeds 16 MiB");
  }
  return modulePackageSchema.parse(JSON.parse(content));
}

function inspectZipCentralDirectory(bytes: Uint8Array): Map<string, { expandedBytes: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEocd = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumEocd; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("Invalid ZIP: end-of-directory record not found");
  const diskNumber = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const diskEntryCount = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const directoryBytes = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (eocd + 22 + commentLength !== bytes.byteLength) throw new Error("Invalid trailing ZIP data");
  if (diskNumber !== 0 || directoryDisk !== 0 || diskEntryCount !== entryCount) {
    throw new Error("Multi-disk ZIP packages are not supported");
  }
  if (entryCount === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error("ZIP64 packages are not supported");
  }
  if (entryCount === 0 || entryCount > MAX_PACKAGE_ENTRIES) throw new Error("ZIP entry count is outside allowed limits");
  if (directoryOffset + directoryBytes !== eocd) throw new Error("ZIP central directory is outside the package");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths = new Map<string, { expandedBytes: number }>();
  const caseFoldedPaths = new Set<string>();
  let offset = directoryOffset;
  let expandedBytes = 0;
  let compressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory entry");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const expanded = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    if ((flags & 0x0001) !== 0) throw new Error("Encrypted ZIP entries are not supported");
    if (method !== 0 && method !== 8) throw new Error("Unsupported ZIP compression method");
    if (diskStart !== 0) throw new Error("Multi-disk ZIP entries are not supported");
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) throw new Error("Symbolic links are not allowed in .cocmod packages");
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const nextOffset = nameEnd + extraLength + commentLength;
    if (nameEnd > eocd || nextOffset > eocd) throw new Error("ZIP entry exceeds the central directory");
    const path = decoder.decode(bytes.subarray(nameStart, nameEnd));
    assertSafeArchivePath(path);
    const caseFoldedPath = path.toLocaleLowerCase("en-US");
    if (paths.has(path) || caseFoldedPaths.has(caseFoldedPath)) {
      throw new Error(`Duplicate package path: ${path}`);
    }
    paths.set(path, { expandedBytes: expanded });
    caseFoldedPaths.add(caseFoldedPath);
    expandedBytes += expanded;
    compressedBytes += compressed;
    if (expandedBytes > MAX_PACKAGE_BYTES) throw new Error("Expanded .cocmod content exceeds 512 MiB");
    if (expanded > 10 * 1024 * 1024 && expanded / Math.max(1, compressed) > MAX_COMPRESSION_RATIO) {
      throw new Error(`Suspicious compression ratio for ${path}`);
    }
    offset = nextOffset;
  }
  if (offset !== directoryOffset + directoryBytes) throw new Error("ZIP central directory size mismatch");
  if (expandedBytes > 10 * 1024 * 1024 && expandedBytes / Math.max(1, compressedBytes) > MAX_COMPRESSION_RATIO) {
    throw new Error("The .cocmod package has a suspicious total compression ratio");
  }
  return paths;
}

function assertAssetMimeMatchesBytes(mediaType: string, extension: string, bytes: Uint8Array): void {
  const normalizedMediaType = mediaType.trim().toLowerCase();
  const matches = (() => {
    switch (normalizedMediaType) {
      case "image/webp":
        return extension === "webp" && bytes.byteLength >= 12 &&
          asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP") &&
          !containsAscii(bytes, "ANIM") && !containsAscii(bytes, "ANMF");
      case "audio/mpeg":
        return extension === "mp3" && (
          asciiAt(bytes, 0, "ID3") ||
          (bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
        );
      case "audio/ogg":
        return (extension === "ogg" || extension === "opus") && asciiAt(bytes, 0, "OggS");
      case "audio/wav":
        return extension === "wav" && bytes.byteLength >= 12 &&
          asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE");
      default:
        return false;
    }
  })();
  if (!matches) throw new Error(`Asset MIME/extension does not match bytes: ${mediaType}`);
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.byteLength) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
  for (let offset = 0; offset <= bytes.byteLength - text.length; offset += 1) {
    if (asciiAt(bytes, offset, text)) return true;
  }
  return false;
}

function parseManifest(bytes: Uint8Array): CocmodManifestV1 {
  const value = parseJsonFile(bytes, MANIFEST_PATH);
  if (typeof value !== "object" || value === null) throw new Error("Invalid .cocmod manifest");
  const record = value as Record<string, unknown>;
  if (
    record.format !== "coc-room-module" || record.formatVersion !== 1 ||
    record.modulePath !== MODULE_PATH || !Number.isInteger(record.moduleSchemaVersion) ||
    !Array.isArray(record.boards) || !Array.isArray(record.assets)
  ) throw new Error("Unsupported or malformed .cocmod manifest");
  for (const board of record.boards) {
    if (!isStringRecord(board, ["id", "path"])) throw new Error("Malformed board manifest entry");
  }
  for (const asset of record.assets) {
    if (
      typeof asset !== "object" || asset === null ||
      typeof (asset as Record<string, unknown>).path !== "string"
    ) throw new Error("Malformed asset manifest entry");
    const candidate = { ...(asset as Record<string, unknown>) };
    delete candidate.path;
    if (!assetDescriptorV1Schema.safeParse(candidate).success) throw new Error("Malformed asset manifest entry");
  }
  return value as unknown as CocmodManifestV1;
}

function requireFile(files: Record<string, Uint8Array>, path: string): Uint8Array {
  const value = files[path];
  if (value === undefined) throw new Error(`Required package entry is missing: ${path}`);
  return value;
}

function parseJsonFile(bytes: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${path} is not valid UTF-8 JSON`, { cause: error });
  }
}

function encodeJson(value: unknown): Uint8Array {
  // jsdom and embedded webviews can expose TextEncoder from a different realm
  // than the one fflate captured at module load. fflate treats a foreign-realm
  // Uint8Array as a nested directory object, producing a corrupt archive.
  return copyBytes(new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function assertSafeArchivePath(path: string): void {
  if (
    path.length === 0 || path.length > 512 || path.includes("\\") || path.includes("\0") ||
    path.startsWith("/") || /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => part === ".." || part === ".")
  ) throw new Error(`Unsafe package path: ${path}`);
}

function assertUniquePath(paths: Set<string>, path: string): void {
  assertSafeArchivePath(path);
  if (paths.has(path)) throw new Error(`Duplicate package path: ${path}`);
  paths.add(path);
}

function parseAssetHash(assetId: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(assetId);
  if (!match?.[1]) throw new Error(`Invalid asset ID: ${assetId}`);
  return match[1];
}

function normalizeExtension(extension: string): string {
  const value = extension.trim().toLowerCase().replace(/^\./, "");
  if (!/^[a-z0-9]{1,8}$/.test(value)) throw new Error("Asset extension is invalid");
  return value;
}

function assertAssetSize(mediaType: string, byteLength: number): void {
  const normalized = mediaType.trim().toLowerCase();
  if (normalized === "image/webp" && byteLength > 8 * 1024 * 1024) {
    throw new Error("Image asset exceeds 8 MiB");
  }
  if (normalized.startsWith("audio/") && byteLength > 64 * 1024 * 1024) {
    throw new Error("Audio asset exceeds 64 MiB");
  }
  if (byteLength <= 0 || byteLength > MAX_PACKAGE_BYTES) throw new Error("Asset size is outside package limits");
}

function safePortableId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`${label} is not portable`);
  return value;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isStringRecord(value: unknown, keys: readonly string[]): boolean {
  return typeof value === "object" && value !== null && keys.every(
    (key) => typeof (value as Record<string, unknown>)[key] === "string",
  );
}
