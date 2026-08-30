const DATABASE_NAME = "coc-room-web-development-seat-credentials-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "credentials";
const activeDatabases = new Set<IDBDatabase>();

interface CredentialRecord {
  key: string;
  kind: "secret" | "verifier";
  roomId: string;
  seatId: string;
  value: string;
  updatedAt: string;
}

export interface WebSeatCredentialBackend {
  get(key: string): Promise<CredentialRecord | undefined>;
  put(record: CredentialRecord): Promise<void>;
}

/**
 * Persistence for Vite/browser development only. Values are origin-scoped in
 * a dedicated IndexedDB database, but are not protected by the OS credential
 * vault and must not be presented as equivalent to desktop secret storage.
 */
export class WebDevelopmentSeatCredentialStore {
  constructor(private readonly backend: WebSeatCredentialBackend = new IndexedDbSeatCredentialBackend()) {}

  putSecret(roomId: string, seatId: string, secret: string): Promise<void> {
    return this.put("secret", roomId, seatId, secret);
  }

  getSecret(roomId: string, seatId: string): Promise<string | undefined> {
    return this.get("secret", roomId, seatId);
  }

  putVerifier(roomId: string, seatId: string, verifier: Uint8Array): Promise<void> {
    return this.put("verifier", roomId, seatId, bytesToBase64Url(verifier));
  }

  async getVerifier(roomId: string, seatId: string): Promise<Uint8Array | undefined> {
    const value = await this.get("verifier", roomId, seatId);
    return value === undefined ? undefined : base64UrlToBytes(value);
  }

  private async put(kind: CredentialRecord["kind"], roomId: string, seatId: string, value: string): Promise<void> {
    validateIdentifier(roomId, "room ID");
    validateIdentifier(seatId, "seat ID");
    if (!value) throw new Error("浏览器席位凭据不能为空");
    await this.backend.put({
      key: credentialKey(kind, roomId, seatId),
      kind,
      roomId,
      seatId,
      value,
      updatedAt: new Date().toISOString(),
    });
  }

  private async get(kind: CredentialRecord["kind"], roomId: string, seatId: string): Promise<string | undefined> {
    validateIdentifier(roomId, "room ID");
    validateIdentifier(seatId, "seat ID");
    const record = await this.backend.get(credentialKey(kind, roomId, seatId));
    if (!record) return undefined;
    if (record.kind !== kind || record.roomId !== roomId || record.seatId !== seatId || !record.value) {
      throw new Error("浏览器席位凭据记录已损坏");
    }
    return record.value;
  }
}

export function isWebSeatCredentialPersistenceAvailable(): boolean {
  return typeof window !== "undefined"
    && window.__TAURI_INTERNALS__ === undefined
    && typeof indexedDB !== "undefined";
}

/** Deletes only origin-scoped browser development credentials. */
export async function clearWebDevelopmentSeatCredentialDatabase(): Promise<void> {
  if (typeof window === "undefined" || window.__TAURI_INTERNALS__ !== undefined || typeof indexedDB === "undefined") return;
  for (const database of activeDatabases) database.close();
  activeDatabases.clear();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("无法清除浏览器席位凭据库"));
    request.onblocked = () => reject(new Error("浏览器席位凭据库仍被其他标签页占用"));
  });
}

class IndexedDbSeatCredentialBackend implements WebSeatCredentialBackend {
  private databasePromise?: Promise<IDBDatabase>;

  async get(key: string): Promise<CredentialRecord | undefined> {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    const result = await requestResult<CredentialRecord | undefined>(request);
    await transactionDone(transaction);
    return result;
  }

  async put(record: CredentialRecord): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await transactionDone(transaction);
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        activeDatabases.add(database);
        database.onversionchange = () => {
          database.close();
          activeDatabases.delete(database);
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error("无法打开浏览器席位凭据库"));
      request.onblocked = () => reject(new Error("浏览器席位凭据库升级被其他标签页阻止"));
    });
    return this.databasePromise;
  }
}

function credentialKey(kind: CredentialRecord["kind"], roomId: string, seatId: string): string {
  return `${kind}\0${roomId}\0${seatId}`;
}

function validateIdentifier(value: string, label: string): void {
  if (!value || value.length > 256 || value.includes("\0")) throw new Error(`浏览器席位凭据 ${label} 无效`);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("浏览器席位校验器编码无效");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try { binary = atob(padded); } catch { throw new Error("浏览器席位校验器编码无效"); }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("浏览器席位凭据库请求失败"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("浏览器席位凭据库事务失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("浏览器席位凭据库事务已中止"));
  });
}
