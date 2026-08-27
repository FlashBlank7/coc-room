import { z } from "zod";

import { roomCommandSchema, roomEventSchema } from "./room.js";
import { syncChunkSchema } from "../sync.js";

const requestIdSchema = z.string().min(1).max(128).optional();
const presenceStatusSchema = z.enum(["online", "away"]);
export const relayRoomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
export const relayPeerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const relayDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Array.from(value).length <= 40, "must contain at most 40 code points");

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
export const peerMessageSchema = z.discriminatedUnion("kind", [
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
]);

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
      payload: peerMessageSchema,
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
      payload: peerMessageSchema,
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
export type RelayClientEnvelopeV1 = z.infer<typeof relayClientEnvelopeSchema>;
export type RelayServerEnvelopeV1 = z.infer<typeof relayServerEnvelopeSchema>;
