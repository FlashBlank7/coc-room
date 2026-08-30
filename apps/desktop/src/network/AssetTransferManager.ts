import {
  ASSET_CHUNK_BYTES,
  type AssetDescriptorV1,
  type PeerMessageV1,
} from "@coc-room/protocol";

export type AssetWireMessage = Extract<
  PeerMessageV1,
  { kind: "asset.request" | "asset.chunk" | "asset.ack" | "asset.cancel" | "asset.error" }
>;

export type AssetTransferDirection = "incoming" | "outgoing";
export type AssetTransferErrorCode = Extract<AssetWireMessage, { kind: "asset.error" }>["code"];

export interface AssetReadResult {
  readonly bytes: Uint8Array;
  readonly eof?: boolean;
}

export interface FinalizeReceivedAssetInput {
  readonly peerId: string;
  readonly transferId: string;
  readonly asset: AssetDescriptorV1;
  /** Chunks are ordered and have already passed the descriptor's SHA-256 check. */
  readonly chunks: readonly Uint8Array[];
}

export interface PersistIncomingAssetChunkInput {
  readonly peerId: string;
  readonly transferId: string;
  readonly asset: AssetDescriptorV1;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly bytes: Uint8Array;
}

export interface RestoredIncomingAssetChunk {
  readonly chunkIndex: number;
  readonly bytes: Uint8Array;
}

export type AssetTransferEvent =
  | {
      readonly kind: "started" | "progress" | "completed" | "cancelled" | "backpressured";
      readonly direction: AssetTransferDirection;
      readonly peerId: string;
      readonly transferId: string;
      readonly asset: AssetDescriptorV1;
      readonly completedChunks: number;
      readonly chunkCount: number;
    }
  | {
      readonly kind: "error";
      readonly direction: AssetTransferDirection;
      readonly peerId: string;
      readonly transferId: string;
      readonly asset?: AssetDescriptorV1;
      readonly code: AssetTransferErrorCode | "FINALIZE_FAILED" | "PERSIST_FAILED" | "TRANSPORT_FAILED";
      readonly message: string;
      readonly remote: boolean;
      readonly cause?: unknown;
    };

export interface AssetTransferManagerOptions {
  /** Returns false while the transport's reliable channel is backpressured. */
  readonly sendToPeer: (peerId: string, message: AssetWireMessage) => boolean;
  readonly readLocalChunk: (input: {
    readonly peerId: string;
    readonly transferId: string;
    readonly asset: AssetDescriptorV1;
    readonly offset: number;
    readonly length: number;
  }) => Promise<Uint8Array | AssetReadResult>;
  readonly finalizeReceivedAsset: (input: FinalizeReceivedAssetInput) => Promise<void>;
  /** Persists a validated chunk before it is acknowledged to the sender. */
  readonly persistIncomingChunk?: (input: PersistIncomingAssetChunkInput) => Promise<void>;
  /**
   * Must prove that this peer already received an authorized room-event reference
   * to this exact descriptor. There is intentionally no permissive default.
   */
  readonly canServeAsset: (
    peerId: string,
    asset: AssetDescriptorV1,
    context: { transferId: string; resume: boolean },
  ) => boolean | Promise<boolean>;
  readonly onEvent?: (event: AssetTransferEvent) => void;
  readonly ttlMs?: number;
  readonly backpressureRetryMs?: number;
  readonly maxIncomingTransfers?: number;
  readonly maxOutgoingTransfers?: number;
  readonly maxAssetBytes?: number;
  /** Includes a second copy reserved temporarily for Web Crypto SHA-256 input. */
  readonly maxBufferedBytes?: number;
  readonly createTransferId?: () => string;
}

export interface AssetTransferSnapshot {
  readonly incoming: readonly {
    transferId: string;
    peerId: string;
    assetId: string;
    receivedChunkIndexes: readonly number[];
    chunkCount: number;
  }[];
  readonly outgoing: readonly {
    transferId: string;
    peerId: string;
    assetId: string;
    pendingChunkIndexes: readonly number[];
    chunkCount: number;
    backpressured: boolean;
  }[];
  readonly reservedIncomingBytes: number;
}

