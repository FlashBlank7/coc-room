import { createHash } from "node:crypto";
import { ASSET_CHUNK_BYTES, type AssetDescriptorV1 } from "@coc-room/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssetTransferManager,
  type AssetTransferEvent,
  type AssetWireMessage,
  type FinalizeReceivedAssetInput,
} from "./AssetTransferManager";

const managers: AssetTransferManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  vi.useRealTimers();
});

describe("AssetTransferManager", () => {
  it("accepts unordered chunks, ignores identical duplicates, ACKs the contiguous prefix and finalizes once", async () => {
    const bytes = patternedBytes(ASSET_CHUNK_BYTES * 2 + 17);
    const asset = descriptorFor(bytes);
    const sent: AssetWireMessage[] = [];
    const finalized: FinalizeReceivedAssetInput[] = [];
    const receiver = track(new AssetTransferManager({
      sendToPeer: (_peerId, message) => {
        sent.push(message);
        return true;
      },
      readLocalChunk: async () => new Uint8Array(),
      finalizeReceivedAsset: async (input) => {
        finalized.push(input);
      },
      canServeAsset: () => false,
      createTransferId: () => TRANSFER_A,
    }));

    receiver.requestAsset("host", asset);
    sent.length = 0;
    const chunks = chunksFor(bytes, asset, TRANSFER_A);

    await receiver.handleMessage("host", chunks[2]!);
    expect(sent).toEqual([]);
    await receiver.handleMessage("host", chunks[0]!);
    await receiver.handleMessage("host", chunks[0]!);
    await receiver.handleMessage("host", chunks[1]!);

    expect(sent.filter((message) => message.kind === "asset.ack").map((message) =>
      message.kind === "asset.ack" ? message.receivedThrough : -1
    )).toEqual([0, 0, 2]);
    expect(finalized).toHaveLength(1);
    expect(concatenate(finalized[0]!.chunks)).toEqual(bytes);
    expect(receiver.getSnapshot().incoming).toHaveLength(0);
    expect(receiver.getSnapshot().reservedIncomingBytes).toBe(0);
  });

  it("resumes by requesting only missing chunk indexes", async () => {
    const bytes = patternedBytes(ASSET_CHUNK_BYTES * 2 + 9);
    const asset = descriptorFor(bytes);
    const requesterMessages: AssetWireMessage[] = [];
    const senderMessages: AssetWireMessage[] = [];
    const finalized: FinalizeReceivedAssetInput[] = [];

    const receiver = track(new AssetTransferManager({
      sendToPeer: (_peerId, message) => {
        requesterMessages.push(message);
        return true;
      },
      readLocalChunk: async () => new Uint8Array(),
      finalizeReceivedAsset: async (input) => {
        finalized.push(input);
      },
      canServeAsset: () => false,
      createTransferId: () => TRANSFER_A,
    }));
    const sender = track(new AssetTransferManager({
      sendToPeer: (_peerId, message) => {
        senderMessages.push(message);
        return true;
      },
      readLocalChunk: async ({ offset, length }) => bytes.slice(offset, offset + length),
      finalizeReceivedAsset: async () => undefined,
      canServeAsset: () => true,
    }));

    receiver.requestAsset("host", asset);
    const initialRequest = requesterMessages.shift();
    expect(initialRequest?.kind).toBe("asset.request");
    await sender.handleMessage("player", initialRequest!);
    const initialChunks = senderMessages.filter(isChunk);
    expect(initialChunks).toHaveLength(3);

    await receiver.handleMessage("host", initialChunks[0]!);
    await receiver.handleMessage("host", initialChunks[2]!);
    requesterMessages.length = 0;
    expect(receiver.resumeIncoming(TRANSFER_A)).toBe(true);
    const resume = requesterMessages.find((message) => message.kind === "asset.request");
    expect(resume).toMatchObject({ kind: "asset.request", missingChunkIndexes: [1] });

    senderMessages.length = 0;
    await sender.handleMessage("player", resume!);
    expect(senderMessages.filter(isChunk).map((message) => message.chunkIndex)).toEqual([1]);
    await receiver.handleMessage("host", senderMessages.find(isChunk)!);

    expect(finalized).toHaveLength(1);
    expect(concatenate(finalized[0]!.chunks)).toEqual(bytes);
  });

  it("restores persisted chunks in a new manager and requests only restart gaps", async () => {
    const bytes = patternedBytes(ASSET_CHUNK_BYTES * 2 + 17);
    const asset = descriptorFor(bytes);
    const persisted: Array<{ chunkIndex: number; bytes: Uint8Array }> = [];
    const firstMessages: AssetWireMessage[] = [];
    const first = track(new AssetTransferManager({
      sendToPeer: (_peerId, message) => { firstMessages.push(message); return true; },
      readLocalChunk: async () => new Uint8Array(),
      finalizeReceivedAsset: async () => { throw new Error("first process must not finish"); },
      persistIncomingChunk: async ({ chunkIndex, bytes: chunk }) => {
        persisted.push({ chunkIndex, bytes: chunk.slice() });
      },
      canServeAsset: () => false,
    }));
    first.requestAsset("host-peer", asset, TRANSFER_A);
    const wireChunks = chunksFor(bytes, asset, TRANSFER_A);
    await first.handleMessage("host-peer", wireChunks[0]!);
    await first.handleMessage("host-peer", wireChunks[2]!);
    expect(firstMessages.some((message) => message.kind === "asset.ack")).toBe(true);
    first.dispose();

    const restartedMessages: AssetWireMessage[] = [];
    const finalized: FinalizeReceivedAssetInput[] = [];
    const restarted = track(new AssetTransferManager({
      sendToPeer: (_peerId, message) => { restartedMessages.push(message); return true; },
      readLocalChunk: async () => new Uint8Array(),
      finalizeReceivedAsset: async (input) => { finalized.push(input); },
      canServeAsset: () => false,
    }));
    restarted.restoreIncoming("host-peer", asset, TRANSFER_A, persisted);
    expect(restartedMessages).toContainEqual(expect.objectContaining({
      kind: "asset.request",
      transferId: TRANSFER_A,
      missingChunkIndexes: [1],
    }));
    await restarted.handleMessage("host-peer", wireChunks[1]!);
    expect(finalized).toHaveLength(1);
    expect(concatenate(finalized[0]!.chunks)).toEqual(bytes);
  });

  it("does not ACK a chunk until durable persistence succeeds", async () => {
    const bytes = patternedBytes(100);
    const asset = descriptorFor(bytes);
    const sent: AssetWireMessage[] = [];
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => { release = resolve; });
    const receiver = track(new AssetTransferManager({
      sendToPeer: (_peerId, message) => { sent.push(message); return true; },
      readLocalChunk: async () => new Uint8Array(),
      finalizeReceivedAsset: async () => undefined,
      persistIncomingChunk: async () => persisted,
      canServeAsset: () => false,
    }));
    receiver.requestAsset("host-peer", asset, TRANSFER_A);
    const handling = receiver.handleMessage("host-peer", chunksFor(bytes, asset, TRANSFER_A)[0]!);
    await Promise.resolve();
    expect(sent.some((message) => message.kind === "asset.ack")).toBe(false);
    release();
    await handling;
    expect(sent.some((message) => message.kind === "asset.ack")).toBe(true);
  });

  it("rejects a complete payload whose SHA-256 differs before finalization", async () => {
    const original = patternedBytes(ASSET_CHUNK_BYTES + 3);
    const corrupted = original.slice();
    corrupted[ASSET_CHUNK_BYTES] = corrupted[ASSET_CHUNK_BYTES]! ^ 0xff;
    const asset = descriptorFor(original);
    const sent: AssetWireMessage[] = [];
    const finalize = vi.fn(async () => undefined);
    const events: AssetTransferEvent[] = [];
    const receiver = track(new AssetTransferManager({
      sendToPeer: (_peerId, message) => {
        sent.push(message);
        return true;
      },
      readLocalChunk: async () => new Uint8Array(),
      finalizeReceivedAsset: finalize,
      canServeAsset: () => false,
      onEvent: (event) => events.push(event),
      createTransferId: () => TRANSFER_A,
    }));

    receiver.requestAsset("host", asset);
    sent.length = 0;
    for (const chunk of chunksFor(corrupted, asset, TRANSFER_A)) {
      await receiver.handleMessage("host", chunk);
    }

    expect(finalize).not.toHaveBeenCalled();
    expect(sent).toContainEqual(expect.objectContaining({ kind: "asset.error", code: "HASH_MISMATCH" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "error", code: "HASH_MISMATCH", remote: false }));
    expect(receiver.getSnapshot().incoming).toHaveLength(0);
  });

  it("never reads or serves an asset when the authorized-event grant is absent", async () => {
    const bytes = patternedBytes(31);
    const asset = descriptorFor(bytes);
    const sent: AssetWireMessage[] = [];
    const read = vi.fn(async () => bytes);
    const authorize = vi.fn(async () => false);
    const sender = track(new AssetTransferManager({
      sendToPeer: (_peerId, message) => {
        sent.push(message);
        return true;
      },
      readLocalChunk: read,
      finalizeReceivedAsset: async () => undefined,
      canServeAsset: authorize,
    }));

    await sender.handleMessage("unknown-seat-peer", {
      kind: "asset.request",
      transferId: TRANSFER_A,
      asset,
    });

    expect(authorize).toHaveBeenCalledWith("unknown-seat-peer", asset, { transferId: TRANSFER_A, resume: false });
    expect(read).not.toHaveBeenCalled();
    expect(sent).toEqual([
      expect.objectContaining({ kind: "asset.error", transferId: TRANSFER_A, code: "FORBIDDEN" }),
    ]);
    expect(sender.getSnapshot().outgoing).toHaveLength(0);
  });

  it("cancels both local and remote transfer state", async () => {
    const bytes = patternedBytes(ASSET_CHUNK_BYTES + 2);
    const asset = descriptorFor(bytes);
    const sent: AssetWireMessage[] = [];
    const receiver = track(new AssetTransferManager({
      sendToPeer: (_peerId, message) => {
        sent.push(message);
        return true;
      },
      readLocalChunk: async () => new Uint8Array(),
      finalizeReceivedAsset: async () => undefined,
      canServeAsset: () => false,
      createTransferId: () => TRANSFER_A,
    }));

    receiver.requestAsset("host", asset);
    expect(receiver.cancelTransfer(TRANSFER_A)).toBe(true);
    expect(sent.at(-1)).toEqual({ kind: "asset.cancel", transferId: TRANSFER_A });
    expect(receiver.getSnapshot().incoming).toHaveLength(0);

    let chunksWritable = false;
    const sender = track(new AssetTransferManager({
      sendToPeer: (_peerId, message) => message.kind !== "asset.chunk" || chunksWritable,
      readLocalChunk: async ({ offset, length }) => bytes.slice(offset, offset + length),
      finalizeReceivedAsset: async () => undefined,
      canServeAsset: () => true,
    }));
    await sender.handleMessage("player", { kind: "asset.request", transferId: TRANSFER_B, asset });
    expect(sender.getSnapshot().outgoing).toHaveLength(1);
    await sender.handleMessage("player", { kind: "asset.cancel", transferId: TRANSFER_B });
    chunksWritable = true;
    sender.notifyPeerWritable("player");
    expect(sender.getSnapshot().outgoing).toHaveLength(0);
  });

  it("retains one pending chunk under backpressure and resumes without rereading it", async () => {
    vi.useFakeTimers();
    const bytes = patternedBytes(111);
    const asset = descriptorFor(bytes);
    const delivered: AssetWireMessage[] = [];
    let writable = false;
    const read = vi.fn(async ({ offset, length }: { offset: number; length: number }) => bytes.slice(offset, offset + length));
    const sender = track(new AssetTransferManager({
      sendToPeer: (_peerId, message) => {
        if (message.kind === "asset.chunk" && !writable) return false;
        delivered.push(message);
        return true;
      },
      readLocalChunk: read,
      finalizeReceivedAsset: async () => undefined,
      canServeAsset: () => true,
      ttlMs: 10_000,
      backpressureRetryMs: 1_000,
    }));

    await sender.handleMessage("player", { kind: "asset.request", transferId: TRANSFER_A, asset });
    expect(sender.getSnapshot().outgoing[0]?.backpressured).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);

    writable = true;
    sender.notifyPeerWritable("player");
    await Promise.resolve();
    expect(delivered.filter(isChunk)).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(sender.getSnapshot().outgoing[0]?.backpressured).toBe(false);
  });

  it("times out a persistently backpressured transfer and releases its state", async () => {
    vi.useFakeTimers();
    const bytes = patternedBytes(99);
    const asset = descriptorFor(bytes);
    const delivered: AssetWireMessage[] = [];
    const events: AssetTransferEvent[] = [];
    const sender = track(new AssetTransferManager({
      sendToPeer: (_peerId, message) => {
        if (message.kind === "asset.chunk") return false;
        delivered.push(message);
        return true;
      },
      readLocalChunk: async ({ offset, length }) => bytes.slice(offset, offset + length),
      finalizeReceivedAsset: async () => undefined,
      canServeAsset: () => true,
      onEvent: (event) => events.push(event),
      ttlMs: 500,
      backpressureRetryMs: 50,
    }));

    await sender.handleMessage("player", { kind: "asset.request", transferId: TRANSFER_A, asset });
    await vi.advanceTimersByTimeAsync(501);

    expect(delivered).toContainEqual(expect.objectContaining({ kind: "asset.error", code: "TIMEOUT" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "error", code: "TIMEOUT" }));
    expect(sender.getSnapshot().outgoing).toHaveLength(0);
  });
});

