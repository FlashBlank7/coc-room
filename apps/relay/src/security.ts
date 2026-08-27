export function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

const JOIN_SECRET_DOMAIN = "coc-room-relay:v1:join-secret\0";
const ROOM_ID_DOMAIN = "coc-room-relay:v1:room-id\0";

export const DERIVED_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export async function deriveJoinSecret(hostToken: string): Promise<string> {
  return sha256Base64Url(`${JOIN_SECRET_DOMAIN}${hostToken}`);
}

export function formatJoinToken(
  hostPeerId: string,
  joinSecret: string,
): string {
  return `${hostPeerId}.${joinSecret}`;
}

export function parseJoinToken(
  joinToken: string,
): { hostPeerId: string; joinSecret: string } | undefined {
  const separator = joinToken.indexOf(".");
  if (separator <= 0 || separator !== joinToken.lastIndexOf(".")) {
    return undefined;
  }

  const hostPeerId = joinToken.slice(0, separator);
  const joinSecret = joinToken.slice(separator + 1);
  if (!DERIVED_SECRET_PATTERN.test(joinSecret)) {
    return undefined;
  }

  return { hostPeerId, joinSecret };
}

export async function deriveRoomId(joinToken: string): Promise<string> {
  return sha256Base64Url(`${ROOM_ID_DOMAIN}${joinToken}`);
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64Url(new Uint8Array(digest));
}

export function timingSafeStringEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return difference === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
