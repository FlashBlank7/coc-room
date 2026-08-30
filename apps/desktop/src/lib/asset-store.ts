import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ASSET_CHUNK_BYTES, assetDescriptorV1Schema, type AssetDescriptorV1 } from "@coc-room/protocol";
import {
  clearWebDevelopmentAssetDatabase,
  isWebDevelopmentAssetStoreAvailable,
  WebDevelopmentAssetStore,
} from "./web-development-asset-store";

export interface ImportedAssetV1 {
  asset: AssetDescriptorV1;
  deduplicated: boolean;
}

interface AssetChunkRead {
  assetId: string;
  offset: number;
  data: number[];
  eof: boolean;
}

export interface PersistedManagedAssetDownload {
  transferId: string;
  sourcePeerId: string;
  asset: AssetDescriptorV1;
  chunks: readonly { chunkIndex: number; bytes: Uint8Array }[];
}

let webDevelopmentStore: WebDevelopmentAssetStore | undefined;

export type ManagedAssetStoreKind = "native" | "web-development" | "unavailable";

export function managedAssetStoreKind(): ManagedAssetStoreKind {
  if (isTauriRuntime()) return "native";
  if (isWebDevelopmentAssetStoreAvailable()) return "web-development";
  return "unavailable";
}

export function hasManagedAssetStore(): boolean {
  return managedAssetStoreKind() !== "unavailable";
}

/** Browser-development reset hook. It is a no-op inside Tauri. */
export async function clearWebDevelopmentAssetData(): Promise<void> {
  if (isTauriRuntime()) return;
  webDevelopmentStore?.dispose();
  webDevelopmentStore = undefined;
  await clearWebDevelopmentAssetDatabase();
}

export async function selectAndImportAsset(kind: "image" | "audio"): Promise<ImportedAssetV1 | undefined> {
  requireManagedAssetStore();
  if (!isTauriRuntime()) return webStore().selectAndImport(kind);
  const result = await invoke<unknown>("select_and_import_asset", { kind });
  if (result === null) return undefined;
  return parseImportResult(result);
}

export async function importManagedAssetBytes(
  kind: "image" | "audio",
  bytes: Uint8Array,
  declaredMediaType?: string,
): Promise<ImportedAssetV1> {
  requireManagedAssetStore();
  if (!isTauriRuntime()) return webStore().importBytes(kind, bytes, declaredMediaType);
  const result = await invoke<unknown>("import_asset_bytes", {
    kind,
    bytes: Array.from(bytes),
    declaredMediaType,
  });
  return parseImportResult(result);
}

/**
 * Persists bytes received over the authenticated room asset channel without
 * changing them. Rust independently rechecks length, MIME and SHA-256 before
 * the atomic content-addressed import, so the event descriptor stays valid.
 */
export async function importReceivedManagedAsset(
  asset: AssetDescriptorV1,
  chunks: readonly Uint8Array[],
): Promise<ImportedAssetV1> {
  requireManagedAssetStore();
  const descriptor = assetDescriptorV1Schema.parse(asset);
  if (!isTauriRuntime()) return webStore().importReceived(descriptor, chunks);
  const bytes = new Uint8Array(descriptor.byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset + chunk.byteLength > bytes.byteLength) throw new Error("接收资源分块超过描述符长度");
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== bytes.byteLength) throw new Error("接收资源分块没有覆盖完整描述符长度");
  const result = await invoke<unknown>("import_received_asset", {
    asset: descriptor,
    bytes: Array.from(bytes),
  });
  const imported = parseImportResult(result);
  if (!isSameAssetDescriptor(imported.asset, descriptor)) {
    throw new Error("接收资源入库后描述符发生变化");
  }
  return imported;
}

export async function resolveManagedAssetUrl(assetId: string): Promise<string> {
  requireManagedAssetStore();
  if (!isTauriRuntime()) return webStore().resolveUrl(assetId);
  const path = await invoke<string>("resolve_asset_path", { assetId });
  return convertFileSrc(path);
}

/** Re-hashes the managed file and returns its canonical native metadata. */
export async function verifyManagedAsset(assetId: string): Promise<AssetDescriptorV1> {
  requireManagedAssetStore();
  if (!isTauriRuntime()) return webStore().verify(assetId);
  const result = await invoke<unknown>("verify_managed_asset", { assetId });
  return assetDescriptorV1Schema.parse(result);
}

export function isSameAssetDescriptor(
  left: AssetDescriptorV1,
  right: AssetDescriptorV1,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.assetId === right.assetId
    && left.mediaType === right.mediaType
    && left.byteLength === right.byteLength
    && left.width === right.width
    && left.height === right.height
    && left.durationMs === right.durationMs;
}

export async function addManagedAssetReference(input: {
  assetId: string;
  ownerType: "module" | "room" | "board" | "artifact" | "character";
  ownerId: string;
  ownerRevision: number;
  slot: string;
}): Promise<void> {
  requireManagedAssetStore();
  if (!isTauriRuntime()) return webStore().addReference(input);
  await invoke("add_asset_reference", input);
}

