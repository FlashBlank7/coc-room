import {
  relayPeerIdSchema,
  relayRoomIdSchema,
  roomInvitationPayloadV2Schema,
  type RoomInvitationPayloadV2,
} from "@coc-room/protocol";

export interface RoomInvitationV1 {
  version: 1;
  roomId: string;
  token: string;
  hostPeerId: string;
  relayUrl: string;
}

export type RoomInvitation = RoomInvitationV1 | RoomInvitationPayloadV2;

const PREFIX_V1 = "coc-room:v1:";
const PREFIX_V2 = "coc-room:v2:";

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

export function encodeInvitation(invitation: RoomInvitationV1): string {
  return `${PREFIX_V1}${toBase64Url(JSON.stringify(validateInvitationV1(invitation)))}`;
}

export function encodeInvitationV2(invitation: RoomInvitationPayloadV2): string {
  const parsed = validateInvitationV2(invitation);
  return `${PREFIX_V2}${toBase64Url(JSON.stringify(parsed))}`;
}

export function decodeInvitation(value: string): RoomInvitation {
  const input = value.trim();
  const version = input.startsWith(PREFIX_V1) ? 1 : input.startsWith(PREFIX_V2) ? 2 : undefined;
  if (version === undefined) {
    throw new Error("邀请串格式不正确");
  }
  if (input.length > 8_192) throw new Error("邀请串过长");
  let parsed: unknown;
  try {
    const prefix = version === 1 ? PREFIX_V1 : PREFIX_V2;
    parsed = JSON.parse(fromBase64Url(input.slice(prefix.length)));
  } catch {
    throw new Error("邀请串无法解析");
  }
  if (version === 2) return validateInvitationV2(parsed);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).version !== 1 ||
    typeof (parsed as Record<string, unknown>).roomId !== "string" ||
    typeof (parsed as Record<string, unknown>).token !== "string" ||
    typeof (parsed as Record<string, unknown>).hostPeerId !== "string" ||
    typeof (parsed as Record<string, unknown>).relayUrl !== "string"
  ) {
    throw new Error("邀请串缺少必要字段");
  }
  return validateInvitationV1(parsed as RoomInvitationV1);
}

export function randomToken(byteLength = 24): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateInvitationV1(invitation: RoomInvitationV1): RoomInvitationV1 {
  if (!relayRoomIdSchema.safeParse(invitation.roomId).success) {
    throw new Error("邀请串中的房间 ID 无效");
  }
  if (!relayPeerIdSchema.safeParse(invitation.hostPeerId).success) {
    throw new Error("邀请串中的房主 ID 无效");
  }
  if (invitation.token.length < 20 || invitation.token.length > 128) {
    throw new Error("邀请串中的入房令牌无效");
  }
  if (invitation.relayUrl.length > 2_048) throw new Error("邀请串中的中继地址过长");

  let url: URL;
  try {
    url = new URL(invitation.relayUrl);
  } catch {
    throw new Error("邀请串中的中继地址无效");
  }
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && localHost)) {
    throw new Error("公网邀请必须使用 WSS 中继（仅本机允许 WS）");
  }
  if (url.username || url.password) throw new Error("中继地址不得包含 URL 凭据");
  return invitation;
}

function validateInvitationV2(candidate: unknown): RoomInvitationPayloadV2 {
  const result = roomInvitationPayloadV2Schema.safeParse(candidate);
  if (!result.success) throw new Error("V2 邀请串缺少必要字段或字段无效");
  validateRelayUrl(result.data.relayUrl);
  return result.data;
}

function validateRelayUrl(relayUrl: string): void {
  if (relayUrl.length > 2_048) throw new Error("邀请串中的中继地址过长");
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    throw new Error("邀请串中的中继地址无效");
  }
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && localHost)) {
    throw new Error("公网邀请必须使用 WSS 中继（仅本机允许 WS）");
  }
  if (url.username || url.password) throw new Error("中继地址不得包含 URL 凭据");
}
