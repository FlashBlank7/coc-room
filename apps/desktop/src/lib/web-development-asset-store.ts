import { ASSET_CHUNK_BYTES, assetDescriptorV1Schema, type AssetDescriptorV1 } from "@coc-room/protocol";

const DATABASE_NAME = "coc-room-web-development-assets-v1";
const DATABASE_VERSION = 1;
const MAX_IMAGE_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_EDGE = 8_192;
const MAX_IMAGE_PIXELS = 32_000_000;
const activeDatabases = new Set<IDBDatabase>();

interface StoredAssetRecord {
  assetId: string;
  descriptor: AssetDescriptorV1;
  bytes: ArrayBuffer;
}

interface StoredReferenceRecord {
  key: string;
  assetId: string;
  ownerType: "module" | "room" | "board" | "artifact" | "character";
  ownerId: string;
  ownerRevision: number;
  slot: string;
  createdAt: string;
}

interface StoredDownloadRecord {
  key: string;
  roomId: string;
  sourcePeerId: string;
  transferId: string;
  asset: AssetDescriptorV1;
  chunkCount: number;
}

interface StoredDownloadChunkRecord {
  key: string;
  downloadKey: string;
  transferId: string;
  chunkIndex: number;
  bytes: ArrayBuffer;
}

export interface WebDevelopmentAssetBackend {
  getAsset(assetId: string): Promise<StoredAssetRecord | undefined>;
  putAsset(record: StoredAssetRecord): Promise<void>;
  putReference(record: StoredReferenceRecord): Promise<void>;
  getDownload(key: string): Promise<StoredDownloadRecord | undefined>;
  putDownload(record: StoredDownloadRecord): Promise<void>;
  putDownloadChunk(record: StoredDownloadChunkRecord): Promise<void>;
  listDownloadChunks(downloadKey: string, transferId: string): Promise<StoredDownloadChunkRecord[]>;
  deleteDownload(downloadKey: string, transferId?: string): Promise<void>;
}

export interface WebDevelopmentImportedAsset {
  asset: AssetDescriptorV1;
  deduplicated: boolean;
}

export interface WebDevelopmentPersistedDownload {
  transferId: string;
  sourcePeerId: string;
  asset: AssetDescriptorV1;
  chunks: readonly { chunkIndex: number; bytes: Uint8Array }[];
}

/**
 * Browser-only development adapter. It intentionally uses its own IndexedDB
 * database: it is not the desktop content-addressed store and must never be
 * treated as Windows Credential Manager or native atomic file persistence.
 */
export class WebDevelopmentAssetStore {
  private readonly objectUrls = new Map<string, string>();

  constructor(private readonly backend: WebDevelopmentAssetBackend = new IndexedDbAssetBackend()) {}

  async selectAndImport(kind: "image" | "audio"): Promise<WebDevelopmentImportedAsset | undefined> {
    const file = await selectBrowserFile(kind);
    if (!file) return undefined;
    return this.importBytes(kind, new Uint8Array(await file.arrayBuffer()), file.type || undefined);
  }

  async importBytes(
    kind: "image" | "audio",
    bytes: Uint8Array,
    declaredMediaType?: string,
  ): Promise<WebDevelopmentImportedAsset> {
    if (kind === "image") {
      const prepared = await normalizeStaticImage(bytes, declaredMediaType);
      return this.storePrepared(prepared.bytes, prepared.mediaType, prepared.width, prepared.height);
    }
    const prepared = prepareAudio(bytes, declaredMediaType);
    return this.storePrepared(prepared.bytes, prepared.mediaType);
  }

  async importReceived(
    candidate: AssetDescriptorV1,
    chunks: readonly Uint8Array[],
  ): Promise<WebDevelopmentImportedAsset> {
    const asset = assetDescriptorV1Schema.parse(candidate);
    const bytes = joinChunks(chunks, asset.byteLength);
    await verifyReceivedBytes(asset, bytes);
    const existing = await this.backend.getAsset(asset.assetId);
    if (existing) {
      if (!sameDescriptor(existing.descriptor, asset)) throw new Error("浏览器资源 ID 已存在但描述符不一致");
      return { asset, deduplicated: true };
    }
    await this.backend.putAsset({ assetId: asset.assetId, descriptor: asset, bytes: copyBuffer(bytes) });
    return { asset, deduplicated: false };
  }

