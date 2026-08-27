import { describe, expect, it } from "vitest";
import type { ModulePackageV1 } from "@coc-room/protocol";
import { MemoryRepository, type RoomRecord } from "./repository";

describe("MemoryRepository", () => {
  it("persists an event idempotently", async () => {
    const repository = new MemoryRepository();
    const event = {
      protocolVersion: 1 as const,
      roomId: "room-12345678",
      eventId: "2bf33a20-8982-4186-8bd5-6d0848449602",
      sequence: 1,
      sender: { peerId: "peer-12345678", displayName: "调查员", role: "player" as const },
      occurredAt: "2026-01-01T00:00:00.000Z",
      type: "chat.message" as const,
      payload: { message: "有人吗？", format: "plain" as const },
    };
    await repository.saveRoom(roomRecord(event.roomId));
    expect(await repository.saveEvent(event)).toBe(true);
    expect(await repository.saveEvent(event)).toBe(false);
    expect(await repository.listEvents(event.roomId)).toEqual([event]);
  });

  it("rejects reused IDs and occupied sequences with different content", async () => {
    const repository = new MemoryRepository();
    const event = {
      protocolVersion: 1 as const,
      roomId: "room-12345678",
      eventId: "2bf33a20-8982-4186-8bd5-6d0848449602",
      sequence: 1,
      sender: { peerId: "peer-12345678", displayName: "调查员", role: "player" as const },
      occurredAt: "2026-01-01T00:00:00.000Z",
      type: "chat.message" as const,
      payload: { message: "有人吗？", format: "plain" as const },
    };
    await repository.saveRoom(roomRecord(event.roomId));
    await repository.saveEvent(event);
    await expect(repository.saveEvent({ ...event, payload: { ...event.payload, message: "不同内容" } })).rejects.toThrow(/ID/);
    await expect(repository.saveEvent({ ...event, eventId: "fe8afcab-1bcc-490f-a71d-fc0bbb1321a2" })).rejects.toThrow(/序号/);
  });

  it("matches SQLite foreign-key semantics by rejecting events for unknown rooms", async () => {
    const repository = new MemoryRepository();
    await expect(repository.saveEvent({
      protocolVersion: 1,
      roomId: "missing-room",
      eventId: "37b7a077-6ee0-4796-9786-b2217db48993",
      sequence: 1,
      sender: { peerId: "peer-12345678", displayName: "Investigator", role: "player" },
      occurredAt: "2026-01-01T00:00:00.000Z",
      type: "chat.message",
      payload: { message: "hello", format: "plain" },
    })).rejects.toThrow(/saved before its events/);
  });

  it("does not lower the persisted sequence when a room reconnects", async () => {
    const repository = new MemoryRepository();
    await repository.saveRoom({ ...roomRecord("room-12345678"), lastSeq: 12 });
    await repository.saveRoom({
      ...roomRecord("room-12345678"),
      lastSeq: 0,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });

    expect(await repository.listRooms()).toEqual([
      expect.objectContaining({ lastSeq: 12, createdAt: "2026-01-01T00:00:00.000Z" }),
    ]);
  });

  it("enforces the same strictly increasing module revisions used by SQLite", async () => {
    const repository = new MemoryRepository();
    const revisionOne = modulePackage("module-revision-test", 1, "2026-01-01T00:00:00.000Z");
    await repository.saveModule({ package: revisionOne, sourceText: "source v1" });

    await expect(repository.saveModule({ package: revisionOne, sourceText: "duplicate" })).rejects.toThrow(/v1/);
    await expect(repository.saveModule({
      package: { ...revisionOne, revision: 2, metadata: { ...revisionOne.metadata, updatedAt: "2026-01-02T00:00:00.000Z" } },
      sourceText: "source v2",
    })).resolves.toBeUndefined();

    expect(await repository.listModules()).toEqual([
      expect.objectContaining({ package: expect.objectContaining({ revision: 2 }), sourceText: "source v2" }),
    ]);
  });

  it("orders memory-backed modules like SQLite and returns defensive copies", async () => {
    const repository = new MemoryRepository();
    const older = modulePackage("module-older-test", 1, "2026-01-01T00:00:00.000Z");
    const newer = modulePackage("module-newer-test", 1, "2026-02-01T00:00:00.000Z");
    await repository.saveModule({ package: older, sourceText: "older" });
    await repository.saveModule({ package: newer, sourceText: "newer" });

    const firstRead = await repository.listModules();
    expect(firstRead.map((item) => item.package.moduleId)).toEqual([newer.moduleId, older.moduleId]);
    firstRead[0]!.package.metadata.title = "mutated outside repository";
    expect((await repository.listModules())[0]?.package.metadata.title).toBe("module-newer-test");
  });
});

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

function roomRecord(id: string): RoomRecord {
  return {
    id,
    name: "Test Room",
    localRole: "player",
    localPeerId: "peer-12345678",
    hostPeerId: "host-12345678",
    inviteToken: "token-12345678901234567890",
    relayUrl: "wss://relay.example.test/v1/rooms/ws",
    lastSeq: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
