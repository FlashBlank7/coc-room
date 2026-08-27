export const PROTOCOL_VERSION = 1 as const;
export const MAX_ROOM_PEERS = 8;
export const MAX_PLAYERS = 7;
export const MAX_PENDING_SOCKETS = 16;
export const AUTHENTICATION_GRACE_PERIOD_MS = 15_000;
export const UNCLAIMED_ROOM_TTL_MS = 15 * 60 * 1_000;
export const EMPTY_ROOM_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_NICKNAME_CODEPOINTS = 40;

export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
export const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

export const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
} as const;
