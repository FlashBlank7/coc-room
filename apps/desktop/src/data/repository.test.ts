import { describe, expect, it } from "vitest";
import type { ModulePackageV1, RoomEventV2 } from "@coc-room/protocol";
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

  it("never rewrites a persisted room between V1 and V2", async () => {
    const repository = new MemoryRepository();
    const v1 = roomRecord("room-protocol-v1");
    const v2 = { ...roomRecord("room-protocol-v2"), protocolVersion: 2 as const };
    await repository.saveRoom(v1);
    await repository.saveRoom(v2);

    await expect(repository.saveRoom({ ...v1, protocolVersion: 2 })).rejects.toThrow(/不可原地改写/);
    await expect(repository.saveRoom({ ...v2, protocolVersion: 1 })).rejects.toThrow(/不可原地改写/);
    const saved = await repository.listRooms();
    expect(saved.find(({ id }) => id === v1.id)?.protocolVersion ?? 1).toBe(1);
    expect(saved.find(({ id }) => id === v2.id)?.protocolVersion).toBe(2);
  });

  it("deletes a room and all of its local events without touching other rooms", async () => {
    const repository = new MemoryRepository();
    const deletedRoom = roomRecord("room-delete-test");
    const retainedRoom = roomRecord("room-retain-test");
    const deletedEvent = {
      protocolVersion: 1 as const,
      roomId: deletedRoom.id,
      eventId: "4ca2bc32-9644-498d-acbb-9b9f8e4d5ac2",
      sequence: 1,
      sender: { peerId: "peer-12345678", displayName: "Storage smoke", role: "player" as const },
      occurredAt: "2026-01-01T00:00:00.000Z",
      type: "chat.message" as const,
      payload: { message: "throwaway", format: "plain" as const },
    };
    await repository.saveRoom(deletedRoom);
    await repository.saveRoom(retainedRoom);
    await repository.saveEvent(deletedEvent);

    await repository.deleteRoom(deletedRoom.id);

    expect((await repository.listRooms()).map((room) => room.id)).toEqual([retainedRoom.id]);
    expect(await repository.listEvents(deletedRoom.id)).toEqual([]);
    await expect(repository.saveEvent(deletedEvent)).rejects.toThrow(/saved before its events/);
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
    expect((await repository.listModules({ moduleId: revisionOne.moduleId, latestOnly: false }))
      .map((item) => [item.package.revision, item.sourceText])).toEqual([
      [2, "source v2"],
      [1, "source v1"],
    ]);
    expect(await repository.getModule(revisionOne.moduleId, 1)).toEqual({
      package: revisionOne,
      sourceText: "source v1",
    });
    expect((await repository.getModule(revisionOne.moduleId))?.package.revision).toBe(2);
  });

  it("deletes one module revision without deleting its remaining history", async () => {
    const repository = new MemoryRepository();
    const revisionOne = modulePackage("module-delete-revision", 1, "2026-01-01T00:00:00.000Z");
    const revisionTwo = {
      ...revisionOne,
      revision: 2,
      metadata: { ...revisionOne.metadata, updatedAt: "2026-01-02T00:00:00.000Z" },
    };
    await repository.saveModule({ package: revisionOne, sourceText: "one" });
    await repository.saveModule({ package: revisionTwo, sourceText: "two" });

    await repository.deleteModuleRevision(revisionOne.moduleId, 2);
    expect((await repository.getModule(revisionOne.moduleId))?.package.revision).toBe(1);
    expect(await repository.getModule(revisionOne.moduleId, 2)).toBeUndefined();

    await repository.deleteModule(revisionOne.moduleId);
    expect(await repository.listModules({ moduleId: revisionOne.moduleId, latestOnly: false })).toEqual([]);
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

  it("saves, overwrites, restores and deletes module drafts outside the published library", async () => {
    const repository = new MemoryRepository();
    const module = modulePackage("module-draft-test", 1, "2026-03-01T00:00:00.000Z");
    await repository.saveModuleDraft({
      draftId: "active-editor",
      package: module,
      sourceText: "first source",
      sourceName: "first.md",
      warnings: ["first warning"],
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    module.metadata.title = "mutated input";

    expect((await repository.getModuleDraft("active-editor"))?.package.metadata.title).toBe("module-draft-test");
    await repository.saveModuleDraft({
      draftId: "active-editor",
      package: {
        ...modulePackage("module-draft-test", 1, "2026-03-02T00:00:00.000Z"),
        overview: "recovered editor state",
      },
      sourceText: "updated source",
      sourceName: "updated.md",
      warnings: ["review clue reference"],
      updatedAt: "2026-03-02T00:00:00.000Z",
    });

    const restored = await repository.getModuleDraft("active-editor");
    expect(restored).toMatchObject({
      draftId: "active-editor",
      sourceText: "updated source",
      sourceName: "updated.md",
      warnings: ["review clue reference"],
      package: { overview: "recovered editor state" },
    });
    restored!.package.overview = "mutated read";
    restored!.warnings.push("mutated read");
    expect(await repository.getModuleDraft("active-editor")).toMatchObject({
      warnings: ["review clue reference"],
      package: { overview: "recovered editor state" },
    });
    expect(await repository.listModules()).toEqual([]);

    await repository.deleteModuleDraft("active-editor");
    expect(await repository.getModuleDraft("active-editor")).toBeUndefined();
    expect(await repository.listModuleDrafts()).toEqual([]);
  });

  it("persists an unauthorized V2 event only as a payload-free redacted cursor", async () => {
    const repository = new MemoryRepository();
    const room = { ...roomRecord("room-v2-redacted"), protocolVersion: 2 as const };
    await repository.saveRoom(room);
    const redacted = {
      view: "redacted" as const,
      protocolVersion: 2 as const,
      roomId: room.id,
      eventId: "904900ab-c0a6-4dc2-ada6-969d06cbb83d",
      sequence: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
    };

    expect(await repository.saveEventViewV2(redacted)).toBe("inserted");
    expect(await repository.saveEventViewV2(redacted)).toBe("duplicate");
    const serialized = JSON.stringify(await repository.listEventViewsV2(room.id));
    expect(serialized).not.toContain("chat.message");
    expect(serialized).not.toContain("诱饵秘密");
    expect(await repository.listAuthorityEventsV2(room.id)).toEqual([]);
  });

  it("allows a redacted V2 cursor to be upgraded once but never downgraded", async () => {
    const repository = new MemoryRepository();
    const room = { ...roomRecord("room-v2-upgrade"), protocolVersion: 2 as const };
    const event = roomEventV2(room.id);
    await repository.saveRoom(room);
    await repository.saveEventViewV2({
      view: "redacted",
      protocolVersion: 2,
      roomId: room.id,
      eventId: event.eventId,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
    });

    expect(await repository.saveEventViewV2({ view: "full", event })).toBe("upgraded");
    await expect(repository.saveEventViewV2({
      view: "redacted",
      protocolVersion: 2,
      roomId: room.id,
      eventId: event.eventId,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
    })).rejects.toThrow(/不能被修改或降级/);
  });

  it("keeps the V2 authority log host-only and idempotent", async () => {
    const repository = new MemoryRepository();
    const room = { ...roomRecord("room-v2-host"), protocolVersion: 2 as const, localRole: "host" as const };
    const event = roomEventV2(room.id);
    await repository.saveRoom(room);

    expect(await repository.saveAuthorityEventV2(event)).toBe(true);
    expect(await repository.saveAuthorityEventV2(event)).toBe(false);
    expect(await repository.listAuthorityEventsV2(room.id)).toEqual([event]);
    expect(await repository.listEventViewsV2(room.id)).toEqual([{ view: "full", event }]);
  });

  it("persists exact asset grants per stable seat without authorizing descriptor guesses", async () => {
    const repository = new MemoryRepository();
    const room = { ...roomRecord("room-v2-asset-grants"), protocolVersion: 2 as const, localRole: "host" as const };
    await repository.saveRoom(room);
    const asset = {
      schemaVersion: 1 as const,
      assetId: `sha256:${"a".repeat(64)}` as const,
      mediaType: "audio/mpeg" as const,
      byteLength: 12_345,
    };
    await repository.saveAssetGrantV2({
      roomId: room.id,
      seatId: "seat-alice",
      asset,
      grantedSequence: 7,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // Replayed sync pages are idempotent even if the observation time changes.
    await repository.saveAssetGrantV2({
      roomId: room.id,
      seatId: "seat-alice",
      asset,
      grantedSequence: 7,
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    expect(await repository.hasAssetGrantV2(room.id, "seat-alice", asset)).toBe(true);
    expect(await repository.hasAssetGrantV2(room.id, "seat-bob", asset)).toBe(false);
    expect(await repository.hasAssetGrantV2(room.id, "seat-alice", {
      ...asset,
      mediaType: "audio/ogg",
    })).toBe(false);
  });
});

function roomEventV2(roomId: string): RoomEventV2 {
  return {
    protocolVersion: 2,
    roomId,
    eventId: "904900ab-c0a6-4dc2-ada6-969d06cbb83d",
    sequence: 1,
    sender: {
      seatId: "seat-host",
      role: "host",
      displayName: "KP",
      peerId: "host-12345678",
      extensions: {},
    },
    occurredAt: "2026-01-01T00:00:00.000Z",
    audience: { kind: "seats", seatIds: ["seat-authorized"] },
    type: "chat.message",
    payload: { message: "诱饵秘密", format: "plain" },
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
