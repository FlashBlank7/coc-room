import { describe, expect, it, vi } from "vitest";

import type { AssetDescriptorV1, RoomEventViewV2 } from "@coc-room/protocol";
import { prepareTranscriptAssetsV2, visibleTranscriptAssetsV2 } from "./transcript-assets-v2";

describe("V2 offline transcript media", () => {
  it("reads only descriptors present in full views and never a redacted secret", async () => {
    const publicBytes = Uint8Array.from([1, 2, 3, 4]);
    const publicAsset = await asset(publicBytes, "image/webp");
    const secretAsset = await asset(Uint8Array.from([9, 8, 7]), "image/webp");
    const views: RoomEventViewV2[] = [
      artifactView(publicAsset),
      { view: "redacted", protocolVersion: 2, roomId: "room-export-assets", eventId: uuid(2), sequence: 2, occurredAt: "2026-08-30T00:00:02.000Z" },
    ];
    const readAsset = vi.fn(async (candidate: AssetDescriptorV1) => {
      if (candidate.assetId === secretAsset.assetId) throw new Error("secret was requested");
      return publicBytes;
    });

    expect(visibleTranscriptAssetsV2(views)).toEqual([publicAsset]);
    const embedded = await prepareTranscriptAssetsV2(views, { readAsset });

    expect(readAsset).toHaveBeenCalledTimes(1);
    expect(readAsset).toHaveBeenCalledWith(publicAsset);
    expect(embedded[0]).toMatchObject({ assetId: publicAsset.assetId, base64: "AQIDBA==" });
    expect(JSON.stringify(embedded)).not.toContain(secretAsset.assetId);
  });

  it("turns oversized audio and corrupt local bytes into explicit safe placeholders", async () => {
    const oversized: AssetDescriptorV1 = {
      schemaVersion: 1,
      assetId: `sha256:${"a".repeat(64)}`,
      mediaType: "audio/ogg",
      byteLength: 16 * 1024 * 1024 + 1,
    };
    const corruptDescriptor = await asset(Uint8Array.from([1, 2, 3]), "image/webp");
    const readAsset = vi.fn(async () => Uint8Array.from([4, 5, 6]));

    const embedded = await prepareTranscriptAssetsV2([
      audioView(oversized, 1),
      artifactView(corruptDescriptor, 2),
    ], { readAsset });

    expect(readAsset).toHaveBeenCalledTimes(1);
    expect(embedded).toEqual([
      { assetId: oversized.assetId, mediaType: oversized.mediaType, unavailableReason: "音频超过 16 MiB 的离线网页上限" },
      { assetId: corruptDescriptor.assetId, mediaType: corruptDescriptor.mediaType, unavailableReason: "本机资源不可用或校验失败" },
    ]);
  });
});

function artifactView(asset: AssetDescriptorV1, sequence = 1): RoomEventViewV2 {
  return {
    view: "full",
    event: {
      protocolVersion: 2,
      roomId: "room-export-assets",
      eventId: uuid(sequence),
      sequence,
      sender: { seatId: "seat-host", role: "host", displayName: "KP", extensions: {} },
      audience: { kind: "room" },
      occurredAt: `2026-08-30T00:00:0${sequence}.000Z`,
      type: "artifact.upserted",
      payload: {
        artifact: {
          schemaVersion: 2,
          artifactId: `artifact-${sequence}`,
          revision: 1,
          kind: "handout-image",
          title: "照片",
          description: "",
          body: "",
          attachments: [asset],
          audience: { kind: "room" },
          locked: false,
          archived: false,
          extensions: {},
        },
      },
    },
  };
}

function audioView(asset: AssetDescriptorV1, sequence: number): RoomEventViewV2 {
  return {
    view: "full",
    event: {
      protocolVersion: 2,
      roomId: "room-export-assets",
      eventId: uuid(sequence),
      sequence,
      sender: { seatId: "seat-host", role: "host", displayName: "KP", extensions: {} },
      audience: { kind: "room" },
      occurredAt: `2026-08-30T00:00:0${sequence}.000Z`,
      type: "audio.cued",
      payload: { cueId: `cue-${sequence}`, asset, loop: false, volume: 1, fadeInMs: 0, startOffsetMs: 0 },
    },
  };
}

async function asset(bytes: Uint8Array, mediaType: AssetDescriptorV1["mediaType"]): Promise<AssetDescriptorV1> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { schemaVersion: 1, assetId: `sha256:${hash}`, mediaType, byteLength: bytes.byteLength };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}