interface TimedTransfer {
  expiresAt: number;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

interface IncomingTransfer extends TimedTransfer {
  readonly direction: "incoming";
  readonly key: string;
  readonly peerId: string;
  readonly transferId: string;
  readonly asset: AssetDescriptorV1;
  readonly chunkCount: number;
  readonly chunks: Map<number, Uint8Array>;
  receivedBytes: number;
  receivedThrough: number;
  finalizing: boolean;
}

interface OutgoingTransfer extends TimedTransfer {
  readonly direction: "outgoing";
  readonly key: string;
  readonly peerId: string;
  readonly transferId: string;
  readonly asset: AssetDescriptorV1;
  readonly chunkCount: number;
  readonly pendingIndexes: number[];
  readonly pendingSet: Set<number>;
  acknowledgedThrough: number;
  sentIndexes: Set<number>;
  pendingMessage?: Extract<AssetWireMessage, { kind: "asset.chunk" }>;
  pumping: boolean;
  retryHandle?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TTL_MS = 120_000;
const DEFAULT_BACKPRESSURE_RETRY_MS = 100;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_ASSET_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 128 * 1024 * 1024;

/**
 * Reliable asset-transfer state machine. It is deliberately independent from
 * RoomSession so V1/V2 room semantics and the Rust asset store stay separate.
 */
export class AssetTransferManager {
  private readonly incoming = new Map<string, IncomingTransfer>();
  private readonly outgoing = new Map<string, OutgoingTransfer>();
  private reservedIncomingBytes = 0;
  private disposed = false;

  constructor(private readonly options: AssetTransferManagerOptions) {}

  requestAsset(peerId: string, asset: AssetDescriptorV1, transferId = this.createTransferId()): string {
    return this.startIncoming(peerId, asset, transferId, []);
  }

  /** Restores chunks loaded from the managed temporary store and asks only for gaps. */
  restoreIncoming(
    peerId: string,
    asset: AssetDescriptorV1,
    transferId: string,
    restoredChunks: readonly RestoredIncomingAssetChunk[],
  ): string {
    return this.startIncoming(peerId, asset, transferId, restoredChunks);
  }

  private startIncoming(
    peerId: string,
    asset: AssetDescriptorV1,
    transferId: string,
    restoredChunks: readonly RestoredIncomingAssetChunk[],
  ): string {
    this.assertActive();
    this.assertTransferWithinLimits(asset);
    if (this.incoming.size >= this.maxIncomingTransfers) {
      throw new AssetTransferLimitError("同时接收的资源数量已达到上限");
    }

    const key = transferKey(peerId, transferId);
    if (this.incoming.has(key) || this.outgoing.has(key)) {
      throw new Error(`资源传输 ID 已存在：${transferId}`);
    }

    const reservation = asset.byteLength * 2;
    if (this.reservedIncomingBytes + reservation > this.maxBufferedBytes) {
      throw new AssetTransferLimitError("资源接收缓冲区预算不足");
    }

    const chunks = new Map<number, Uint8Array>();
    let receivedBytes = 0;
    for (const restored of restoredChunks) {
      if (!Number.isInteger(restored.chunkIndex) || restored.chunkIndex < 0 || restored.chunkIndex >= chunkCountFor(asset)) {
        throw new Error("Persisted asset chunk index is invalid");
      }
      if (chunks.has(restored.chunkIndex)) throw new Error("Persisted asset contains duplicate chunk indexes");
      const expectedLength = expectedChunkLength(asset, restored.chunkIndex, chunkCountFor(asset));
      if (restored.bytes.byteLength !== expectedLength) throw new Error("Persisted asset chunk length is invalid");
      const bytes = restored.bytes.slice();
      chunks.set(restored.chunkIndex, bytes);
      receivedBytes += bytes.byteLength;
    }
    let receivedThrough = -1;
    while (chunks.has(receivedThrough + 1)) receivedThrough += 1;
    const state: IncomingTransfer = {
      direction: "incoming",
      key,
      peerId,
      transferId,
      asset,
      chunkCount: chunkCountFor(asset),
      chunks,
      receivedBytes,
      receivedThrough,
      finalizing: false,
      expiresAt: 0,
    };
    this.incoming.set(key, state);
    this.reservedIncomingBytes += reservation;
    this.touch(state);
    this.emitProgress("started", state, 0);
    if (chunks.size > 0) this.emitProgress("progress", state, chunks.size);

    if (chunks.size === state.chunkCount) {
      void this.finalizeIncoming(state);
      return transferId;
    }
    const missingChunkIndexes = chunks.size > 0 ? missingIndexes(state.chunkCount, chunks) : undefined;
    if (!this.safeSend(peerId, {
      kind: "asset.request",
      transferId,
      asset,
      ...(missingChunkIndexes ? { missingChunkIndexes } : {}),
    })) {
      this.emitProgress("backpressured", state, 0);
    }
    return transferId;
  }

