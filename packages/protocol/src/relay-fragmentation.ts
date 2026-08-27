import {
  MAX_RELAY_FRAGMENT_COUNT,
  MAX_RELAY_MESSAGE_BYTES,
  RELAY_FRAGMENT_BYTES,
  peerMessageSchema,
  relayFragmentSchema,
  type PeerMessageV1,
  type RelayFragmentV1,
} from "./schemas/relay.js";

export const DEFAULT_RELAY_TRANSFER_TTL_MS = 120_000;
export const DEFAULT_MAX_RELAY_INFLIGHT_TRANSFERS = 16;
export const DEFAULT_MAX_RELAY_BUFFERED_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_COMPLETED_RELAY_TRANSFERS = 1_024;

export function createRelayFragments(
  candidate: PeerMessageV1,
  transferId: string,
): RelayFragmentV1[] {
  const message = peerMessageSchema.parse(candidate);
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  if (bytes.byteLength > MAX_RELAY_MESSAGE_BYTES) {
    throw new RangeError(
      `Relay message exceeds the ${MAX_RELAY_MESSAGE_BYTES}-byte transport limit`,
    );
  }

  const chunkCount = Math.ceil(bytes.byteLength / RELAY_FRAGMENT_BYTES);
  if (chunkCount < 1 || chunkCount > MAX_RELAY_FRAGMENT_COUNT) {
    throw new RangeError(`Relay message requires an invalid number of fragments: ${chunkCount}`);
  }
  const checksum = fnv1a32(bytes);

  return Array.from({ length: chunkCount }, (_, chunkIndex) => {
    const offset = chunkIndex * RELAY_FRAGMENT_BYTES;
    return relayFragmentSchema.parse({
      kind: "transport.fragment",
      transferId,
      chunkIndex,
      chunkCount,
      messageBytes: bytes.byteLength,
      payloadEncoding: "base64-json-utf8",
      checksum,
      data: encodeBase64(bytes.slice(offset, offset + RELAY_FRAGMENT_BYTES)),
    });
  });
}

export interface RelayFragmentReassemblerOptions {
  now?: () => number;
  transferTtlMs?: number;
  maxInflightTransfers?: number;
  maxBufferedBytes?: number;
  maxCompletedTransfers?: number;
}

interface PendingTransfer {
  readonly createdAt: number;
  readonly chunkCount: number;
  readonly messageBytes: number;
  readonly checksum: string;
  readonly chunks: Map<number, { encoded: string; bytes: Uint8Array }>;
  bufferedBytes: number;
}

/** Collects out-of-order relay fragments and returns each peer message at most once. */
export class RelayFragmentReassembler {
  private readonly pending = new Map<string, PendingTransfer>();
  private readonly completed = new Map<string, number>();
  private totalBufferedBytes = 0;
  private readonly now: () => number;
  private readonly transferTtlMs: number;
  private readonly maxInflightTransfers: number;
  private readonly maxBufferedBytes: number;
  private readonly maxCompletedTransfers: number;

  constructor(options: RelayFragmentReassemblerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.transferTtlMs = positiveInteger(options.transferTtlMs, DEFAULT_RELAY_TRANSFER_TTL_MS, "transferTtlMs");
    this.maxInflightTransfers = positiveInteger(
      options.maxInflightTransfers,
      DEFAULT_MAX_RELAY_INFLIGHT_TRANSFERS,
      "maxInflightTransfers",
    );
    this.maxBufferedBytes = positiveInteger(
      options.maxBufferedBytes,
      DEFAULT_MAX_RELAY_BUFFERED_BYTES,
      "maxBufferedBytes",
    );
    this.maxCompletedTransfers = positiveInteger(
      options.maxCompletedTransfers,
      DEFAULT_MAX_COMPLETED_RELAY_TRANSFERS,
      "maxCompletedTransfers",
    );
  }

  get inflightTransfers(): number {
    return this.pending.size;
  }

  get bufferedBytes(): number {
    return this.totalBufferedBytes;
  }