export async function readManagedAssetChunk(
  assetId: string,
  offset: number,
  length: number,
): Promise<{ bytes: Uint8Array; eof: boolean }> {
  requireManagedAssetStore();
  if (!isTauriRuntime()) return webStore().readChunk(assetId, offset, length);
  const result = await invoke<AssetChunkRead>("read_asset_chunk", { assetId, offset, length });
  if (result.assetId !== assetId || result.offset !== offset || result.data.length > length) {
    throw new Error("本地资源库返回了不一致的分块");
  }
  return { bytes: Uint8Array.from(result.data), eof: result.eof };
}

export async function persistManagedAssetDownloadChunk(input: {
  roomId: string;
  sourcePeerId: string;
  transferId: string;
  asset: AssetDescriptorV1;
  chunkIndex: number;
  chunkCount: number;
  bytes: Uint8Array;
}): Promise<void> {
  requireManagedAssetStore();
  const asset = assetDescriptorV1Schema.parse(input.asset);
  if (!isTauriRuntime()) return webStore().persistDownloadChunk({ ...input, asset });
  await invoke("persist_asset_download_chunk", {
    roomId: input.roomId,
    sourcePeerId: input.sourcePeerId,
    transferId: input.transferId,
    asset,
    chunkIndex: input.chunkIndex,
    chunkCount: input.chunkCount,
    bytes: Array.from(input.bytes),
  });
}

export async function loadManagedAssetDownload(
  roomId: string,
  sourcePeerId: string,
  candidate: AssetDescriptorV1,
): Promise<PersistedManagedAssetDownload | undefined> {
  requireManagedAssetStore();
  const asset = assetDescriptorV1Schema.parse(candidate);
  if (!isTauriRuntime()) return webStore().loadDownload(roomId, sourcePeerId, asset);
  const result = await invoke<unknown>("load_asset_download", { roomId, sourcePeerId, asset });
  if (result === null) return undefined;
  if (typeof result !== "object" || result === null) throw new Error("Persisted asset download is invalid");
  const record = result as Record<string, unknown>;
  if (typeof record.transferId !== "string" || typeof record.sourcePeerId !== "string" || !Array.isArray(record.chunks)) {
    throw new Error("Persisted asset download metadata is invalid");
  }
  const restoredAsset = assetDescriptorV1Schema.parse(record.asset);
  if (record.sourcePeerId !== sourcePeerId || !isSameAssetDescriptor(restoredAsset, asset)) {
    throw new Error("Persisted asset download does not match its authenticated source and descriptor");
  }
  const chunkCount = Math.ceil(asset.byteLength / ASSET_CHUNK_BYTES);
  const seen = new Set<number>();
  const chunks = record.chunks.map((candidateChunk) => {
    if (typeof candidateChunk !== "object" || candidateChunk === null) throw new Error("Persisted asset chunk is invalid");
    const chunk = candidateChunk as Record<string, unknown>;
    if (!Number.isInteger(chunk.chunkIndex) || Number(chunk.chunkIndex) < 0 || Number(chunk.chunkIndex) >= chunkCount) {
      throw new Error("Persisted asset chunk index is invalid");
    }
    const chunkIndex = Number(chunk.chunkIndex);
    if (
      seen.has(chunkIndex) || !Array.isArray(chunk.bytes) ||
      !chunk.bytes.every((value) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255)
    ) throw new Error("Persisted asset chunks are invalid");
    seen.add(chunkIndex);
    const bytes = Uint8Array.from(chunk.bytes as number[]);
    const expected = Math.min(ASSET_CHUNK_BYTES, asset.byteLength - chunkIndex * ASSET_CHUNK_BYTES);
    if (bytes.byteLength !== expected) throw new Error("Persisted asset chunk length is invalid");
    return { chunkIndex, bytes };
  }).sort((left, right) => left.chunkIndex - right.chunkIndex);
  return { transferId: record.transferId, sourcePeerId, asset: restoredAsset, chunks };
}

export async function discardManagedAssetDownload(
  roomId: string,
  assetId: string,
  transferId: string,
): Promise<void> {
  requireManagedAssetStore();
  if (!isTauriRuntime()) return webStore().discardDownload(roomId, assetId, transferId);
  await invoke("discard_asset_download", { roomId, assetId, transferId });
}

function parseImportResult(candidate: unknown): ImportedAssetV1 {
  if (typeof candidate !== "object" || candidate === null) throw new Error("本地资源库返回格式无效");
  const value = candidate as Record<string, unknown>;
  if (typeof value.deduplicated !== "boolean") throw new Error("本地资源库缺少去重状态");
  return {
    asset: assetDescriptorV1Schema.parse(value.asset),
    deduplicated: value.deduplicated,
  };
}

function requireManagedAssetStore(): void {
  if (!hasManagedAssetStore()) throw new Error("当前环境没有可用的托管资源库或浏览器开发资源库");
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

function webStore(): WebDevelopmentAssetStore {
  if (!isWebDevelopmentAssetStoreAvailable()) throw new Error("浏览器开发资源库不可用");
  webDevelopmentStore ??= new WebDevelopmentAssetStore();
  return webDevelopmentStore;
}
