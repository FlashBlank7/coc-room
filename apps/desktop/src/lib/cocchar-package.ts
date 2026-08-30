import {
  assetDescriptorV1Schema,
  coc7CharacterSchema,
  type AssetDescriptorV1,
  type Coc7Character,
} from "@coc-room/protocol";
import { unzipSync, zipSync } from "fflate";

const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 8;
const MAX_COMPRESSION_RATIO = 200;
const MAX_PRIVATE_NOTES_LENGTH = 100_000;
const MANIFEST_PATH = "manifest.json";
const CHARACTER_PATH = "character.json";

export type CoccharAvatarMediaType = "image/webp" | "image/png" | "image/jpeg";

export interface CoccharAvatarInput {
  readonly descriptor: AssetDescriptorV1;
  readonly bytes: Uint8Array;
}

/**
 * The local-only portion is intentionally outside `character`. A caller may
 * publish `character` as a RoomEvent payload, but must never publish
 * `localOnly`.
 */
export interface CoccharCharacterDocumentV1 {
  readonly format: "coc-room-character-data";
  readonly formatVersion: 1;
  readonly character: Coc7Character;
  readonly localOnly: {
    readonly privateNotes: string;
  };
}

export interface CoccharManifestV1 {
  readonly format: "coc-room-character";
  readonly formatVersion: 1;
  readonly characterPath: typeof CHARACTER_PATH;
  readonly characterSchemaVersion: 1;
  readonly avatar?: {
    readonly descriptor: AssetDescriptorV1;
    readonly path: string;
  };
}

export interface CoccharExportInput {
  /** Public/syncable character payload. */
  readonly character: Coc7Character;
  /** Personal notes exported only in this local character package. */
  readonly privateNotes?: string;
  readonly avatar?: CoccharAvatarInput;
}

export interface ImportedCoccharPackage {
  /** Safe to copy into a RoomEvent character payload. */
  readonly character: Coc7Character;
  /** Local-only data; never copy this into a RoomEvent. */
  readonly privateNotes: string;
  readonly avatar?: CoccharAvatarInput;
}

/** Creates a portable, content-addressed `.cocchar` ZIP package. */
export async function createCoccharPackage(input: CoccharExportInput): Promise<Uint8Array> {
  const character = coc7CharacterSchema.parse(input.character);
  const privateNotes = parsePrivateNotes(input.privateNotes ?? "");
  const avatar = input.avatar === undefined ? undefined : await validateAvatar(input.avatar);

  const avatarManifest = avatar === undefined
    ? undefined
    : {
        descriptor: avatar.descriptor,
        path: avatarPath(avatar.descriptor),
      };
  const manifest: CoccharManifestV1 = {
    format: "coc-room-character",
    formatVersion: 1,
    characterPath: CHARACTER_PATH,
    characterSchemaVersion: 1,
    ...(avatarManifest === undefined ? {} : { avatar: avatarManifest }),
  };
  const characterDocument: CoccharCharacterDocumentV1 = {
    format: "coc-room-character-data",
    formatVersion: 1,
    character,
    localOnly: { privateNotes },
  };

  const files: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: encodeJson(manifest),
    [CHARACTER_PATH]: encodeJson(characterDocument),
  };
  if (avatar !== undefined && avatarManifest !== undefined) {
    files[avatarManifest.path] = avatar.bytes;
  }

  const output = zipSync(files, { level: 6 });
  if (output.byteLength > MAX_PACKAGE_BYTES) {
    throw new Error("The .cocchar package exceeds 32 MiB");
  }
  return output;
}

/** Parses a `.cocchar` only after a central-directory security preflight. */
export async function parseCoccharPackage(bytes: Uint8Array): Promise<ImportedCoccharPackage> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PACKAGE_BYTES) {
    throw new Error("The .cocchar package must be between 1 byte and 32 MiB");
  }

  const inspected = inspectZipCentralDirectory(bytes);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw new Error("Invalid or unsupported .cocchar ZIP data", { cause: error });
  }
  if (Object.keys(files).length !== inspected.size) {
    throw new Error("ZIP entry directory is inconsistent");
  }
  for (const [path, metadata] of inspected) {
    const file = files[path];
    if (file === undefined || file.byteLength !== metadata.expandedBytes) {
      throw new Error(`ZIP entry size mismatch for ${path}`);
    }
  }

  const manifest = parseManifest(requireFile(files, MANIFEST_PATH));
  const document = parseCharacterDocument(requireFile(files, CHARACTER_PATH));
  if (manifest.characterSchemaVersion !== document.character.schemaVersion) {
    throw new Error("Manifest and character schema versions do not match");
  }

  const expectedPaths = new Set([MANIFEST_PATH, CHARACTER_PATH]);
  let avatar: CoccharAvatarInput | undefined;
  if (manifest.avatar !== undefined) {
    const descriptor = assetDescriptorV1Schema.parse(manifest.avatar.descriptor);
    const expectedPath = avatarPath(descriptor);
    if (manifest.avatar.path !== expectedPath) {
      throw new Error("Avatar path does not match its content descriptor");
    }
    assertUniquePath(expectedPaths, expectedPath);
    avatar = await validateAvatar({
      descriptor,
      bytes: requireFile(files, expectedPath),
    });
  }

  for (const path of inspected.keys()) {
    if (!expectedPaths.has(path)) throw new Error(`Unexpected package entry: ${path}`);
  }

  return {
    character: document.character,
    privateNotes: document.localOnly.privateNotes,
    ...(avatar === undefined ? {} : { avatar }),
  };
}

