import { z } from "zod";

import { roomCommandSchema, roomEventSchema } from "./room.js";
import {
  assetDescriptorV1Schema,
  roomCommandV2Schema,
  roomEventViewV2Schema,
  seatV2Schema,
} from "./room-v2.js";
import { syncChunkSchema } from "../sync.js";

const requestIdSchema = z.string().min(1).max(128).optional();
const presenceStatusSchema = z.enum(["online", "away"]);
export const MAX_RELAY_FRAME_BYTES = 64 * 1024;
export const SAFE_RELAY_FRAME_BYTES = 60 * 1024;
export const RELAY_FRAGMENT_BYTES = 32 * 1024;
export const MAX_RELAY_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_RELAY_FRAGMENT_COUNT = MAX_RELAY_MESSAGE_BYTES / RELAY_FRAGMENT_BYTES;
export const MAX_RELAY_FRAGMENT_BASE64_CHARS = 4 * Math.ceil(RELAY_FRAGMENT_BYTES / 3);
export const relayRoomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
export const relayPeerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const relayDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Array.from(value).length <= 40, "must contain at most 40 code points");
const transferIdSchema = z.string().uuid();
const seatIdWireSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
const seatProofSchema = z.string().regex(/^[0-9a-f]{64}$/);
const seatNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
export const ASSET_CHUNK_BYTES = 24 * 1024;
export const MAX_ASSET_CHUNK_BASE64_CHARS = 4 * Math.ceil(ASSET_CHUNK_BYTES / 3);

export const publicPeerSchema = z
  .object({
    peerId: relayPeerIdSchema,
    displayName: relayDisplayNameSchema,
    role: z.enum(["host", "player"]),
    status: presenceStatusSchema,
  })
  .strict();

export const relayCreateRoomRequestSchema = z
  .object({ hostPeerId: relayPeerIdSchema })
  .strict();

export const relayCreateRoomResponseSchema = z
  .object({
    protocolVersion: z.literal(1),
    roomId: relayRoomIdSchema,
    hostPeerId: relayPeerIdSchema,
    hostToken: z.string().min(20).max(128),
    joinToken: z.string().min(20).max(128),
    websocketUrl: z.string().url(),
  })
  .strict()
  .refine((value) => value.hostToken !== value.joinToken, {
    message: "hostToken and joinToken must differ",
  });

const rtcDescriptionSchema = z
  .object({
    type: z.enum(["offer", "answer", "pranswer", "rollback"]),
    sdp: z.string().max(1_000_000).optional(),
  })
  .strict();

const rtcCandidateSchema = z
  .object({
    candidate: z.string().max(16_000),
    sdpMid: z.string().max(256).nullable().optional(),
    sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .strict();

export const webRtcSignalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offer"), description: rtcDescriptionSchema }).strict(),
  z.object({ type: z.literal("answer"), description: rtcDescriptionSchema }).strict(),
  z.object({ type: z.literal("candidate"), candidate: rtcCandidateSchema }).strict(),
]);

