// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import { Blob as NodeBlob } from "node:buffer";
import { ASSET_CHUNK_BYTES, type AssetDescriptorV1 } from "@coc-room/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebDevelopmentAssetStore,
  detectAudioMediaType,
  type WebDevelopmentAssetBackend,
} from "./web-development-asset-store";

type AssetRecord = NonNullable<Awaited<ReturnType<WebDevelopmentAssetBackend["getAsset"]>>>;
type ReferenceRecord = Parameters<WebDevelopmentAssetBackend["putReference"]>[0];
type DownloadRecord = NonNullable<Awaited<ReturnType<WebDevelopmentAssetBackend["getDownload"]>>>;
type ChunkRecord = Parameters<WebDevelopmentAssetBackend["putDownloadChunk"]>[0];

class MemoryAssetBackend implements WebDevelopmentAssetBackend {
  assets = new Map<string, AssetRecord>();
  references = new Map<string, ReferenceRecord>();
  downloads = new Map<string, DownloadRecord>();
  chunks = new Map<string, ChunkRecord>();

  async getAsset(assetId: string) { return this.assets.get(assetId); }
  async putAsset(record: AssetRecord) { this.assets.set(record.assetId, structuredClone(record)); }
  async putReference(record: ReferenceRecord) { this.references.set(record.key, structuredClone(record)); }
  async getDownload(key: string) { return this.downloads.get(key); }
  async putDownload(record: DownloadRecord) { this.downloads.set(record.key, structuredClone(record)); }
  async putDownloadChunk(record: ChunkRecord) { this.chunks.set(record.key, structuredClone(record)); }
  async listDownloadChunks(downloadKey: string, transferId: string) {
    return [...this.chunks.values()].filter((record) => record.downloadKey === downloadKey && record.transferId === transferId);
  }
  async deleteDownload(downloadKey: string, transferId?: string) {
    this.downloads.delete(downloadKey);
    for (const [key, record] of this.chunks) {
      if (record.downloadKey === downloadKey && (transferId === undefined || record.transferId === transferId)) this.chunks.delete(key);
    }
  }
}

beforeEach(() => Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser development asset store", () => {
  it("persists canonical audio by hash and can be reopened through the same IndexedDB-shaped backend", async () => {
    const backend = new MemoryAssetBackend();
    const bytes = Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
    const first = new WebDevelopmentAssetStore(backend);
    const imported = await first.importBytes("audio", bytes, "audio/mp3");
    expect(imported.asset.mediaType).toBe("audio/mpeg");
    expect(imported.asset.assetId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(imported.deduplicated).toBe(false);

    const reopened = new WebDevelopmentAssetStore(backend);
    expect(await reopened.verify(imported.asset.assetId)).toEqual(imported.asset);
    expect((await reopened.importBytes("audio", bytes)).deduplicated).toBe(true);
    await reopened.addReference({
      assetId: imported.asset.assetId,
      ownerType: "artifact",
      ownerId: "artifact-1",
      ownerRevision: 1,
      slot: "audio.source",
    });
    expect(backend.references.size).toBe(1);
    expect((await reopened.readChunk(imported.asset.assetId, 3, 4)).bytes).toEqual(bytes.slice(3, 7));
  });

  it("persists received transfer chunks before ACK and resumes them after recreation", async () => {
    const backend = new MemoryAssetBackend();
    const bytes = new Uint8Array(ASSET_CHUNK_BYTES + 3);
    bytes.set([0x49, 0x44, 0x33]);
    const asset: AssetDescriptorV1 = {
      schemaVersion: 1,
      assetId: `sha256:${await sha256(bytes)}`,
      mediaType: "audio/mpeg",
      byteLength: bytes.byteLength,
    };
    const first = new WebDevelopmentAssetStore(backend);
    await first.persistDownloadChunk({
      roomId: "room-browser",
      sourcePeerId: "peer-browser-source",
      transferId: "transfer-browser",
      asset,
      chunkIndex: 1,
      chunkCount: 2,
      bytes: bytes.slice(ASSET_CHUNK_BYTES),
    });
    await first.persistDownloadChunk({
      roomId: "room-browser",
      sourcePeerId: "peer-browser-source",
      transferId: "transfer-browser",
      asset,
      chunkIndex: 0,
      chunkCount: 2,
      bytes: bytes.slice(0, ASSET_CHUNK_BYTES),
    });

    const reopened = new WebDevelopmentAssetStore(backend);
    const restored = await reopened.loadDownload("room-browser", "peer-browser-source", asset);
    expect(restored?.chunks.map(({ chunkIndex }) => chunkIndex)).toEqual([0, 1]);
    await expect(reopened.importReceived(asset, restored!.chunks.map(({ bytes: chunk }) => chunk))).resolves.toMatchObject({ asset });
    await reopened.discardDownload("room-browser", asset.assetId, "transfer-browser");
    expect(await reopened.loadDownload("room-browser", "peer-browser-source", asset)).toBeUndefined();
  });

  it("re-encodes static browser images to bounded WebP descriptors", async () => {
    const backend = new MemoryAssetBackend();
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const output = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
    const bitmap = { width: 10_000, height: 4_000, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    const originalCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      if (tagName !== "canvas") return originalCreate(tagName);
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toBlob: (callback: BlobCallback) => callback(new NodeBlob([output], { type: "image/webp" }) as unknown as Blob),
      } as unknown as HTMLCanvasElement;
    }) as typeof document.createElement);

    const imported = await new WebDevelopmentAssetStore(backend).importBytes("image", png, "image/png");
    expect(imported.asset).toMatchObject({ mediaType: "image/webp", width: 8_192, height: 3_276 });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("rejects spoofed and unsupported media instead of trusting extensions or MIME labels", async () => {
    const store = new WebDevelopmentAssetStore(new MemoryAssetBackend());
    const mp3 = Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0]);
    await expect(store.importBytes("audio", mp3, "audio/wav")).rejects.toThrow(/声明类型/);
    await expect(store.importBytes("image", new TextEncoder().encode("<svg></svg>"), "image/svg+xml")).rejects.toThrow(/SVG/);
    expect(() => detectAudioMediaType(new Uint8Array([1, 2, 3]))).toThrow(/只支持/);
  });
});

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await webcrypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