function parseManifest(bytes: Uint8Array): CoccharManifestV1 {
  const value = parseJsonFile(bytes, MANIFEST_PATH);
  if (!isRecord(value)) throw new Error("Invalid .cocchar manifest");
  assertExactKeys(value, [
    "format",
    "formatVersion",
    "characterPath",
    "characterSchemaVersion",
    ...(value.avatar === undefined ? [] : ["avatar"]),
  ], "manifest");
  if (
    value.format !== "coc-room-character" ||
    value.formatVersion !== 1 ||
    value.characterPath !== CHARACTER_PATH ||
    value.characterSchemaVersion !== 1
  ) {
    throw new Error("Unsupported or malformed .cocchar manifest");
  }

  let avatar: CoccharManifestV1["avatar"];
  if (value.avatar !== undefined) {
    if (!isRecord(value.avatar)) throw new Error("Malformed avatar manifest entry");
    assertExactKeys(value.avatar, ["descriptor", "path"], "avatar manifest entry");
    if (typeof value.avatar.path !== "string") throw new Error("Malformed avatar manifest path");
    avatar = {
      descriptor: assetDescriptorV1Schema.parse(value.avatar.descriptor),
      path: value.avatar.path,
    };
  }
  return {
    format: "coc-room-character",
    formatVersion: 1,
    characterPath: CHARACTER_PATH,
    characterSchemaVersion: 1,
    ...(avatar === undefined ? {} : { avatar }),
  };
}

function parseCharacterDocument(bytes: Uint8Array): CoccharCharacterDocumentV1 {
  const value = parseJsonFile(bytes, CHARACTER_PATH);
  if (!isRecord(value)) throw new Error("Invalid character document");
  assertExactKeys(value, ["format", "formatVersion", "character", "localOnly"], "character document");
  if (value.format !== "coc-room-character-data" || value.formatVersion !== 1) {
    throw new Error("Unsupported character document version");
  }
  if (!isRecord(value.localOnly)) throw new Error("Invalid local-only character data");
  assertExactKeys(value.localOnly, ["privateNotes"], "local-only character data");
  return {
    format: "coc-room-character-data",
    formatVersion: 1,
    character: coc7CharacterSchema.parse(value.character),
    localOnly: {
      privateNotes: parsePrivateNotes(value.localOnly.privateNotes),
    },
  };
}