  /** Requests only the gaps still missing from a partially received transfer. */
  resumeIncoming(transferId: string, peerId?: string): boolean {
    this.assertActive();
    const state = this.findIncoming(transferId, peerId);
    if (state === undefined || state.finalizing) return false;
    const missingChunkIndexes = missingIndexes(state.chunkCount, state.chunks);
    if (missingChunkIndexes.length === 0) return false;
    const sent = this.safeSend(state.peerId, {
      kind: "asset.request",
      transferId: state.transferId,
      asset: state.asset,
      missingChunkIndexes,
    });
    if (sent) this.touch(state);
    else this.emitProgress("backpressured", state, state.chunks.size);
    return sent;
  }

  /** Gives a backpressured sender an immediate retry when bufferedAmount falls. */
  notifyPeerWritable(peerId: string): void {
    if (this.disposed) return;
    for (const state of this.outgoing.values()) {
      if (state.peerId !== peerId || state.pendingMessage === undefined) continue;
      this.clearRetry(state);
      void this.pumpOutgoing(state);
    }
  }

  cancelTransfer(transferId: string, peerId?: string): boolean {
    this.assertActive();
    const incoming = this.findIncoming(transferId, peerId);
    const outgoing = this.findOutgoing(transferId, peerId);
    const state = incoming ?? outgoing;
    if (state === undefined) return false;
    this.safeSend(state.peerId, { kind: "asset.cancel", transferId });
    if (incoming !== undefined) this.removeIncoming(incoming, "cancelled");
    if (outgoing !== undefined) this.removeOutgoing(outgoing, "cancelled");
    return true;
  }

  async handleMessage(peerId: string, message: PeerMessageV1): Promise<boolean> {
    if (!message.kind.startsWith("asset.")) return false;
    this.assertActive();
    const assetMessage = message as AssetWireMessage;
    switch (assetMessage.kind) {
      case "asset.request":
        await this.handleRequest(peerId, assetMessage);
        break;
      case "asset.chunk":
        await this.handleChunk(peerId, assetMessage);
        break;
      case "asset.ack":
        this.handleAck(peerId, assetMessage);
        break;
      case "asset.cancel":
        this.handleCancel(peerId, assetMessage);
        break;
      case "asset.error":
        this.handleRemoteError(peerId, assetMessage);
        break;
    }
    return true;
  }

  getSnapshot(): AssetTransferSnapshot {
    return {
      incoming: [...this.incoming.values()].map((state) => ({
        transferId: state.transferId,
        peerId: state.peerId,
        assetId: state.asset.assetId,
        receivedChunkIndexes: [...state.chunks.keys()].sort(compareNumbers),
        chunkCount: state.chunkCount,
      })),
      outgoing: [...this.outgoing.values()].map((state) => ({
        transferId: state.transferId,
        peerId: state.peerId,
        assetId: state.asset.assetId,
        pendingChunkIndexes: [...state.pendingIndexes],
        chunkCount: state.chunkCount,
        backpressured: state.pendingMessage !== undefined,
      })),
      reservedIncomingBytes: this.reservedIncomingBytes,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.incoming.values()) this.clearExpiry(state);
    for (const state of this.outgoing.values()) {
      this.clearExpiry(state);
      this.clearRetry(state);
    }
    this.incoming.clear();
    this.outgoing.clear();
    this.reservedIncomingBytes = 0;
  }

