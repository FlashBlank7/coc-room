import {
  MAX_FRAME_BYTES,
  MAX_NICKNAME_CODEPOINTS,
  PEER_ID_PATTERN,
  PROTOCOL_VERSION,
} from "./constants";
import type {
  ClientMessage,
  ErrorCode,
  ErrorMessage,
  PeerAttachment,
  PublicPeer,
  ServerMessage,
} from "./types";

const textEncoder = new TextEncoder();

export function frameByteLength(frame: string | ArrayBuffer): number {
  return typeof frame === "string"
    ? textEncoder.encode(frame).byteLength
    : frame.byteLength;
}

export function parseClientMessage(frame: string): ClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(frame) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const kind = value.kind ?? value.type;
  if (typeof kind !== "string") {
    return undefined;
  }

  if (
    value.protocolVersion !== undefined &&
    value.protocolVersion !== PROTOCOL_VERSION
  ) {
    return undefined;
  }

  if (value.requestId !== undefined && !isRequestId(value.requestId)) {
    return undefined;
  }

  switch (kind) {
    case "join": {
      const displayName = value.displayName ?? value.nickname;
      if (
        !isToken(value.token) ||
        !isPeerId(value.peerId) ||
        !isNickname(displayName) ||
        (value.role !== "host" && value.role !== "player")
      ) {
        return undefined;
      }
      if (
        value.protocolVersion !== PROTOCOL_VERSION ||
        typeof value.roomId !== "string"
      ) {
        return undefined;
      }
      return {
        kind: "join",
        protocolVersion: PROTOCOL_VERSION,
        roomId: value.roomId,
        token: value.token,
        peerId: value.peerId,
        displayName,
        role: value.role,
        ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
      };
    }

    case "presence":
      if (value.status !== "online" && value.status !== "away") {
        return undefined;
      }
      return {
        kind: "presence",
        status: value.status,
        ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
      };

    case "signal": {
      const targetPeerId = value.targetPeerId ?? value.to;
      const data = "data" in value ? value.data : value.payload;
      if (!isPeerId(targetPeerId) || !("data" in value || "payload" in value)) {
        return undefined;
      }
      return {
        kind: "signal",
        targetPeerId,
        data,
        ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
      };
    }

    case "relay": {
      const targetPeerId = value.targetPeerId ?? value.to;
      if (!isPeerId(targetPeerId) || !("payload" in value)) {
        return undefined;
      }
      return {
        kind: "relay",
        targetPeerId,
        payload: value.payload,
        ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
      };
    }

    case "leave":
      return {
        kind: "leave",
        ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
      };

    default:
      return undefined;
  }
}

export function canRoute(
  sender: Pick<PeerAttachment, "peerId" | "role">,
  target: Pick<PeerAttachment, "peerId" | "role">,
): boolean {
  if (sender.peerId === target.peerId) {
    return false;
  }

  return sender.role === "host"
    ? target.role === "player"
    : target.role === "host";
}

export function publicPeer(peer: PeerAttachment): PublicPeer {
  return {
    peerId: peer.peerId,
    displayName: peer.displayName,
    role: peer.role,
    status: peer.status,
  };
}

export function makeError(
  code: ErrorCode,
  message: string,
  requestId?: string,
): ErrorMessage {
  return {
    kind: "error",
    protocolVersion: PROTOCOL_VERSION,
    code,
    message,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

export function serializeServerMessage(
  message: ServerMessage,
): string | undefined {
  const serialized = JSON.stringify(message);
  return frameByteLength(serialized) <= MAX_FRAME_BYTES ? serialized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPeerId(value: unknown): value is string {
  return typeof value === "string" && PEER_ID_PATTERN.test(value);
}

function isNickname(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Array.from(value).length <= MAX_NICKNAME_CODEPOINTS
  );
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 128;
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