async function validateAvatar(candidate: CoccharAvatarInput): Promise<CoccharAvatarInput> {
  const descriptor = assetDescriptorV1Schema.parse(candidate.descriptor);
  const bytes = copyBytes(candidate.bytes);
  if (!isAvatarMediaType(descriptor.mediaType)) {
    throw new Error(`Unsupported avatar MIME type: ${descriptor.mediaType}`);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) {
    throw new Error("Avatar must be between 1 byte and 8 MiB");
  }
  if (descriptor.byteLength !== bytes.byteLength) {
    throw new Error("Avatar byte length does not match its descriptor");
  }
  const expectedHash = parseAssetHash(descriptor.assetId);
  if (await sha256Hex(bytes) !== expectedHash) {
    throw new Error("Avatar SHA-256 hash does not match its descriptor");
  }
  if (!matchesImageMime(bytes, descriptor.mediaType)) {
    throw new Error(`Avatar bytes do not match MIME type ${descriptor.mediaType}`);
  }
  if (isAnimatedImage(bytes, descriptor.mediaType)) {
    throw new Error("Animated avatars are not supported");
  }
  return { descriptor, bytes };
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
  if (entryCount < 2 || entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new Error("ZIP entry count is outside allowed limits");
  }
  if (directoryOffset + directoryBytes !== eocd) {
    throw new Error("ZIP central directory is outside the package");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = new Map<string, { expandedBytes: number }>();
  const caseFoldedPaths = new Set<string>();
  let offset = directoryOffset;
  let totalExpanded = 0;
  let totalCompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory entry");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedBytes = view.getUint32(offset + 20, true);
    const expandedBytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    if ((flags & 0x0001) !== 0) throw new Error("Encrypted ZIP entries are not supported");
    if (method !== 0 && method !== 8) throw new Error("Unsupported ZIP compression method");
    if (diskStart !== 0) throw new Error("Multi-disk ZIP entries are not supported");
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) {
      throw new Error("Symbolic links are not allowed in .cocchar packages");
    }

    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const nextOffset = nameEnd + extraLength + entryCommentLength;
    if (nameEnd > eocd || nextOffset > eocd) {
      throw new Error("ZIP entry exceeds the central directory");
    }
    const path = decoder.decode(bytes.subarray(nameStart, nameEnd));
    assertSafeArchivePath(path);
    if (entries.has(path) || caseFoldedPaths.has(path.toLocaleLowerCase("en-US"))) {
      throw new Error(`Duplicate package path: ${path}`);
    }
    entries.set(path, { expandedBytes });
    caseFoldedPaths.add(path.toLocaleLowerCase("en-US"));

    totalExpanded += expandedBytes;
    totalCompressed += compressedBytes;
    if (expandedBytes > MAX_PACKAGE_BYTES || totalExpanded > MAX_PACKAGE_BYTES) {
      throw new Error("Expanded .cocchar content exceeds 32 MiB");
    }
    if (
      expandedBytes > 1024 * 1024 &&
      expandedBytes / Math.max(1, compressedBytes) > MAX_COMPRESSION_RATIO
    ) {
      throw new Error(`Suspicious compression ratio for ${path}`);
    }
    offset = nextOffset;
  }
  if (offset !== directoryOffset + directoryBytes) throw new Error("ZIP central directory size mismatch");
  if (
    totalExpanded > 1024 * 1024 &&
    totalExpanded / Math.max(1, totalCompressed) > MAX_COMPRESSION_RATIO
  ) {
    throw new Error("The .cocchar package has a suspicious total compression ratio");
  }
  return entries;
}

function avatarPath(descriptor: AssetDescriptorV1): string {
  const hash = parseAssetHash(descriptor.assetId);
  const extension = avatarExtension(descriptor.mediaType);
  return `assets/sha256/${hash.slice(0, 2)}/${hash}.${extension}`;
}

function avatarExtension(mediaType: string): string {
  switch (mediaType) {
    case "image/webp": return "webp";
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    default: throw new Error(`Unsupported avatar MIME type: ${mediaType}`);
  }
}

function isAvatarMediaType(value: string): value is CoccharAvatarMediaType {
  return value === "image/webp" || value === "image/png" || value === "image/jpeg";
}

function matchesImageMime(bytes: Uint8Array, mediaType: CoccharAvatarMediaType): boolean {
  switch (mediaType) {
    case "image/webp":
      return bytes.byteLength >= 12 && asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP");
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
  }
}

function isAnimatedImage(bytes: Uint8Array, mediaType: CoccharAvatarMediaType): boolean {
  if (mediaType === "image/png") return containsAscii(bytes, "acTL");
  if (mediaType === "image/webp") return containsAscii(bytes, "ANIM");
  return false;
}

function startsWith(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
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

function parseAssetHash(assetId: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(assetId);
  if (match?.[1] === undefined) throw new Error(`Invalid asset ID: ${assetId}`);
  return match[1];
}

function parsePrivateNotes(value: unknown): string {
  if (typeof value !== "string") throw new Error("Private character notes must be text");
  if (value.length > MAX_PRIVATE_NOTES_LENGTH) {
    throw new Error("Private character notes exceed 100,000 characters");
  }
  return value;
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
  // Keep the bytes in fflate's current realm. Some webview/jsdom combinations
  // expose TextEncoder from another realm and fflate otherwise mistakes the
  // result for a nested directory tree.
  return copyBytes(new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));
}

function assertSafeArchivePath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 512 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe package path: ${path}`);
  }
}

function assertUniquePath(paths: Set<string>, path: string): void {
  assertSafeArchivePath(path);
  const folded = path.toLocaleLowerCase("en-US");
  if ([...paths].some((candidate) => candidate.toLocaleLowerCase("en-US") === folded)) {
    throw new Error(`Duplicate package path: ${path}`);
  }
  paths.add(path);
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const expectedSet = new Set(expected);
  if (Object.keys(record).some((key) => !expectedSet.has(key)) || expected.some((key) => !(key in record))) {
    throw new Error(`Malformed ${label}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