  async resolveUrl(assetId: string): Promise<string> {
    const cached = this.objectUrls.get(assetId);
    if (cached) return cached;
    const stored = await this.requireAsset(assetId);
    const url = URL.createObjectURL(new Blob([stored.bytes], { type: stored.descriptor.mediaType }));
    this.objectUrls.set(assetId, url);
    return url;
  }

  async verify(assetId: string): Promise<AssetDescriptorV1> {
    const stored = await this.requireAsset(assetId);
    if (`sha256:${await sha256Hex(new Uint8Array(stored.bytes))}` !== assetId) {
      throw new Error("浏览器开发资源未通过 SHA-256 校验");
    }
    return assetDescriptorV1Schema.parse(stored.descriptor);
  }

  async addReference(input: Omit<StoredReferenceRecord, "key" | "createdAt">): Promise<void> {
    await this.requireAsset(input.assetId);
    const key = [input.ownerType, input.ownerId, input.ownerRevision, input.slot, input.assetId].join("\0");
    await this.backend.putReference({ ...input, key, createdAt: new Date().toISOString() });
  }

  async readChunk(assetId: string, offset: number, length: number): Promise<{ bytes: Uint8Array; eof: boolean }> {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > ASSET_CHUNK_BYTES) {
      throw new Error("浏览器资源分块范围无效");
    }
    const stored = await this.requireAsset(assetId);
    const all = new Uint8Array(stored.bytes);
    if (offset > all.byteLength) throw new Error("浏览器资源分块偏移超出文件长度");
    const end = Math.min(all.byteLength, offset + length);
    return { bytes: all.slice(offset, end), eof: end === all.byteLength };
  }

  async persistDownloadChunk(input: {
    roomId: string;
    sourcePeerId: string;
    transferId: string;
    asset: AssetDescriptorV1;
    chunkIndex: number;
    chunkCount: number;
    bytes: Uint8Array;
  }): Promise<void> {
    const asset = assetDescriptorV1Schema.parse(input.asset);
    const expectedCount = Math.ceil(asset.byteLength / ASSET_CHUNK_BYTES);
    const expectedLength = Math.min(ASSET_CHUNK_BYTES, asset.byteLength - input.chunkIndex * ASSET_CHUNK_BYTES);
    if (
      input.chunkCount !== expectedCount
      || !Number.isInteger(input.chunkIndex)
      || input.chunkIndex < 0
      || input.chunkIndex >= expectedCount
      || input.bytes.byteLength !== expectedLength
    ) throw new Error("浏览器资源续传分块元数据无效");

    const key = downloadKey(input.roomId, asset.assetId);
    const existing = await this.backend.getDownload(key);
    if (existing && (
      existing.transferId !== input.transferId
      || existing.sourcePeerId !== input.sourcePeerId
      || !sameDescriptor(existing.asset, asset)
    )) await this.backend.deleteDownload(key);

    await this.backend.putDownload({
      key,
      roomId: input.roomId,
      sourcePeerId: input.sourcePeerId,
      transferId: input.transferId,
      asset,
      chunkCount: input.chunkCount,
    });
    await this.backend.putDownloadChunk({
      key: `${key}\0${input.transferId}\0${input.chunkIndex}`,
      downloadKey: key,
      transferId: input.transferId,
      chunkIndex: input.chunkIndex,
      bytes: copyBuffer(input.bytes),
    });
  }

  async loadDownload(
    roomId: string,
    sourcePeerId: string,
    candidate: AssetDescriptorV1,
  ): Promise<WebDevelopmentPersistedDownload | undefined> {
    const asset = assetDescriptorV1Schema.parse(candidate);
    const key = downloadKey(roomId, asset.assetId);
    const stored = await this.backend.getDownload(key);
    if (!stored) return undefined;
    if (stored.sourcePeerId !== sourcePeerId || !sameDescriptor(stored.asset, asset)) {
      throw new Error("浏览器续传记录与已认证来源或描述符不一致");
    }
    const records = await this.backend.listDownloadChunks(key, stored.transferId);
    const seen = new Set<number>();
    const chunks = records.map((record) => {
      if (seen.has(record.chunkIndex)) throw new Error("浏览器续传记录包含重复分块");
      seen.add(record.chunkIndex);
      const bytes = new Uint8Array(record.bytes);
      const expected = Math.min(ASSET_CHUNK_BYTES, asset.byteLength - record.chunkIndex * ASSET_CHUNK_BYTES);
      if (record.chunkIndex < 0 || record.chunkIndex >= stored.chunkCount || bytes.byteLength !== expected) {
        throw new Error("浏览器续传记录包含无效分块");
      }
      return { chunkIndex: record.chunkIndex, bytes };
    }).sort((left, right) => left.chunkIndex - right.chunkIndex);
    return { transferId: stored.transferId, sourcePeerId, asset, chunks };
  }

  async discardDownload(roomId: string, assetId: string, transferId: string): Promise<void> {
    const key = downloadKey(roomId, assetId);
    const stored = await this.backend.getDownload(key);
    if (!stored || stored.transferId !== transferId) return;
    await this.backend.deleteDownload(key, transferId);
  }

  dispose(): void {
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
  }

  private async storePrepared(
    bytes: Uint8Array,
    mediaType: string,
    width?: number,
    height?: number,
  ): Promise<WebDevelopmentImportedAsset> {
    const hash = await sha256Hex(bytes);
    const asset = assetDescriptorV1Schema.parse({
      schemaVersion: 1,
      assetId: `sha256:${hash}`,
      mediaType,
      byteLength: bytes.byteLength,
      ...(width === undefined ? {} : { width, height }),
    });
    const existing = await this.backend.getAsset(asset.assetId);
    if (existing) {
      if (!sameDescriptor(existing.descriptor, asset)) throw new Error("浏览器资源 ID 已存在但描述符不一致");
      return { asset, deduplicated: true };
    }
    await this.backend.putAsset({ assetId: asset.assetId, descriptor: asset, bytes: copyBuffer(bytes) });
    return { asset, deduplicated: false };
  }

  private async requireAsset(assetId: string): Promise<StoredAssetRecord> {
    const stored = await this.backend.getAsset(assetId);
    if (!stored) throw new Error(`浏览器开发资源不存在：${assetId}`);
    return stored;
  }
}

