// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import type { AssetDescriptorV1 } from "@coc-room/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomSessionV2AssetAdapter } from "./RoomSessionV2";
import type { RoomSessionV2 } from "./RoomSessionV2";
import { RoomAssetCoordinator } from "./RoomAssetCoordinator";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(),
}));

const ASSET: AssetDescriptorV1 = {
  schemaVersion: 1,
  assetId: `sha256:${"a".repeat(64)}`,
  mediaType: "audio/mpeg",
  byteLength: 24_577,
};

describe("RoomAssetCoordinator persistent downloads", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("restores native chunks after recreation and removes progress after completion", async () => {
    let adapter!: RoomSessionV2AssetAdapter;
    const restoreAssetFromHost = vi.fn();
    const session = {
      isHost: false,
      room: { id: "room-persisted", hostPeerId: "host-peer-persisted" },
      enableAssetTransfers: (candidate: RoomSessionV2AssetAdapter) => { adapter = candidate; },
      restoreAssetFromHost,
      requestAssetFromHost: vi.fn(),
    } as unknown as RoomSessionV2;
    let imported = false;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "resolve_asset_path") {
        if (!imported) throw new Error("not downloaded");
        return "F:\\managed\\asset.mp3" as never;
      }
      if (command === "load_asset_download") {
        return {
          transferId: "transfer-persisted",
          sourcePeerId: "host-peer-persisted",
          asset: ASSET,
          chunks: [{ chunkIndex: 0, bytes: Array.from({ length: 24 * 1024 }, () => 7) }],
        } as never;
      }
      if (command === "discard_asset_download") {
        imported = true;
        return true as never;
      }
      throw new Error(`unexpected command ${command}`);
    });

    const coordinator = new RoomAssetCoordinator(session);
    const resolved = coordinator.resolve(ASSET);
    await vi.waitFor(() => expect(restoreAssetFromHost).toHaveBeenCalledTimes(1));
    expect(restoreAssetFromHost).toHaveBeenCalledWith(
      ASSET,
      "transfer-persisted",
      [expect.objectContaining({ chunkIndex: 0 })],
    );

    adapter.onEvent?.({
      kind: "completed",
      direction: "incoming",
      peerId: "host-peer-persisted",
      transferId: "transfer-persisted",
      asset: ASSET,
      completedChunks: 2,
      chunkCount: 2,
    });
    await expect(resolved).resolves.toBe("asset://F:\\managed\\asset.mp3");
    expect(invoke).toHaveBeenCalledWith("discard_asset_download", {
      roomId: "room-persisted",
      assetId: ASSET.assetId,
      transferId: "transfer-persisted",
    });
  });

  it("writes each incoming chunk through the native store before ACK eligibility", async () => {
    let adapter!: RoomSessionV2AssetAdapter;
    const session = {
      isHost: false,
      room: { id: "room-persisted", hostPeerId: "host-peer-persisted" },
      enableAssetTransfers: (candidate: RoomSessionV2AssetAdapter) => { adapter = candidate; },
    } as unknown as RoomSessionV2;
    vi.mocked(invoke).mockResolvedValue(true as never);
    new RoomAssetCoordinator(session);

    const bytes = new Uint8Array([1, 2, 3]);
    await adapter.persistIncomingChunk?.({
      peerId: "host-peer-persisted",
      transferId: "transfer-persisted",
      asset: ASSET,
      chunkIndex: 1,
      chunkCount: 2,
      bytes,
    });
    expect(invoke).toHaveBeenCalledWith("persist_asset_download_chunk", {
      roomId: "room-persisted",
      sourcePeerId: "host-peer-persisted",
      transferId: "transfer-persisted",
      asset: ASSET,
      chunkIndex: 1,
      chunkCount: 2,
      bytes: [1, 2, 3],
    });
  });
});