  private async handleRequest(
    peerId: string,
    message: Extract<AssetWireMessage, { kind: "asset.request" }>,
  ): Promise<void> {
    const key = transferKey(peerId, message.transferId);
    let state = this.outgoing.get(key);
    if (state !== undefined && !sameDescriptor(state.asset, message.asset)) {
      this.sendError(peerId, message.transferId, "INVALID", "续传请求的资源描述符不一致");
      return;
    }

    if (state === undefined) {
      try {
        this.assertTransferWithinLimits(message.asset);
      } catch (error) {
        this.sendError(peerId, message.transferId, "LIMIT", errorMessage(error));
        return;
      }
      if (this.outgoing.size >= this.maxOutgoingTransfers) {
        this.sendError(peerId, message.transferId, "LIMIT", "同时发送的资源数量已达到上限");
        return;
      }

      let authorized = false;
      try {
        authorized = await this.options.canServeAsset(peerId, message.asset, { transferId: message.transferId, resume: false });
      } catch (error) {
        this.emitError("outgoing", peerId, message.transferId, message.asset, "FORBIDDEN", "资源授权检查失败", false, error);
      }
      if (!authorized) {
        this.sendError(peerId, message.transferId, "FORBIDDEN", "目标席位尚未获得引用此资源的完整事件");
        return;
      }

      state = {
        direction: "outgoing",
        key,
        peerId,
        transferId: message.transferId,
        asset: message.asset,
        chunkCount: chunkCountFor(message.asset),
        pendingIndexes: [],
        pendingSet: new Set(),
        acknowledgedThrough: -1,
        sentIndexes: new Set(),
        pumping: false,
        expiresAt: 0,
      };
      this.outgoing.set(key, state);
      this.touch(state);
      this.emitProgress("started", state, 0);
    } else {
      // Authorization is intentionally re-evaluated for every resume request.
      let authorized = false;
      try {
        authorized = await this.options.canServeAsset(peerId, message.asset, { transferId: message.transferId, resume: true });
      } catch {
        authorized = false;
      }
      if (!authorized) {
        this.sendError(peerId, message.transferId, "FORBIDDEN", "资源授权已失效");
        this.removeOutgoing(state);
        return;
      }
    }

    const requested = message.missingChunkIndexes ?? range(state.chunkCount);
    const uniqueRequested = new Set(requested);
    if (uniqueRequested.size !== requested.length || requested.some((index) => index >= state.chunkCount)) {
      this.sendError(peerId, message.transferId, "INVALID", "续传分块索引无效");
      return;
    }
    for (const index of requested) {
      if (!state.pendingSet.has(index)) {
        state.pendingIndexes.push(index);
        state.pendingSet.add(index);
      }
    }
    this.touch(state);
    await this.pumpOutgoing(state);
  }