export function isWebDevelopmentAssetStoreAvailable(): boolean {
  return typeof window !== "undefined"
    && window.__TAURI_INTERNALS__ === undefined
    && typeof indexedDB !== "undefined"
    && typeof crypto?.subtle !== "undefined"
    && typeof URL.createObjectURL === "function";
}

/** Deletes only the browser-development asset database; never touches Tauri files. */
export async function clearWebDevelopmentAssetDatabase(): Promise<void> {
  if (typeof window === "undefined" || window.__TAURI_INTERNALS__ !== undefined || typeof indexedDB === "undefined") return;
  for (const database of activeDatabases) database.close();
  activeDatabases.clear();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("无法清除浏览器开发资源库"));
    request.onblocked = () => reject(new Error("浏览器开发资源库仍被其他标签页占用"));
  });
}

class IndexedDbAssetBackend implements WebDevelopmentAssetBackend {
  private databasePromise?: Promise<IDBDatabase>;

  getAsset(assetId: string): Promise<StoredAssetRecord | undefined> {
    return this.get<StoredAssetRecord>("assets", assetId);
  }

  putAsset(record: StoredAssetRecord): Promise<void> {
    return this.put("assets", record);
  }

  putReference(record: StoredReferenceRecord): Promise<void> {
    return this.put("references", record);
  }

  getDownload(key: string): Promise<StoredDownloadRecord | undefined> {
    return this.get<StoredDownloadRecord>("downloads", key);
  }

  putDownload(record: StoredDownloadRecord): Promise<void> {
    return this.put("downloads", record);
  }

  putDownloadChunk(record: StoredDownloadChunkRecord): Promise<void> {
    return this.put("downloadChunks", record);
  }

  async listDownloadChunks(downloadKeyValue: string, transferId: string): Promise<StoredDownloadChunkRecord[]> {
    const all = await this.getAll<StoredDownloadChunkRecord>("downloadChunks");
    return all.filter((record) => record.downloadKey === downloadKeyValue && record.transferId === transferId);
  }

