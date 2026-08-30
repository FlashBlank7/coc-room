import { describe, expect, it } from "vitest";
import {
  WebDevelopmentSeatCredentialStore,
  type WebSeatCredentialBackend,
} from "./web-development-seat-credentials";

type CredentialRecord = NonNullable<Awaited<ReturnType<WebSeatCredentialBackend["get"]>>>;

class MemoryCredentialBackend implements WebSeatCredentialBackend {
  readonly records = new Map<string, CredentialRecord>();

  async get(key: string) { return this.records.get(key); }
  async put(record: CredentialRecord) { this.records.set(record.key, structuredClone(record)); }
}

describe("browser development seat credential persistence", () => {
  it("restores a seat secret and host verifier after recreating the service", async () => {
    const backend = new MemoryCredentialBackend();
    const firstPage = new WebDevelopmentSeatCredentialStore(backend);
    const verifier = Uint8Array.from({ length: 32 }, (_, index) => index);
    await firstPage.putSecret("room-browser", "seat-alice", "private-seat-secret");
    await firstPage.putVerifier("room-browser", "seat-alice", verifier);

    const reloadedPage = new WebDevelopmentSeatCredentialStore(backend);
    expect(await reloadedPage.getSecret("room-browser", "seat-alice")).toBe("private-seat-secret");
    expect(await reloadedPage.getVerifier("room-browser", "seat-alice")).toEqual(verifier);
    expect(await reloadedPage.getSecret("room-browser", "seat-bob")).toBeUndefined();
  });

  it("separates player secrets from host verifiers and rejects unsafe keys", async () => {
    const backend = new MemoryCredentialBackend();
    const store = new WebDevelopmentSeatCredentialStore(backend);
    await store.putSecret("room-browser", "seat-alice", "secret-value");
    expect(await store.getVerifier("room-browser", "seat-alice")).toBeUndefined();
    await expect(store.putSecret("room\0escape", "seat-alice", "secret-value")).rejects.toThrow(/room ID/);
  });
});