  private async pumpOutgoing(state: OutgoingTransfer): Promise<void> {
    if (state.pumping || !this.outgoing.has(state.key) || this.disposed) return;
    state.pumping = true;
    try {
      while (this.outgoing.has(state.key)) {
        let wire = state.pendingMessage;
        if (wire === undefined) {
          const chunkIndex = state.pendingIndexes[0];
          if (chunkIndex === undefined) break;
          const expectedLength = expectedChunkLength(state.asset, chunkIndex, state.chunkCount);
          let result: Uint8Array | AssetReadResult;
          try {
            result = await this.options.readLocalChunk({
              peerId: state.peerId,
              transferId: state.transferId,
              asset: state.asset,
              offset: chunkIndex * ASSET_CHUNK_BYTES,
              length: expectedLength,
            });
          } catch (error) {
            this.failOutgoing(state, "NOT_FOUND", "无法读取本地资源分块", error);
            return;
          }
          if (!this.outgoing.has(state.key)) return;
          const bytes = result instanceof Uint8Array ? result : result.bytes;
          if (bytes.byteLength !== expectedLength) {
            this.failOutgoing(state, "INVALID", "本地资源长度与描述符不一致");
            return;
          }
          wire = {
            kind: "asset.chunk",
            transferId: state.transferId,
            assetId: state.asset.assetId,
            chunkIndex,
            chunkCount: state.chunkCount,
            data: bytesToBase64(bytes),
          };
        }

        if (!this.safeSend(state.peerId, wire)) {
          state.pendingMessage = wire;
          this.emitProgress("backpressured", state, state.sentIndexes.size);
          this.scheduleRetry(state);
          return;
        }

        state.pendingMessage = undefined;
        const shifted = state.pendingIndexes.shift();
        if (shifted !== wire.chunkIndex) {
          this.failOutgoing(state, "INVALID", "内部发送队列失去同步");
          return;
        }
        state.pendingSet.delete(wire.chunkIndex);
        state.sentIndexes.add(wire.chunkIndex);
        this.touch(state);
        this.emitProgress("progress", state, state.sentIndexes.size);
      }
    } finally {
      state.pumping = false;
    }
  }

  private async handleChunk(
    peerId: string,
    message: Extract<AssetWireMessage, { kind: "asset.chunk" }>,
  ): Promise<void> {
    const state = this.incoming.get(transferKey(peerId, message.transferId));
    if (state === undefined) {
      this.sendError(peerId, message.transferId, "INVALID", "未找到对应的资源接收请求");
      return;
    }
    if (state.finalizing) return;
    if (message.assetId !== state.asset.assetId || message.chunkCount !== state.chunkCount) {
      this.failIncoming(state, "INVALID", "资源分块与请求描述符不一致");
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(message.data);
    } catch (error) {
      this.failIncoming(state, "INVALID", "资源分块不是有效的 Base64", error);
      return;
    }
    const expectedLength = expectedChunkLength(state.asset, message.chunkIndex, state.chunkCount);
    if (bytes.byteLength !== expectedLength) {
      this.failIncoming(state, "INVALID", "资源分块长度与描述符不一致");
      return;
    }

    const previous = state.chunks.get(message.chunkIndex);
    if (previous !== undefined) {
      if (!equalBytes(previous, bytes)) {
        this.failIncoming(state, "INVALID", "收到内容冲突的重复资源分块");
      } else {
        this.touch(state);
        if (state.receivedThrough >= 0) {
          this.safeSend(peerId, {
            kind: "asset.ack",
            transferId: state.transferId,
            receivedThrough: state.receivedThrough,
          });
        }
      }
      return;
    }

    if (this.options.persistIncomingChunk) {
      try {
        await this.options.persistIncomingChunk({
          peerId: state.peerId,
          transferId: state.transferId,
          asset: state.asset,
          chunkIndex: message.chunkIndex,
          chunkCount: state.chunkCount,
          bytes,
        });
      } catch (error) {
        this.sendError(state.peerId, state.transferId, "INVALID", "Asset chunk could not be persisted");
        this.emitError(
          "incoming",
          state.peerId,
          state.transferId,
          state.asset,
          "PERSIST_FAILED",
          "Asset chunk could not be persisted before acknowledgement",
          false,
          error,
        );
        this.removeIncoming(state);
        return;
      }
    }
    if (!this.incoming.has(state.key) || state.finalizing) return;
    const concurrentlyReceived = state.chunks.get(message.chunkIndex);
    if (concurrentlyReceived !== undefined) {
      if (!equalBytes(concurrentlyReceived, bytes)) {
        this.failIncoming(state, "INVALID", "Concurrent duplicate asset chunks conflict");
      } else if (state.receivedThrough >= 0) {
        this.safeSend(peerId, {
          kind: "asset.ack",
          transferId: state.transferId,
          receivedThrough: state.receivedThrough,
        });
      }
      return;
    }
    state.chunks.set(message.chunkIndex, bytes);
    state.receivedBytes += bytes.byteLength;
    while (state.chunks.has(state.receivedThrough + 1)) state.receivedThrough += 1;
    this.touch(state);
    if (state.receivedThrough >= 0) {
      this.safeSend(peerId, {
        kind: "asset.ack",
        transferId: state.transferId,
        receivedThrough: state.receivedThrough,
      });
    }
    this.emitProgress("progress", state, state.chunks.size);

    if (state.chunks.size !== state.chunkCount) return;
    await this.finalizeIncoming(state);
  }

