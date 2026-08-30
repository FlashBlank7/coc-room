import {
  type AssetDescriptorV1,
  type RoomEventViewV2,
  type TranscriptEmbeddedAssetV2,
} from "@coc-room/protocol";

import {
  hasManagedAssetStore,
  isSameAssetDescriptor,
  readManagedAssetChunk,
  verifyManagedAsset,
} from "./asset-store";

const MAX_EMBEDDED_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_EMBEDDED_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_EMBEDDED_BYTES = 32 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export function visibleTranscriptAssetsV2(views: readonly RoomEventViewV2[]): AssetDescriptorV1[] {
  const seen = new Set<string>();
  const assets: AssetDescriptorV1[] = [];
  const add = (asset: AssetDescriptorV1) => {
    if (seen.has(asset.assetId)) return;
    seen.add(asset.assetId);
    assets.push(asset);
  };
  for (const view of views) {
    if (view.view !== "full") continue;
    const event = view.event;
    if (event.type === "artifact.upserted") {
      for (const asset of event.payload.artifact.attachments) add(asset);
      if (event.payload.artifact.asset) add(event.payload.artifact.asset);
    } else if (event.type === "audio.cued") {
      add(event.payload.asset);
    }
  }
  return assets;
}

/**
 * Best-effort offline media assembly for one already-projected seat view.
 * Missing or oversized files become explicit placeholders; a failed media
 * read never aborts the textual transcript.
 */
export async function prepareTranscriptAssetsV2(
  views: readonly RoomEventViewV2[],
  options: {
    readonly readAsset?: (asset: AssetDescriptorV1) => Promise<Uint8Array>;
  } = {},
): Promise<TranscriptEmbeddedAssetV2[]> {
  const assets = visibleTranscriptAssetsV2(views);
  const readAsset = options.readAsset ?? readVerifiedManagedAsset;
  let embeddedBytes = 0;
  const output: TranscriptEmbeddedAssetV2[] = [];

  for (const asset of assets) {
    const mediaLimit = asset.mediaType.startsWith("image/")
      ? MAX_EMBEDDED_IMAGE_BYTES
      : asset.mediaType.startsWith("audio/")
        ? MAX_EMBEDDED_AUDIO_BYTES
        : 0;
    if (mediaLimit === 0 || !isEmbeddableMediaType(asset.mediaType)) {
      output.push(omitted(asset, "这种附件格式只保留文字说明，未嵌入离线网页"));
      continue;
    }
    if (asset.byteLength > mediaLimit) {
      output.push(omitted(asset, asset.mediaType.startsWith("audio/")
        ? "音频超过 16 MiB 的离线网页上限"
        : "图片超过 8 MiB 的离线网页上限"));
      continue;
    }
    if (embeddedBytes + asset.byteLength > MAX_TOTAL_EMBEDDED_BYTES) {
      output.push(omitted(asset, "已达到 32 MiB 的离线媒体总上限"));
      continue;
    }
    try {
      const bytes = await readAsset(asset);
      if (bytes.byteLength !== asset.byteLength) throw new Error("length mismatch");
      const hash = await sha256Hex(bytes);
      if (asset.assetId !== `sha256:${hash}`) throw new Error("hash mismatch");
      output.push({
        assetId: asset.assetId,
        mediaType: asset.mediaType,
        base64: bytesToBase64(bytes),
      });
      embeddedBytes += bytes.byteLength;
    } catch {
      output.push(omitted(asset, "本机资源不可用或校验失败"));
    }
  }
  return output;
}

async function readVerifiedManagedAsset(asset: AssetDescriptorV1): Promise<Uint8Array> {
  if (!hasManagedAssetStore()) throw new Error("managed asset store unavailable");
  const verified = await verifyManagedAsset(asset.assetId);
  if (!isSameAssetDescriptor(verified, asset)) throw new Error("managed descriptor mismatch");
  const bytes = new Uint8Array(asset.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytes: chunk, eof } = await readManagedAssetChunk(
      asset.assetId,
      offset,
      Math.min(READ_CHUNK_BYTES, bytes.byteLength - offset),
    );
    if (chunk.byteLength === 0) throw new Error("empty managed asset chunk");
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
    if (eof && offset !== bytes.byteLength) throw new Error("early managed asset EOF");
  }
  return bytes;
}

function omitted(asset: AssetDescriptorV1, unavailableReason: string): TranscriptEmbeddedAssetV2 {
  return { assetId: asset.assetId, mediaType: asset.mediaType, unavailableReason };
}

function isEmbeddableMediaType(mediaType: string): boolean {
  return /^(?:image\/(?:jpeg|png|webp)|audio\/(?:mpeg|ogg|wav))$/u.test(mediaType);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + 0x8000));
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