/** Application payload carried by either DataChannel or Worker relay. */
export const peerMessageSchema = z.union([
  z.object({ kind: z.literal("command"), command: roomCommandSchema }).strict(),
  z.object({ kind: z.literal("event"), event: roomEventSchema }).strict(),
  z
    .object({
      kind: z.literal("sync.request"),
      requestId: z.string().uuid(),
      lastSequence: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal("sync.chunk"), chunk: syncChunkSchema }).strict(),
  z
    .object({
      kind: z.literal("sync.ack"),
      requestId: z.string().uuid(),
      transferId: z.string().uuid(),
      pageIndex: z.number().int().nonnegative(),
      lastSequence: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({
    kind: z.literal("v2.auth.hello"),
    protocolVersion: z.literal(2),
    seatId: seatIdWireSchema,
    credentialVersion: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal("v2.auth.challenge"),
    protocolVersion: z.literal(2),
    seatId: seatIdWireSchema,
    nonce: seatNonceSchema,
  }).strict(),
  z.object({
    kind: z.literal("v2.auth.proof"),
    protocolVersion: z.literal(2),
    seatId: seatIdWireSchema,
    nonce: seatNonceSchema,
    proof: seatProofSchema,
  }).strict(),
  z.object({
    kind: z.literal("v2.auth.result"),
    protocolVersion: z.literal(2),
    ok: z.boolean(),
    seat: seatV2Schema.optional(),
    message: z.string().max(500).optional(),
  }).strict().superRefine((result, context) => {
    if (result.ok !== (result.seat !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["seat"],
        message: "successful authentication requires a seat and failure must not include one",
      });
    }
  }),
  z.object({ kind: z.literal("v2.command"), command: roomCommandV2Schema }).strict(),
  z.object({
    kind: z.literal("v2.command.result"),
    protocolVersion: z.literal(2),
    commandId: z.string().uuid(),
    ok: z.boolean(),
    eventId: z.string().uuid().optional(),
    sequence: z.number().int().positive().optional(),
    code: z.enum(["FORBIDDEN", "CONFLICT", "INVALID", "PAUSED", "INTERNAL"]).optional(),
    message: z.string().max(1_000).optional(),
  }).strict().superRefine((result, context) => {
    if (result.ok && (result.eventId === undefined || result.sequence === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "successful command result requires event identity" });
    }
    if (!result.ok && result.message === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["message"], message: "rejected command requires a message" });
    }
  }),
  z.object({ kind: z.literal("v2.event"), view: roomEventViewV2Schema }).strict(),
  z.object({
    kind: z.literal("v2.sync.request"),
    requestId: z.string().uuid(),
    lastSequence: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("v2.sync.page"),
    requestId: z.string().uuid(),
    pageIndex: z.number().int().nonnegative(),
    pageCount: z.number().int().positive().max(100_000),
    views: z.array(roomEventViewV2Schema).max(500),
  }).strict().superRefine((page, context) => {
    if (page.pageIndex >= page.pageCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pageIndex"],
        message: "pageIndex must be less than pageCount",
      });
    }
  }),
  z.object({
    kind: z.literal("v2.sync.ack"),
    requestId: z.string().uuid(),
    pageIndex: z.number().int().nonnegative(),
    lastSequence: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("asset.request"),
    transferId: transferIdSchema,
    asset: assetDescriptorV1Schema,
    missingChunkIndexes: z.array(z.number().int().nonnegative()).max(16_384).optional(),
  }).strict(),
  z.object({
    kind: z.literal("asset.chunk"),
    transferId: transferIdSchema,
    assetId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    chunkIndex: z.number().int().nonnegative().max(16_383),
    chunkCount: z.number().int().positive().max(16_384),
    data: z.string().max(MAX_ASSET_CHUNK_BASE64_CHARS).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }).strict().superRefine((chunk, context) => {
    if (chunk.chunkIndex >= chunk.chunkCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chunkIndex"],
        message: "chunkIndex must be less than chunkCount",
      });
    }
  }),
  z.object({
    kind: z.literal("asset.ack"),
    transferId: transferIdSchema,
    receivedThrough: z.number().int().nonnegative(),
  }).strict(),
  z.object({ kind: z.literal("asset.cancel"), transferId: transferIdSchema }).strict(),
  z.object({
    kind: z.literal("asset.ready"),
    asset: assetDescriptorV1Schema,
  }).strict(),
  z.object({
    kind: z.literal("asset.error"),
    transferId: transferIdSchema,
    code: z.enum(["FORBIDDEN", "NOT_FOUND", "INVALID", "LIMIT", "HASH_MISMATCH", "TIMEOUT"]),
    message: z.string().min(1).max(500),
  }).strict(),
  z.object({
    kind: z.literal("board.preview"),
    boardId: z.string().min(1).max(128),
    itemId: z.string().min(1).max(128).optional(),
    x: z.number().min(0).max(10_000),
    y: z.number().min(0).max(10_000),
    action: z.enum(["cursor", "drag", "ping"]),
  }).strict(),
  z.object({
    kind: z.literal("ai.job.request"),
    jobId: z.string().uuid(),
    task: z.enum(["character-draft", "npc-stats", "npc-dialogue"]),
    provider: z.enum(["deepseek", "codex"]),
    model: z.string().max(200),
    input: z.record(z.unknown()),
  }).strict(),
  z.object({
    kind: z.literal("ai.job.status"),
    jobId: z.string().uuid(),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    message: z.string().max(1_000),
    result: z.unknown().optional(),
  }).strict(),
]);

/**
 * A transport-only fragment used when a peer message cannot fit safely in one
 * Worker relay frame. RoomTransport consumes these before RoomSession sees them.
 */