  async deleteDownload(downloadKeyValue: string, transferId?: string): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(["downloads", "downloadChunks"], "readwrite");
    transaction.objectStore("downloads").delete(downloadKeyValue);
    const chunks = transaction.objectStore("downloadChunks");
    const request = chunks.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value as StoredDownloadChunkRecord;
      if (record.downloadKey === downloadKeyValue && (transferId === undefined || record.transferId === transferId)) {
        cursor.delete();
      }
      cursor.continue();
    };
    await transactionDone(transaction);
  }

  private async database(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("assets")) database.createObjectStore("assets", { keyPath: "assetId" });
        if (!database.objectStoreNames.contains("references")) database.createObjectStore("references", { keyPath: "key" });
        if (!database.objectStoreNames.contains("downloads")) database.createObjectStore("downloads", { keyPath: "key" });
        if (!database.objectStoreNames.contains("downloadChunks")) database.createObjectStore("downloadChunks", { keyPath: "key" });
      };
      request.onsuccess = () => {
        const database = request.result;
        activeDatabases.add(database);
        database.onversionchange = () => {
          database.close();
          activeDatabases.delete(database);
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error("无法打开浏览器开发资源库"));
      request.onblocked = () => reject(new Error("浏览器开发资源库升级被其他标签页阻止"));
    });
    return this.databasePromise;
  }

  private async get<T>(storeName: string, key: string): Promise<T | undefined> {
    const database = await this.database();
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);
    const result = await requestResult<T | undefined>(request);
    await transactionDone(transaction);
    return result;
  }

  private async getAll<T>(storeName: string): Promise<T[]> {
    const database = await this.database();
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    const result = await requestResult<T[]>(request);
    await transactionDone(transaction);
    return result;
  }

  private async put(storeName: string, value: unknown): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    await transactionDone(transaction);
  }
}

async function selectBrowserFile(kind: "image" | "audio"): Promise<File | undefined> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = kind === "image" ? "image/png,image/jpeg,image/webp" : "audio/mpeg,audio/ogg,audio/wav,.mp3,.ogg,.opus,.wav";
  input.hidden = true;
  document.body.append(input);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (file?: File) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files?.[0]), { once: true });
    input.addEventListener("cancel", () => finish(), { once: true });
    input.click();
  });
}

async function normalizeStaticImage(
  sourceBytes: Uint8Array,
  declaredMediaType?: string,
): Promise<{ bytes: Uint8Array; mediaType: "image/webp"; width: number; height: number }> {
  if (sourceBytes.byteLength < 1 || sourceBytes.byteLength > MAX_IMAGE_INPUT_BYTES) {
    throw new Error("浏览器图片输入必须在 1 字节到 25 MiB 之间");
  }
  const detected = detectImageMediaType(sourceBytes);
  if (declaredMediaType && normalizeDeclaredImageType(declaredMediaType) !== detected) {
    throw new Error("图片声明类型与文件内容不一致");
  }
  if (detected === "image/png" && containsAscii(sourceBytes, "acTL")) throw new Error("不支持动画 PNG");
  if (detected === "image/webp" && (containsAscii(sourceBytes, "ANIM") || containsAscii(sourceBytes, "ANMF"))) {
    throw new Error("不支持动画 WebP");
  }
  if (typeof createImageBitmap !== "function") throw new Error("当前浏览器不支持安全图片解码");
  const bitmap = await createImageBitmap(new Blob([copyBuffer(sourceBytes)], { type: detected }));
  try {
    if (bitmap.width < 1 || bitmap.height < 1) throw new Error("图片尺寸无效");
    const scale = Math.min(
      1,
      MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height),
      Math.sqrt(MAX_IMAGE_PIXELS / (bitmap.width * bitmap.height)),
    );
    let width = Math.max(1, Math.floor(bitmap.width * scale));
    let height = Math.max(1, Math.floor(bitmap.height * scale));
    let encoded: Blob | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("当前浏览器无法创建图片规范化画布");
      context.drawImage(bitmap, 0, 0, width, height);
      encoded = await canvasToBlob(canvas, "image/webp", Math.max(0.62, 0.9 - attempt * 0.07));
      if (encoded.size <= MAX_IMAGE_OUTPUT_BYTES) break;
      const reduction = Math.min(0.9, Math.sqrt(MAX_IMAGE_OUTPUT_BYTES / encoded.size) * 0.94);
      width = Math.max(1, Math.floor(width * reduction));
      height = Math.max(1, Math.floor(height * reduction));
    }
    if (!encoded || encoded.size < 1 || encoded.size > MAX_IMAGE_OUTPUT_BYTES) {
      throw new Error("图片规范化后仍超过 8 MiB");
    }
    return { bytes: new Uint8Array(await encoded.arrayBuffer()), mediaType: "image/webp", width, height };
  } finally {
    bitmap.close();
  }
}

