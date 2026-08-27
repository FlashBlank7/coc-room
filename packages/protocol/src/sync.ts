import { z } from "zod";

import { roomIdSchema } from "./schemas/common.js";
import type { RoomEventV1 } from "./schemas/room.js";
import { roomEventSchema } from "./schemas/room.js";

export const DEFAULT_SYNC_CHUNK_BYTES = 32 * 1024;
export const MAX_SYNC_CHUNKS = 10_000;

export const syncRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    type: z.literal("sync.request"),
    roomId: roomIdSchema,
    requestId: z.string().uuid(),
    lastSequence: z.number().int().nonnegative(),
  })
  .strict();

export const syncChunkSchema = z
  .object({
    protocolVersion: z.literal(1),
    type: z.literal("sync.chunk"),
    roomId: roomIdSchema,
    requestId: z.string().uuid(),
    transferId: z.string().uuid(),
    chunkIndex: z.number().int().nonnegative(),
    chunkCount: z.number().int().positive().max(MAX_SYNC_CHUNKS),
    payloadEncoding: z.literal("base64-json-utf8"),
    checksum: z.string().regex(/^[0-9a-f]{8}$/),
    data: z.string().max(128 * 1024),
  })
  .strict()
  .superRefine((chunk, context) => {
    if (chunk.chunkIndex >= chunk.chunkCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chunkIndex"],
        message: "chunkIndex must be less than chunkCount",
      });
    }
  });

export type SyncRequestV1 = z.infer<typeof syncRequestSchema>;
export type SyncChunkV1 = z.infer<typeof syncChunkSchema>;

export interface CreateSyncChunksOptions {
  readonly roomId: string;
  readonly requestId: string;
  readonly transferId?: string;
  readonly createTransferId?: () => string;
  readonly maxChunkBytes?: number;
}

export function createSyncChunks(
  candidateEvents: readonly RoomEventV1[],
  options: CreateSyncChunksOptions,
): SyncChunkV1[] {
  const events = roomEventSchema.array().parse(candidateEvents);
  for (const event of events) {
    if (event.roomId !== options.roomId) {
      throw new Error(`Event ${event.eventId} belongs to a different room`);
    }
  }

  const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_SYNC_CHUNK_BYTES;
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 256 || maxChunkBytes > 64 * 1024) {
    throw new RangeError("maxChunkBytes must be an integer between 256 and 65536");
  }

  const transferId = options.transferId ?? options.createTransferId?.() ?? createUuid();
  const bytes = new TextEncoder().encode(JSON.stringify(events));
  const checksum = fnv1a32(bytes);
  const byteChunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += maxChunkBytes) {
    byteChunks.push(bytes.slice(offset, offset + maxChunkBytes));
  }
  if (byteChunks.length === 0) {
    byteChunks.push(new Uint8Array());
  }
  if (byteChunks.length > MAX_SYNC_CHUNKS) {
    throw new RangeError(`Synchronization payload exceeds ${MAX_SYNC_CHUNKS} chunks`);
  }

  return byteChunks.map((data, chunkIndex) =>
    syncChunkSchema.parse({
      protocolVersion: 1,
      type: "sync.chunk",
      roomId: options.roomId,
      requestId: options.requestId,
      transferId,
      chunkIndex,
      chunkCount: byteChunks.length,
      payloadEncoding: "base64-json-utf8",
      checksum,
      data: encodeBase64(data),
    }),
  );
}

export function assembleSyncChunks(candidateChunks: readonly SyncChunkV1[]): RoomEventV1[] {
  if (candidateChunks.length === 0) {
    throw new Error("At least one synchronization chunk is required");
  }
  const chunks = candidateChunks.map((chunk) => syncChunkSchema.parse(chunk));
  const first = chunks[0];
  if (first === undefined) {
    throw new Error("At least one synchronization chunk is required");
  }

  const byIndex = new Map<number, SyncChunkV1>();
  for (const chunk of chunks) {
    if (
      chunk.roomId !== first.roomId ||
      chunk.requestId !== first.requestId ||
      chunk.transferId !== first.transferId ||
      chunk.chunkCount !== first.chunkCount ||
      chunk.checksum !== first.checksum
    ) {
      throw new Error("Synchronization chunks contain mixed transfer metadata");
    }
    const duplicate = byIndex.get(chunk.chunkIndex);
    if (duplicate !== undefined && duplicate.data !== chunk.data) {
      throw new Error(`Conflicting duplicate synchronization chunk ${chunk.chunkIndex}`);
    }
    byIndex.set(chunk.chunkIndex, chunk);
  }

  if (byIndex.size !== first.chunkCount) {
    throw new Error(`Incomplete synchronization transfer: received ${byIndex.size}/${first.chunkCount} chunks`);
  }

  const parts: Uint8Array[] = [];
  for (let index = 0; index < first.chunkCount; index += 1) {
    const chunk = byIndex.get(index);
    if (chunk === undefined) {
      throw new Error(`Missing synchronization chunk ${index}`);
    }
    parts.push(decodeBase64(chunk.data));
  }
  const bytes = concatBytes(parts);
  if (fnv1a32(bytes) !== first.checksum) {
    throw new Error("Synchronization payload checksum mismatch");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("Synchronization payload is not valid UTF-8 JSON", { cause: error });
  }

  const events = roomEventSchema.array().parse(decoded);
  for (const event of events) {
    if (event.roomId !== first.roomId) {
      throw new Error(`Synchronized event ${event.eventId} belongs to a different room`);
    }
  }
  return events;
}