  private async finalizeIncoming(state: IncomingTransfer): Promise<void> {
    if (!this.incoming.has(state.key) || state.finalizing) return;
    if (state.receivedBytes !== state.asset.byteLength) {
      this.failIncoming(state, "INVALID", "完整资源长度与描述符不一致");
      return;
    }

    state.finalizing = true;
    const chunks = range(state.chunkCount).map((index) => state.chunks.get(index)!);
    let actualHash: string;
    try {
      actualHash = await sha256Hex(chunks, state.asset.byteLength);
    } catch (error) {
      this.failIncoming(state, "INVALID", "无法校验资源 SHA-256", error);
      return;
    }
    if (`sha256:${actualHash}` !== state.asset.assetId) {
      this.failIncoming(state, "HASH_MISMATCH", "资源 SHA-256 校验失败");
      return;
    }

    try {
      await this.options.finalizeReceivedAsset({
        peerId: state.peerId,
        transferId: state.transferId,
        asset: state.asset,
        chunks,
      });
    } catch (error) {
      this.sendError(state.peerId, state.transferId, "INVALID", "资源入库失败");
      this.emitError(
        "incoming",
        state.peerId,
        state.transferId,
        state.asset,
        "FINALIZE_FAILED",
        "资源验证成功，但写入本地资源库失败",
        false,
        error,
      );
      this.removeIncoming(state);
      return;
    }
    this.removeIncoming(state, "completed");
  }

  private handleAck(peerId: string, message: Extract<AssetWireMessage, { kind: "asset.ack" }>): void {
    const state = this.outgoing.get(transferKey(peerId, message.transferId));
    if (state === undefined) return;
    if (message.receivedThrough >= state.chunkCount) {
      this.failOutgoing(state, "INVALID", "资源 ACK 超出分块范围");
      return;
    }
    state.acknowledgedThrough = Math.max(state.acknowledgedThrough, message.receivedThrough);
    this.touch(state);
    if (state.acknowledgedThrough === state.chunkCount - 1) {
      this.removeOutgoing(state, "completed");
    }
  }

  private handleCancel(peerId: string, message: Extract<AssetWireMessage, { kind: "asset.cancel" }>): void {
    const key = transferKey(peerId, message.transferId);
    const incoming = this.incoming.get(key);
    const outgoing = this.outgoing.get(key);
    if (incoming !== undefined) this.removeIncoming(incoming, "cancelled");
    if (outgoing !== undefined) this.removeOutgoing(outgoing, "cancelled");
  }

  private handleRemoteError(peerId: string, message: Extract<AssetWireMessage, { kind: "asset.error" }>): void {
    const key = transferKey(peerId, message.transferId);
    const incoming = this.incoming.get(key);
    const outgoing = this.outgoing.get(key);
    const state = incoming ?? outgoing;
    this.emitError(
      state?.direction ?? "incoming",
      peerId,
      message.transferId,
      state?.asset,
      message.code,
      message.message,
      true,
    );
    if (incoming !== undefined) this.removeIncoming(incoming);
    if (outgoing !== undefined) this.removeOutgoing(outgoing);
  }

