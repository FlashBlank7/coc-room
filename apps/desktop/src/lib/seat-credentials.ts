import { invoke } from "@tauri-apps/api/core";
import {
  clearWebDevelopmentSeatCredentialDatabase,
  isWebSeatCredentialPersistenceAvailable,
  WebDevelopmentSeatCredentialStore,
} from "./web-development-seat-credentials";

const VERIFIER_DOMAIN = new TextEncoder().encode("coc-room:seat-verifier:v1\0");
const PROOF_DOMAIN = new TextEncoder().encode("coc-room:seat-proof:v1\0");
const memorySecrets = new Map<string, string>();
const memoryVerifiers = new Map<string, Uint8Array>();
let webCredentialStore: WebDevelopmentSeatCredentialStore | undefined;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

export function randomSeatCredential(byteLength = 32): string {
  if (!Number.isInteger(byteLength) || byteLength < 24 || byteLength > 96) {
    throw new RangeError("席位凭据随机字节数必须在 24 到 96 之间");
  }
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/** Browser-development reset hook. It never deletes native credential-vault entries. */
export async function clearWebDevelopmentSeatCredentialData(): Promise<void> {
  if (isTauriRuntime()) return;
  memorySecrets.clear();
  memoryVerifiers.clear();
  webCredentialStore = undefined;
  await clearWebDevelopmentSeatCredentialDatabase();
}

export async function saveLocalSeatSecret(roomId: string, seatId: string, secret: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("save_room_seat_secret", { roomId, seatId, secret });
    return;
  }
  memorySecrets.set(credentialKey(roomId, seatId), secret);
  if (isWebSeatCredentialPersistenceAvailable()) await webStore().putSecret(roomId, seatId, secret);
}

/** Store only the derived verifier on the host; the invitation secret is discarded. */
export async function registerHostSeatVerifier(roomId: string, seatId: string, secret: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("register_room_seat_verifier", { roomId, seatId, secret });
    return;
  }
  const verifier = await deriveVerifier(secret);
  memoryVerifiers.set(credentialKey(roomId, seatId), verifier);
  if (isWebSeatCredentialPersistenceAvailable()) await webStore().putVerifier(roomId, seatId, verifier);
}

export async function computeSeatProof(roomId: string, seatId: string, nonce: string): Promise<string> {
  if (isTauriRuntime()) {
    return invoke<string>("compute_room_seat_proof", { roomId, seatId, nonce });
  }
  const key = credentialKey(roomId, seatId);
  const secret = memorySecrets.get(key)
    ?? (isWebSeatCredentialPersistenceAvailable() ? await webStore().getSecret(roomId, seatId) : undefined);
  if (!secret) throw new Error("本机没有该席位凭据");
  memorySecrets.set(key, secret);
  return computeProof(await deriveVerifier(secret), roomId, seatId, nonce);
}

export async function verifySeatProof(
  roomId: string,
  seatId: string,
  nonce: string,
  proof: string,
): Promise<boolean> {
  if (isTauriRuntime()) {
    return invoke<boolean>("verify_room_seat_proof", { roomId, seatId, nonce, suppliedProof: proof });
  }
  const key = credentialKey(roomId, seatId);
  const verifier = memoryVerifiers.get(key)
    ?? (isWebSeatCredentialPersistenceAvailable() ? await webStore().getVerifier(roomId, seatId) : undefined);
  if (!verifier) return false;
  memoryVerifiers.set(key, verifier);
  const expected = await computeProof(verifier, roomId, seatId, nonce);
  return constantTimeEqual(expected, proof);
}

async function deriveVerifier(secret: string): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, toArrayBuffer(VERIFIER_DOMAIN));
  return new Uint8Array(signature);
}

async function computeProof(
  verifier: Uint8Array,
  roomId: string,
  seatId: string,
  nonce: string,
): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    toArrayBuffer(verifier),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = concatBytes(
    PROOF_DOMAIN,
    lengthPrefixed(roomId),
    lengthPrefixed(seatId),
    lengthPrefixed(nonce),
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, toArrayBuffer(data));
  return bytesToHex(new Uint8Array(signature));
}

function lengthPrefixed(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > 0xffff) throw new Error("席位认证字段过长");
  const result = new Uint8Array(bytes.byteLength + 2);
  new DataView(result.buffer).setUint16(0, bytes.byteLength, false);
  result.set(bytes, 2);
  return result;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function credentialKey(roomId: string, seatId: string): string {
  return `${roomId}\0${seatId}`;
}

function webStore(): WebDevelopmentSeatCredentialStore {
  if (!isWebSeatCredentialPersistenceAvailable()) throw new Error("浏览器席位凭据持久化不可用");
  webCredentialStore ??= new WebDevelopmentSeatCredentialStore();
  return webCredentialStore;
}
