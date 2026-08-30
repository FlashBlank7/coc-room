import type { AssetDescriptorV1 } from "@coc-room/protocol";
import {
  addManagedAssetReference,
  discardManagedAssetDownload,
  hasManagedAssetStore,
  importReceivedManagedAsset,
  isSameAssetDescriptor,
  loadManagedAssetDownload,
  persistManagedAssetDownloadChunk,
  readManagedAssetChunk,
  resolveManagedAssetUrl,
  verifyManagedAsset,
} from "../lib/asset-store";
import type { AssetTransferEvent } from "./AssetTransferManager";
import type { RoomSessionV2 } from "./RoomSessionV2";

interface PendingAsset {
  readonly promise: Promise<string>;
  readonly resolve: (url: string) => void;
  readonly reject: (error: Error) => void;
  transferId?: string;
}

/** Bridges the V2 authenticated asset channel to the Rust content-addressed store. */
export class RoomAssetCoordinator {
  private readonly pending = new Map<string, PendingAsset>();
  private readonly verifiedLocalAssets = new Map<string, AssetDescriptorV1>();
  private disposed = false;

  constructor(
    private readonly session: RoomSessionV2,
    private readonly onEvent?: (event: AssetTransferEvent) => void,
  ) {
    if (!hasManagedAssetStore()) throw new Error("房间资源协调器仅可在桌面应用中启用");
    session.enableAssetTransfers({
      readLocalChunk: ({ asset, offset, length }) => readManagedAssetChunk(asset.assetId, offset, length),
      finalizeReceivedAsset: async ({ asset, chunks }) => {
        await importReceivedManagedAsset(asset, chunks);
      },
      persistIncomingChunk: async (input) => {
        // Player downloads have a stable room + host + descriptor identity.
        // Command-scoped player uploads intentionally remain ephemeral.
        if (session.isHost) return;
        await persistManagedAssetDownloadChunk({
          roomId: session.room.id,
          sourcePeerId: input.peerId,
          transferId: input.transferId,
          asset: input.asset,
          chunkIndex: input.chunkIndex,
          chunkCount: input.chunkCount,
          bytes: input.bytes,
        });
      },
      hasLocalAsset: async (asset) => {
        try {
          const cached = this.verifiedLocalAssets.get(asset.assetId);
          const actual = cached ?? await verifyManagedAsset(asset.assetId);
          this.verifiedLocalAssets.set(asset.assetId, actual);
          return isSameAssetDescriptor(actual, asset);
        } catch {
          return false;
        }
      },
      addEventAssetReference: ({ asset, artifactId, revision, slot }) => addManagedAssetReference({
        assetId: asset.assetId,
        ownerType: "artifact",
        ownerId: artifactId,
        ownerRevision: revision,
        slot,
      }),
      onEvent: (event) => this.handleTransferEvent(event),
    });
  }

  async resolve(asset: AssetDescriptorV1): Promise<string> {
    if (this.disposed) throw new Error("房间资源协调器已经停止");
    try {
      const url = await resolveManagedAssetUrl(asset.assetId);
      this.session.announceAssetReady?.(asset);
      return url;
    } catch (error) {
      if (this.session.isHost) throw new Error("房主本地缺少已发布资源", { cause: error });
    }
    const existing = this.pending.get(asset.assetId);
    if (existing) return existing.promise;
    let resolve!: (url: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((accept, decline) => { resolve = accept; reject = decline; });
    const pending: PendingAsset = { promise, resolve, reject };
    this.pending.set(asset.assetId, pending);
    try {
      const restored = await loadManagedAssetDownload(
        this.session.room.id,
        this.session.room.hostPeerId,
        asset,
      );
      if (this.disposed) throw new Error("Room asset coordinator has stopped");
      pending.transferId = restored
        ? this.session.restoreAssetFromHost(asset, restored.transferId, restored.chunks)
        : this.session.requestAssetFromHost(asset);
    } catch (error) {
      this.pending.delete(asset.assetId);
      reject(asError(error));
    }
    return promise;
  }

  cancel(assetId: string): boolean {
    const transferId = this.pending.get(assetId)?.transferId;
    return transferId !== undefined && this.session.cancelAssetTransfer(transferId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("房间资源请求已停止"));
    this.pending.clear();
  }

  private handleTransferEvent(event: AssetTransferEvent): void {
    this.onEvent?.(event);
    const assetId = event.asset?.assetId;
    if (!assetId || event.direction !== "incoming") return;
    const pending = this.pending.get(assetId);
    if (!pending) return;
    if (event.kind === "completed") {
      this.pending.delete(assetId);
      void discardManagedAssetDownload(this.session.room.id, assetId, event.transferId)
        .then(() => resolveManagedAssetUrl(assetId))
        .then((url) => {
          this.session.announceAssetReady?.(event.asset);
          return url;
        })
        .then(pending.resolve, (error) => pending.reject(asError(error)));
    } else if (event.kind === "error") {
      this.pending.delete(assetId);
      if (event.code === "HASH_MISMATCH" || event.code === "FINALIZE_FAILED") {
        // A complete but invalid payload can never become valid by resuming it.
        void discardManagedAssetDownload(this.session.room.id, assetId, event.transferId)
          .then(
            () => pending.reject(new Error(event.message)),
            (error) => pending.reject(asError(error)),
          );
      } else {
        // Transport failures retain their already-ACKed chunks for a retry.
        pending.reject(new Error(event.message));
      }
    } else if (event.kind === "cancelled") {
      this.pending.delete(assetId);
      void discardManagedAssetDownload(this.session.room.id, assetId, event.transferId)
        .then(
          () => pending.reject(new Error("Asset transfer was cancelled")),
          (error) => pending.reject(asError(error)),
        );
    }
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