/** Collects an out-of-order transfer and returns events exactly once when complete. */
export class SyncChunkCollector {
  private chunks = new Map<number, SyncChunkV1>();
  private metadata?: Pick<SyncChunkV1, "roomId" | "requestId" | "transferId" | "chunkCount" | "checksum">;
  private completed = false;

  get receivedCount(): number {
    return this.chunks.size;
  }

  get isComplete(): boolean {
    return this.completed;
  }

  add(candidate: SyncChunkV1): RoomEventV1[] | undefined {
    const chunk = syncChunkSchema.parse(candidate);
    if (this.completed) {
      const existing = this.chunks.get(chunk.chunkIndex);
      if (existing !== undefined && existing.data === chunk.data) {
        return undefined;
      }
      throw new Error("Synchronization transfer has already completed");
    }

    if (this.metadata === undefined) {
      this.metadata = chunk;
    } else if (
      chunk.roomId !== this.metadata.roomId ||
      chunk.requestId !== this.metadata.requestId ||
      chunk.transferId !== this.metadata.transferId ||
      chunk.chunkCount !== this.metadata.chunkCount ||
      chunk.checksum !== this.metadata.checksum
    ) {
      throw new Error("Chunk does not belong to this synchronization transfer");
    }

    const existing = this.chunks.get(chunk.chunkIndex);
    if (existing !== undefined && existing.data !== chunk.data) {
      throw new Error(`Conflicting duplicate synchronization chunk ${chunk.chunkIndex}`);
    }
    this.chunks.set(chunk.chunkIndex, chunk);

    if (this.chunks.size !== chunk.chunkCount) {
      return undefined;
    }
    const events = assembleSyncChunks([...this.chunks.values()]);
    this.completed = true;
    return events;
  }
}

function createUuid(): string {
  if (globalThis.crypto?.randomUUID === undefined) {
    throw new Error("A Web Crypto implementation is required to generate transfer IDs");
  }
  return globalThis.crypto.randomUUID();
}

function fnv1a32(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const block = (first << 16) | (second << 8) | third;
    result += BASE64_ALPHABET[(block >>> 18) & 63];
    result += BASE64_ALPHABET[(block >>> 12) & 63];
    result += hasSecond ? BASE64_ALPHABET[(block >>> 6) & 63] : "=";
    result += hasThird ? BASE64_ALPHABET[block & 63] : "=";
  }
  return result;
}

function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Synchronization chunk contains invalid base64");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((value.length / 4) * 3 - padding);
  let outputIndex = 0;

  for (let index = 0; index < value.length; index += 4) {
    const first = BASE64_ALPHABET.indexOf(value[index] ?? "");
    const second = BASE64_ALPHABET.indexOf(value[index + 1] ?? "");
    const thirdCharacter = value[index + 2] ?? "=";
    const fourthCharacter = value[index + 3] ?? "=";
    const third = thirdCharacter === "=" ? 0 : BASE64_ALPHABET.indexOf(thirdCharacter);
    const fourth = fourthCharacter === "=" ? 0 : BASE64_ALPHABET.indexOf(fourthCharacter);
    const block = (first << 18) | (second << 12) | (third << 6) | fourth;
    if (outputIndex < bytes.length) bytes[outputIndex++] = (block >>> 16) & 0xff;
    if (outputIndex < bytes.length) bytes[outputIndex++] = (block >>> 8) & 0xff;
    if (outputIndex < bytes.length) bytes[outputIndex++] = block & 0xff;
  }
  return bytes;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