  private failIncoming(
    state: IncomingTransfer,
    code: AssetTransferErrorCode,
    message: string,
    cause?: unknown,
  ): void {
    this.sendError(state.peerId, state.transferId, code, message);
    this.emitError("incoming", state.peerId, state.transferId, state.asset, code, message, false, cause);
    this.removeIncoming(state);
  }

  private failOutgoing(
    state: OutgoingTransfer,
    code: AssetTransferErrorCode,
    message: string,
    cause?: unknown,
  ): void {
    this.sendError(state.peerId, state.transferId, code, message);
    this.emitError("outgoing", state.peerId, state.transferId, state.asset, code, message, false, cause);
    this.removeOutgoing(state);
  }

  private removeIncoming(state: IncomingTransfer, outcome?: "completed" | "cancelled"): void {
    if (!this.incoming.delete(state.key)) return;
    this.clearExpiry(state);
    this.reservedIncomingBytes = Math.max(0, this.reservedIncomingBytes - state.asset.byteLength * 2);
    if (outcome !== undefined) this.emitProgress(outcome, state, state.chunks.size);
  }

  private removeOutgoing(state: OutgoingTransfer, outcome?: "completed" | "cancelled"): void {
    if (!this.outgoing.delete(state.key)) return;
    this.clearExpiry(state);
    this.clearRetry(state);
    if (outcome !== undefined) this.emitProgress(outcome, state, state.sentIndexes.size);
  }

  private touch(state: IncomingTransfer | OutgoingTransfer): void {
    this.clearExpiry(state);
    state.expiresAt = Date.now() + this.ttlMs;
    state.timeoutHandle = setTimeout(() => this.expire(state), this.ttlMs);
  }

  private expire(state: IncomingTransfer | OutgoingTransfer): void {
    const current = state.direction === "incoming" ? this.incoming.get(state.key) : this.outgoing.get(state.key);
    if (current !== state || this.disposed) return;
    const remaining = state.expiresAt - Date.now();
    if (remaining > 0) {
      state.timeoutHandle = setTimeout(() => this.expire(state), remaining);
      return;
    }
    this.sendError(state.peerId, state.transferId, "TIMEOUT", "资源传输超时");
    this.emitError(state.direction, state.peerId, state.transferId, state.asset, "TIMEOUT", "资源传输超时", false);
    if (state.direction === "incoming") this.removeIncoming(state);
    else this.removeOutgoing(state);
  }

  private scheduleRetry(state: OutgoingTransfer): void {
    if (state.retryHandle !== undefined || !this.outgoing.has(state.key)) return;
    state.retryHandle = setTimeout(() => {
      state.retryHandle = undefined;
      void this.pumpOutgoing(state);
    }, this.backpressureRetryMs);
  }

  private clearExpiry(state: TimedTransfer): void {
    if (state.timeoutHandle !== undefined) clearTimeout(state.timeoutHandle);
    state.timeoutHandle = undefined;
  }

  private clearRetry(state: OutgoingTransfer): void {
    if (state.retryHandle !== undefined) clearTimeout(state.retryHandle);
    state.retryHandle = undefined;
  }

  private sendError(peerId: string, transferId: string, code: AssetTransferErrorCode, message: string): void {
    this.safeSend(peerId, { kind: "asset.error", transferId, code, message: message.slice(0, 500) });
  }

  private safeSend(peerId: string, message: AssetWireMessage): boolean {
    try {
      return this.options.sendToPeer(peerId, message);
    } catch (error) {
      this.emitError(
        message.kind === "asset.request" || message.kind === "asset.ack" ? "incoming" : "outgoing",
        peerId,
        message.transferId,
        message.kind === "asset.request" ? message.asset : undefined,
        "TRANSPORT_FAILED",
        "资源传输通道发送失败",
        false,
        error,
      );
      return false;
    }
  }

  private emitProgress(
    kind: "started" | "progress" | "completed" | "cancelled" | "backpressured",
    state: IncomingTransfer | OutgoingTransfer,
    completedChunks: number,
  ): void {
    this.options.onEvent?.({
      kind,
      direction: state.direction,
      peerId: state.peerId,
      transferId: state.transferId,
      asset: state.asset,
      completedChunks,
      chunkCount: state.chunkCount,
    });
  }