const TRANSFER_A = "00000000-0000-4000-8000-000000000001";
const TRANSFER_B = "00000000-0000-4000-8000-000000000002";

function track(manager: AssetTransferManager): AssetTransferManager {
  managers.push(manager);
  return manager;
}

function patternedBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 31 + 17) % 256);
}

function descriptorFor(bytes: Uint8Array): AssetDescriptorV1 {
  return {
    schemaVersion: 1,
    assetId: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    mediaType: "application/octet-stream",
    byteLength: bytes.byteLength,
  };
}

function chunksFor(bytes: Uint8Array, asset: AssetDescriptorV1, transferId: string): Extract<AssetWireMessage, { kind: "asset.chunk" }>[] {
  const chunkCount = Math.ceil(bytes.byteLength / ASSET_CHUNK_BYTES);
  return Array.from({ length: chunkCount }, (_, chunkIndex) => ({
    kind: "asset.chunk" as const,
    transferId,
    assetId: asset.assetId,
    chunkIndex,
    chunkCount,
    data: Buffer.from(bytes.slice(chunkIndex * ASSET_CHUNK_BYTES, (chunkIndex + 1) * ASSET_CHUNK_BYTES)).toString("base64"),
  }));
}

function isChunk(message: AssetWireMessage): message is Extract<AssetWireMessage, { kind: "asset.chunk" }> {
  return message.kind === "asset.chunk";
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