export const relayFragmentSchema = z
  .object({
    kind: z.literal("transport.fragment"),
    transferId: z.string().uuid(),
    chunkIndex: z.number().int().nonnegative().max(MAX_RELAY_FRAGMENT_COUNT - 1),
    chunkCount: z.number().int().positive().max(MAX_RELAY_FRAGMENT_COUNT),
    messageBytes: z.number().int().positive().max(MAX_RELAY_MESSAGE_BYTES),
    payloadEncoding: z.literal("base64-json-utf8"),
    checksum: z.string().regex(/^[0-9a-f]{8}$/),
    data: z
      .string()
      .min(4)
      .max(MAX_RELAY_FRAGMENT_BASE64_CHARS)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict()
  .superRefine((fragment, context) => {
    if (fragment.chunkIndex >= fragment.chunkCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chunkIndex"],
        message: "chunkIndex must be less than chunkCount",
      });
    }
    if (fragment.chunkCount !== Math.ceil(fragment.messageBytes / RELAY_FRAGMENT_BYTES)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chunkCount"],
        message: "chunkCount does not match messageBytes",
      });
    }
  });

export const relayPayloadSchema = z.union([peerMessageSchema, relayFragmentSchema]);

export const relayClientEnvelopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("join"),
      protocolVersion: z.literal(1),
      roomId: relayRoomIdSchema,
      token: z.string().min(20).max(128),
      peerId: relayPeerIdSchema,
      displayName: relayDisplayNameSchema,
      role: z.enum(["host", "player"]),
      requestId: requestIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("presence"),
      status: presenceStatusSchema,
      requestId: requestIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("signal"),
      targetPeerId: relayPeerIdSchema,
      data: webRtcSignalSchema,
      requestId: requestIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("relay"),
      targetPeerId: relayPeerIdSchema,
      payload: relayPayloadSchema,
      requestId: requestIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("leave"), requestId: requestIdSchema }).strict(),
]);

const errorCodeSchema = z.enum([
  "AUTH_REQUIRED",
  "BINARY_UNSUPPORTED",
  "FRAME_TOO_LARGE",
  "HOST_EXISTS",
  "HOST_PEER_ID_MISMATCH",
  "INVALID_MESSAGE",
  "INVALID_TOKEN",
  "NOT_FOUND",
  "PEER_EXISTS",
  "PEER_ID_RESERVED",
  "ROOM_FULL",
  "TARGET_NOT_FOUND",
  "TOPOLOGY_VIOLATION",
]);

export const relayServerEnvelopeSchema = z.union([
  z
    .object({
      kind: z.literal("ready"),
      protocolVersion: z.literal(1),
      ok: z.literal(true),
      roomId: relayRoomIdSchema,
      self: publicPeerSchema,
      peers: z.array(publicPeerSchema).max(8),
      requestId: requestIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("presence"),
      protocolVersion: z.literal(1),
      action: z.enum(["joined", "updated"]),
      peer: publicPeerSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("presence"),
      protocolVersion: z.literal(1),
      action: z.literal("left"),
      peer: z.object({ peerId: relayPeerIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("signal"),
      protocolVersion: z.literal(1),
      fromPeerId: relayPeerIdSchema,
      data: webRtcSignalSchema,
      requestId: requestIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("relay"),
      protocolVersion: z.literal(1),
      fromPeerId: relayPeerIdSchema,
      payload: relayPayloadSchema,
      requestId: requestIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      protocolVersion: z.literal(1),
      code: errorCodeSchema,
      message: z.string().min(1).max(500),
      requestId: requestIdSchema,
    })
    .strict(),
]);

export type PublicPeerV1 = z.infer<typeof publicPeerSchema>;
export type RelayCreateRoomRequestV1 = z.infer<typeof relayCreateRoomRequestSchema>;
export type RelayCreateRoomResponseV1 = z.infer<typeof relayCreateRoomResponseSchema>;
export type WebRtcSignalV1 = z.infer<typeof webRtcSignalSchema>;
export type PeerMessageV1 = z.infer<typeof peerMessageSchema>;
export type PeerMessage = PeerMessageV1;
export type RelayFragmentV1 = z.infer<typeof relayFragmentSchema>;
export type RelayPayloadV1 = z.infer<typeof relayPayloadSchema>;
export type RelayClientEnvelopeV1 = z.infer<typeof relayClientEnvelopeSchema>;
export type RelayServerEnvelopeV1 = z.infer<typeof relayServerEnvelopeSchema>;