  private emitError(
    direction: AssetTransferDirection,
    peerId: string,
    transferId: string,
    asset: AssetDescriptorV1 | undefined,
    code: AssetTransferErrorCode | "FINALIZE_FAILED" | "PERSIST_FAILED" | "TRANSPORT_FAILED",
    message: string,
    remote: boolean,
    cause?: unknown,
  ): void {
    this.options.onEvent?.({ kind: "error", direction, peerId, transferId, asset, code, message, remote, cause });
  }

  private findIncoming(transferId: string, peerId?: string): IncomingTransfer | undefined {
    if (peerId !== undefined) return this.incoming.get(transferKey(peerId, transferId));
    return [...this.incoming.values()].find((state) => state.transferId === transferId);
  }

  private findOutgoing(transferId: string, peerId?: string): OutgoingTransfer | undefined {
    if (peerId !== undefined) return this.outgoing.get(transferKey(peerId, transferId));
    return [...this.outgoing.values()].find((state) => state.transferId === transferId);
  }

  private assertTransferWithinLimits(asset: AssetDescriptorV1): void {
    if (asset.byteLength > this.maxAssetBytes) {
      throw new AssetTransferLimitError(`资源超过传输上限 ${this.maxAssetBytes} 字节`);
    }
    if (chunkCountFor(asset) > 16_384) throw new AssetTransferLimitError("资源分块数量超过协议上限");
    if (asset.byteLength * 2 > this.maxBufferedBytes) {
      throw new AssetTransferLimitError("资源超过接收缓冲区预算");
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("AssetTransferManager 已停止");
  }

  private createTransferId(): string {
    return this.options.createTransferId?.() ?? crypto.randomUUID();
  }

  private get ttlMs(): number {
    return this.options.ttlMs ?? DEFAULT_TTL_MS;
  }

  private get backpressureRetryMs(): number {
    return this.options.backpressureRetryMs ?? DEFAULT_BACKPRESSURE_RETRY_MS;
  }

  private get maxIncomingTransfers(): number {
    return this.options.maxIncomingTransfers ?? DEFAULT_MAX_CONCURRENT;
  }

  private get maxOutgoingTransfers(): number {
    return this.options.maxOutgoingTransfers ?? DEFAULT_MAX_CONCURRENT;
  }

  private get maxAssetBytes(): number {
    return this.options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;
  }

  private get maxBufferedBytes(): number {
    return this.options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }
}

export class AssetTransferLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetTransferLimitError";
  }
}

function transferKey(peerId: string, transferId: string): string {
  return `${peerId}\u0000${transferId}`;
}

function chunkCountFor(asset: AssetDescriptorV1): number {
  return Math.ceil(asset.byteLength / ASSET_CHUNK_BYTES);
}

function expectedChunkLength(asset: AssetDescriptorV1, chunkIndex: number, chunkCount: number): number {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount) return -1;
  if (chunkIndex < chunkCount - 1) return ASSET_CHUNK_BYTES;
  return asset.byteLength - chunkIndex * ASSET_CHUNK_BYTES;
}

function missingIndexes(chunkCount: number, chunks: ReadonlyMap<number, Uint8Array>): number[] {
  const result: number[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    if (!chunks.has(index)) result.push(index);
  }
  return result;
}

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function sameDescriptor(left: AssetDescriptorV1, right: AssetDescriptorV1): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.assetId === right.assetId &&
    left.mediaType === right.mediaType &&
    left.byteLength === right.byteLength &&
    left.width === right.width &&
    left.height === right.height &&
    left.durationMs === right.durationMs;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) binary += String.fromCharCode(bytes[index]!);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

async function sha256Hex(chunks: readonly Uint8Array[], byteLength: number): Promise<string> {
  const complete = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    complete.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== byteLength) throw new Error("resource byte length mismatch");
  const digest = await crypto.subtle.digest("SHA-256", complete);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