function prepareAudio(sourceBytes: Uint8Array, declaredMediaType?: string): { bytes: Uint8Array; mediaType: string } {
  if (sourceBytes.byteLength < 1 || sourceBytes.byteLength > MAX_AUDIO_BYTES) {
    throw new Error("浏览器音频必须在 1 字节到 64 MiB 之间");
  }
  const mediaType = detectAudioMediaType(sourceBytes);
  if (declaredMediaType && normalizeDeclaredAudioType(declaredMediaType) !== mediaType) {
    throw new Error("音频声明类型与文件内容不一致");
  }
  return { bytes: new Uint8Array(sourceBytes), mediaType };
}

async function verifyReceivedBytes(asset: AssetDescriptorV1, bytes: Uint8Array): Promise<void> {
  if (`sha256:${await sha256Hex(bytes)}` !== asset.assetId) throw new Error("接收资源未通过 SHA-256 校验");
  if (asset.mediaType === "image/webp") {
    if (bytes.byteLength > MAX_IMAGE_OUTPUT_BYTES || asset.durationMs !== undefined || !asset.width || !asset.height) {
      throw new Error("接收图片描述符无效");
    }
    if (detectImageMediaType(bytes) !== "image/webp" || containsAscii(bytes, "ANIM") || containsAscii(bytes, "ANMF")) {
      throw new Error("接收图片必须是静态 WebP");
    }
    if (asset.width > MAX_IMAGE_EDGE || asset.height > MAX_IMAGE_EDGE || asset.width * asset.height > MAX_IMAGE_PIXELS) {
      throw new Error("接收图片尺寸超限");
    }
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(new Blob([copyBuffer(bytes)], { type: asset.mediaType }));
      try {
        if (bitmap.width !== asset.width || bitmap.height !== asset.height) throw new Error("接收图片实际尺寸与描述符不一致");
      } finally { bitmap.close(); }
    }
    return;
  }
  if (asset.mediaType === "audio/mpeg" || asset.mediaType === "audio/ogg" || asset.mediaType === "audio/wav") {
    if (bytes.byteLength > MAX_AUDIO_BYTES || asset.width !== undefined || asset.height !== undefined) throw new Error("接收音频描述符无效");
    if (detectAudioMediaType(bytes) !== asset.mediaType) throw new Error("接收音频类型与描述符不一致");
    return;
  }
  throw new Error("浏览器资源通道只支持静态 WebP、MP3、Ogg 或 WAV");
}

function detectImageMediaType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" {
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (matches(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp";
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) throw new Error("不支持 GIF 或动画图片");
  if (containsAscii(bytes.subarray(0, Math.min(bytes.length, 512)), "<svg")) throw new Error("不支持 SVG");
  throw new Error("只支持静态 PNG、JPEG 或 WebP");
}

export function detectAudioMediaType(bytes: Uint8Array): "audio/mpeg" | "audio/ogg" | "audio/wav" {
  if (asciiAt(bytes, 0, "OggS")) return "audio/ogg";
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE")) return "audio/wav";
  if (asciiAt(bytes, 0, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mpeg";
  throw new Error("只支持 MP3、Ogg/Opus/Vorbis 或 WAV");
}

function normalizeDeclaredImageType(value: string): string {
  return value.trim().toLowerCase().replace("image/jpg", "image/jpeg");
}

function normalizeDeclaredAudioType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (["audio/mp3", "audio/mpeg3", "audio/x-mpeg-3"].includes(normalized)) return "audio/mpeg";
  if (["audio/x-wav", "audio/wave", "audio/vnd.wave"].includes(normalized)) return "audio/wav";
  if (["audio/opus", "application/ogg"].includes(normalized)) return "audio/ogg";
  return normalized;
}

function joinChunks(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset + chunk.byteLength > output.byteLength) throw new Error("接收资源分块超过描述符长度");
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== output.byteLength) throw new Error("接收资源分块没有覆盖完整描述符长度");
  return output;
}

function downloadKey(roomId: string, assetId: string): string {
  return `${roomId}\0${assetId}`;
}

function sameDescriptor(left: AssetDescriptorV1, right: AssetDescriptorV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", copyBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function matches(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  return [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

function containsAscii(bytes: Uint8Array, value: string): boolean {
  if (value.length > bytes.length) return false;
  for (let offset = 0; offset <= bytes.length - value.length; offset += 1) {
    if (asciiAt(bytes, offset, value)) return true;
  }
  return false;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("浏览器无法编码静态 WebP")),
    type,
    quality,
  ));
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("浏览器开发资源库请求失败"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("浏览器开发资源库事务失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("浏览器开发资源库事务已中止"));
  });
}