  add(fromPeerId: string, candidate: RelayFragmentV1): PeerMessageV1 | undefined {
    const fragment = relayFragmentSchema.parse(candidate);
    const now = this.now();
    this.prune(now);
    const key = transferKey(fromPeerId, fragment.transferId);
    if (this.completed.has(key)) return undefined;

    const decoded = decodeBase64(fragment.data);
    const expectedChunkBytes = fragment.chunkIndex === fragment.chunkCount - 1
      ? fragment.messageBytes - RELAY_FRAGMENT_BYTES * (fragment.chunkCount - 1)
      : RELAY_FRAGMENT_BYTES;
    if (decoded.byteLength !== expectedChunkBytes) {
      this.deletePending(key);
      throw new Error(
        `Relay fragment ${fragment.chunkIndex} has ${decoded.byteLength} bytes; expected ${expectedChunkBytes}`,
      );
    }

    let transfer = this.pending.get(key);
    if (transfer === undefined) {
      if (this.pending.size >= this.maxInflightTransfers) {
        throw new Error("Too many incomplete relay transfers");
      }
      transfer = {
        createdAt: now,
        chunkCount: fragment.chunkCount,
        messageBytes: fragment.messageBytes,
        checksum: fragment.checksum,
        chunks: new Map(),
        bufferedBytes: 0,
      };
      this.pending.set(key, transfer);
    } else if (
      transfer.chunkCount !== fragment.chunkCount ||
      transfer.messageBytes !== fragment.messageBytes ||
      transfer.checksum !== fragment.checksum
    ) {
      this.deletePending(key);
      throw new Error("Relay fragments contain mixed transfer metadata");
    }

    const duplicate = transfer.chunks.get(fragment.chunkIndex);
    if (duplicate !== undefined) {
      if (duplicate.encoded !== fragment.data) {
        this.deletePending(key);
        throw new Error(`Conflicting duplicate relay fragment ${fragment.chunkIndex}`);
      }
      return undefined;
    }

    if (this.totalBufferedBytes + decoded.byteLength > this.maxBufferedBytes) {
      if (transfer.chunks.size === 0) this.deletePending(key);
      throw new Error("Relay fragment buffer limit exceeded");
    }
    transfer.chunks.set(fragment.chunkIndex, { encoded: fragment.data, bytes: decoded });
    transfer.bufferedBytes += decoded.byteLength;
    this.totalBufferedBytes += decoded.byteLength;
    if (transfer.chunks.size !== transfer.chunkCount) return undefined;

    const bytes = assembleTransfer(transfer);
    this.deletePending(key);
    if (bytes.byteLength !== fragment.messageBytes || fnv1a32(bytes) !== fragment.checksum) {
      throw new Error("Relay transfer checksum mismatch");
    }

    let decodedMessage: unknown;
    try {
      decodedMessage = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      throw new Error("Relay transfer is not valid UTF-8 JSON", { cause: error });
    }
    const message = peerMessageSchema.parse(decodedMessage);
    this.completed.set(key, now + this.transferTtlMs);
    this.trimCompleted();
    return message;
  }

  clear(): void {
    this.pending.clear();
    this.completed.clear();
    this.totalBufferedBytes = 0;
  }

  private prune(now: number): void {
    for (const [key, transfer] of this.pending) {
      if (transfer.createdAt + this.transferTtlMs <= now) this.deletePending(key);
    }
    for (const [key, expiresAt] of this.completed) {
      if (expiresAt <= now) this.completed.delete(key);
    }
  }

  private trimCompleted(): void {
    while (this.completed.size > this.maxCompletedTransfers) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
  }

  private deletePending(key: string): void {
    const transfer = this.pending.get(key);
    if (transfer === undefined) return;
    this.totalBufferedBytes -= transfer.bufferedBytes;
    this.pending.delete(key);
  }
}

function assembleTransfer(transfer: PendingTransfer): Uint8Array {
  const assembled = new Uint8Array(transfer.messageBytes);
  let offset = 0;
  for (let index = 0; index < transfer.chunkCount; index += 1) {
    const chunk = transfer.chunks.get(index);
    if (chunk === undefined) throw new Error(`Missing relay fragment ${index}`);
    assembled.set(chunk.bytes, offset);
    offset += chunk.bytes.byteLength;
  }
  return assembled;
}

function transferKey(fromPeerId: string, transferId: string): string {
  return `${fromPeerId}\u0000${transferId}`;
}

function positiveInteger(candidate: number | undefined, fallback: number, name: string): number {
  const value = candidate ?? fallback;
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const block = (first << 16) | (second << 8) | third;
    result += BASE64_ALPHABET[(block >>> 18) & 63];
    result += BASE64_ALPHABET[(block >>> 12) & 63];
    result += hasSecond ? BASE64_ALPHABET[(block >>> 6) & 63] : "=";
    result += hasThird ? BASE64_ALPHABET[block & 63] : "=";
  }
  return result;
}

function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0) throw new Error("Relay fragment contains invalid base64");
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const first = BASE64_ALPHABET.indexOf(value[index] ?? "");
    const second = BASE64_ALPHABET.indexOf(value[index + 1] ?? "");
    const thirdCharacter = value[index + 2] ?? "";
    const fourthCharacter = value[index + 3] ?? "";
    const third = thirdCharacter === "=" ? 0 : BASE64_ALPHABET.indexOf(thirdCharacter);
    const fourth = fourthCharacter === "=" ? 0 : BASE64_ALPHABET.indexOf(fourthCharacter);
    if (first < 0 || second < 0 || third < 0 || fourth < 0) {
      throw new Error("Relay fragment contains invalid base64");
    }
    const block = (first << 18) | (second << 12) | (third << 6) | fourth;
    bytes.push((block >>> 16) & 0xff);
    if (thirdCharacter !== "=") bytes.push((block >>> 8) & 0xff);
    if (fourthCharacter !== "=") bytes.push(block & 0xff);
  }
  return Uint8Array.from(bytes);
}

function fnv1a32(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
