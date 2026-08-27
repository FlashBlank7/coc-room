import type { PROTOCOL_VERSION } from "./constants";

export interface Env {
  ROOMS: DurableObjectNamespace;
}

export type PeerRole = "host" | "player";
export type PresenceStatus = "online" | "away";

export interface PublicPeer {
  peerId: string;
  displayName: string;
  role: PeerRole;
  status: PresenceStatus;
}

export interface PendingAttachment {
  attachmentVersion: 1;
  authenticated: false;
  authenticationDeadlineAt: number;
}

export interface PeerAttachment extends PublicPeer {
  attachmentVersion: 1;
  authenticated: true;
  joinedAt: number;
}

export type SocketAttachment = PendingAttachment | PeerAttachment;

interface ClientEnvelope {
  kind: string;
  protocolVersion?: typeof PROTOCOL_VERSION;
  requestId?: string;
}

export interface JoinMessage extends ClientEnvelope {
  kind: "join";
  protocolVersion: typeof PROTOCOL_VERSION;
  roomId: string;
  token: string;
  peerId: string;
  displayName: string;
  role: PeerRole;
}

export interface PresenceMessage extends ClientEnvelope {
  kind: "presence";
  status: PresenceStatus;
}

export interface SignalMessage extends ClientEnvelope {
  kind: "signal";
  targetPeerId: string;
  data: unknown;
}

export interface RelayMessage extends ClientEnvelope {
  kind: "relay";
  targetPeerId: string;
  payload: unknown;
}

export interface LeaveMessage extends ClientEnvelope {
  kind: "leave";
}

export type ClientMessage =
  | JoinMessage
  | PresenceMessage
  | SignalMessage
  | RelayMessage
  | LeaveMessage;

export type ErrorCode =
  | "AUTH_REQUIRED"
  | "BINARY_UNSUPPORTED"
  | "FRAME_TOO_LARGE"
  | "HOST_EXISTS"
  | "HOST_PEER_ID_MISMATCH"
  | "INVALID_MESSAGE"
  | "INVALID_TOKEN"
  | "NOT_FOUND"
  | "PEER_EXISTS"
  | "PEER_ID_RESERVED"
  | "ROOM_FULL"
  | "TARGET_NOT_FOUND"
  | "TOPOLOGY_VIOLATION";

export interface ErrorMessage {
  kind: "error";
  protocolVersion: typeof PROTOCOL_VERSION;
  code: ErrorCode;
  message: string;
  requestId?: string;
}

export interface ReadyMessage {
  kind: "ready";
  protocolVersion: typeof PROTOCOL_VERSION;
  ok: true;
  roomId: string;
  self: PublicPeer;
  peers: PublicPeer[];
  requestId?: string;
}

export interface PresenceEvent {
  kind: "presence";
  protocolVersion: typeof PROTOCOL_VERSION;
  action: "joined" | "updated" | "left";
  peer: PublicPeer | { peerId: string };
}

export interface SignalEvent {
  kind: "signal";
  protocolVersion: typeof PROTOCOL_VERSION;
  fromPeerId: string;
  data: unknown;
  requestId?: string;
}

export interface RelayEvent {
  kind: "relay";
  protocolVersion: typeof PROTOCOL_VERSION;
  fromPeerId: string;
  payload: unknown;
  requestId?: string;
}

export type ServerMessage =
  | ErrorMessage
  | ReadyMessage
  | PresenceEvent
  | SignalEvent
  | RelayEvent;

export interface StoredRoomMetadata extends Record<string, SqlStorageValue> {
  room_id: string;
  host_peer_id: string;
  host_token_hash: string;
  join_token_hash: string;
  created_at: string;
  host_joined_at: string | null;
  empty_expires_at: number | null;
}

export interface CreateRoomRequest {
  hostPeerId: string;
}

export interface CreateRoomResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  roomId: string;
  hostPeerId: string;
  hostToken: string;
  joinToken: string;
  websocketUrl: string;
}
