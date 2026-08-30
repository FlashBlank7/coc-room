import { describe, expect, it } from "vitest";
import type { ModulePackageV1 } from "@coc-room/protocol";
import {
  IndexedDbRepository,
  WEB_REPOSITORY_MIGRATIONS,
  WEB_REPOSITORY_SCHEMA_VERSION,
  type StoredValue,
  type TransactionMode,
  type WebRepositoryStorage,
  type WebRepositoryTransaction,
  type WebStoreName,
} from "./indexeddb-repository";
import type { RoomRecord } from "./repository";

describe("IndexedDbRepository", () => {
  it("declares contiguous, append-only schema migrations", () => {
    expect(WEB_REPOSITORY_MIGRATIONS.map(({ version }) => version)).toEqual([1, 2, 3]);
    expect(WEB_REPOSITORY_MIGRATIONS.at(-1)?.version).toBe(WEB_REPOSITORY_SCHEMA_VERSION);
    const stores = WEB_REPOSITORY_MIGRATIONS.flatMap(({ stores: migrationStores }) => migrationStores);
    expect(new Set(stores).size).toBe(stores.length);
  });

  it("survives repository recreation without sharing live object references", async () => {
    const storage = new TestWebStorage();
    const first = new IndexedDbRepository(storage);
    const room = roomRecord("room-web-refresh");
    const event = roomEvent(room.id);
    await first.saveRoom(room);
    await first.saveEvent(event);
    await first.setSetting("relayUrl", "ws://127.0.0.1:8787/v1/rooms/ws");

    const second = new IndexedDbRepository(storage);
    const rooms = await second.listRooms();
    rooms[0]!.name = "mutated read";
    expect((await second.listRooms())[0]).toMatchObject({ id: room.id, name: room.name, lastSeq: 1 });
    expect(await second.listEvents(room.id)).toEqual([event]);
    expect(await second.getSetting("relayUrl")).toBe("ws://127.0.0.1:8787/v1/rooms/ws");
  });

  it("persists module revisions and V2 redacted views across recreation", async () => {
    const storage = new TestWebStorage();
    const first = new IndexedDbRepository(storage);
    const revisionOne = modulePackage("module-web-refresh", 1, "2026-01-01T00:00:00.000Z");
    const revisionTwo = {
      ...revisionOne,
      revision: 2,
      metadata: { ...revisionOne.metadata, updatedAt: "2026-01-02T00:00:00.000Z" },
    };
    const room = { ...roomRecord("room-v2-web-refresh"), protocolVersion: 2 as const };
    await first.saveRoom(room);
    await first.saveModule({ package: revisionOne, sourceText: "one" });
    await first.saveModule({ package: revisionTwo, sourceText: "two" });
    await first.saveEventViewV2({
      view: "redacted",
      protocolVersion: 2,
      roomId: room.id,
      eventId: "50db420f-88c9-47d5-8d1a-622c0ca61a99",
      sequence: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
    });

    const second = new IndexedDbRepository(storage);
    expect((await second.getModule(revisionOne.moduleId))?.package.revision).toBe(2);
    expect((await second.listModules({ moduleId: revisionOne.moduleId, latestOnly: false }))
      .map(({ package: storedPackage }) => storedPackage.revision)).toEqual([2, 1]);
    const serialized = JSON.stringify(await second.listEventViewsV2(room.id));
    expect(serialized).not.toContain("chat.message");
    expect(serialized).not.toContain("secret payload");
  });

  it("restores an overwritten module draft without exposing it as a published module", async () => {
    const storage = new TestWebStorage();
    const first = new IndexedDbRepository(storage);
    const module = modulePackage("module-web-draft", 1, "2026-03-01T00:00:00.000Z");
    await first.saveModuleDraft({
      draftId: "active-editor",
      package: module,
      sourceText: "first source",
      sourceName: "scenario.md",
      warnings: ["first warning"],
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    module.metadata.title = "mutated input";
    await first.saveModuleDraft({
      draftId: "active-editor",
      package: {
        ...modulePackage("module-web-draft", 1, "2026-03-02T00:00:00.000Z"),
        overview: "recovered editor state",
      },
      sourceText: "updated source",
      sourceName: "scenario-v2.md",
      warnings: ["review NPC reference"],
      updatedAt: "2026-03-02T00:00:00.000Z",
    });

    const reopened = new IndexedDbRepository(storage);
    const restored = await reopened.getModuleDraft("active-editor");
    expect(restored).toMatchObject({
      draftId: "active-editor",
      sourceText: "updated source",
      sourceName: "scenario-v2.md",
      warnings: ["review NPC reference"],
      package: { overview: "recovered editor state" },
    });
    restored!.package.overview = "mutated read";
    expect((await reopened.getModuleDraft("active-editor"))?.package.overview).toBe("recovered editor state");
    expect(await reopened.listModules()).toEqual([]);

    await reopened.deleteModuleDraft("active-editor");
    expect(await new IndexedDbRepository(storage).getModuleDraft("active-editor")).toBeUndefined();
  });

  it("upgrades a version 2 database additively and preserves its existing records", async () => {
    const storage = new TestWebStorage(2);
    const beforeUpgrade = new IndexedDbRepository(storage);
    const room = roomRecord("room-before-web-v3");
    const module = modulePackage("module-before-web-v3", 1, "2026-02-01T00:00:00.000Z");
    await beforeUpgrade.saveRoom(room);
    await beforeUpgrade.saveModule({ package: module, sourceText: "preserved source" });

    storage.upgradeTo(WEB_REPOSITORY_SCHEMA_VERSION);
    const upgraded = new IndexedDbRepository(storage);
    expect(await upgraded.listRooms()).toEqual([room]);
    expect(await upgraded.getModule(module.moduleId)).toEqual({
      package: module,
      sourceText: "preserved source",
    });
    await upgraded.saveModuleDraft({
      draftId: "post-upgrade-draft",
      package: module,
      sourceText: "draft source",
      sourceName: "upgraded.md",
      warnings: [],
      updatedAt: "2026-02-02T00:00:00.000Z",
    });
    expect((await upgraded.listModuleDrafts()).map(({ draftId }) => draftId)).toEqual(["post-upgrade-draft"]);
  });

  it("physically removes room-scoped current records instead of retaining a mutation history", async () => {
    const storage = new TestWebStorage();
    const repository = new IndexedDbRepository(storage);
    const deleted = roomRecord("room-web-delete");
    const retained = roomRecord("room-web-retain");
    await repository.saveRoom(deleted);
    await repository.saveRoom(retained);
    await repository.saveEvent(roomEvent(deleted.id));

    await repository.deleteRoom(deleted.id);

    const reopened = new IndexedDbRepository(storage);
    expect((await reopened.listRooms()).map(({ id }) => id)).toEqual([retained.id]);
    expect(await reopened.listEvents(deleted.id)).toEqual([]);
    expect(storage.serialized()).not.toContain("secret payload");
  });

  it("keeps a failed write transaction atomic", async () => {
    const storage = new TestWebStorage();
    const repository = new IndexedDbRepository(storage);
    const room = roomRecord("room-web-atomic");
    await repository.saveRoom(room);
    await repository.saveEvent(roomEvent(room.id));

    await expect(repository.saveEvent({
      ...roomEvent(room.id),
      eventId: "c4db8daa-a105-4db0-b3fd-c599bad54d48",
    })).rejects.toThrow(/Sequence/);

    expect(await repository.listEvents(room.id)).toHaveLength(1);
  });
});

class TestWebStorage implements WebRepositoryStorage {
  private stores = new Map<WebStoreName, Map<string, unknown>>();

  constructor(version = WEB_REPOSITORY_SCHEMA_VERSION) {
    this.upgradeTo(version);
  }

  upgradeTo(version: number): void {
    for (const migration of WEB_REPOSITORY_MIGRATIONS) {
      if (migration.version > version) continue;
      for (const storeName of migration.stores) {
        if (!this.stores.has(storeName)) this.stores.set(storeName, new Map());
      }
    }
  }

  async transaction<T>(
    storeNames: WebStoreName[],
    mode: TransactionMode,
    operation: (transaction: WebRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    const working = mode === "readwrite" ? cloneStores(this.stores) : this.stores;
    const assertStore = (storeName: WebStoreName): Map<string, unknown> => {
      if (!storeNames.includes(storeName)) throw new Error(`Store ${storeName} was not opened by the transaction`);
      const store = working.get(storeName);
      if (!store) throw new Error(`Unknown store ${storeName}`);
      return store;
    };
    const transaction: WebRepositoryTransaction = {
      get: async <Value>(storeName: WebStoreName, key: string) => {
        const value = assertStore(storeName).get(key) as Value | undefined;
        return value === undefined ? undefined : structuredClone(value);
      },
      getAll: async <Value>(storeName: WebStoreName): Promise<Array<StoredValue<Value>>> =>
        [...assertStore(storeName)].map(([key, value]) => ({ key, value: structuredClone(value as Value) })),
      put: async <Value>(storeName: WebStoreName, key: string, value: Value) => {
        if (mode !== "readwrite") throw new Error("Readonly transaction");
        assertStore(storeName).set(key, structuredClone(value));
      },
      delete: async (storeName: WebStoreName, key: string) => {
        if (mode !== "readwrite") throw new Error("Readonly transaction");
        assertStore(storeName).delete(key);
      },
    };
    const result = await operation(transaction);
    if (mode === "readwrite") this.stores = working;
    return result;
  }

  close(): void {}

  serialized(): string {
    return JSON.stringify([...this.stores].map(([store, values]) => [store, [...values]]));
  }
}

function cloneStores(
  source: Map<WebStoreName, Map<string, unknown>>,
): Map<WebStoreName, Map<string, unknown>> {
  return new Map([...source].map(([storeName, values]) => [
    storeName,
    new Map([...values].map(([key, value]) => [key, structuredClone(value)])),
  ]));
}

function roomRecord(id: string): RoomRecord {
  return {
    id,
    name: "Web Test Room",
    localRole: "player",
    localPeerId: "peer-12345678",
    hostPeerId: "host-12345678",
    inviteToken: "token-12345678901234567890",
    relayUrl: "ws://127.0.0.1:8787/v1/rooms/ws",
    lastSeq: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function roomEvent(roomId: string) {
  return {
    protocolVersion: 1 as const,
    roomId,
    eventId: "dcd1bf4e-9c3f-447a-8e2d-dbb33b75e8a5",
    sequence: 1,
    sender: { peerId: "peer-12345678", displayName: "Investigator", role: "player" as const },
    occurredAt: "2026-01-01T00:00:00.000Z",
    type: "chat.message" as const,
    payload: { message: "secret payload", format: "plain" as const },
  };
}

function modulePackage(moduleId: string, revision: number, updatedAt: string): ModulePackageV1 {
  return {
    schemaVersion: 1,
    moduleId,
    revision,
    metadata: {
      title: moduleId,
      authors: [],
      language: "zh-CN",
      summary: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt,
    },
    overview: "",
    sourceDocuments: [],
    chapters: [],
    scenes: [],
    locations: [],
    npcs: [],
    clues: [],
    handouts: [],
    suggestedChecks: [],
    keeperNotes: [],
    relations: [],
    extensions: {},
  };
}
