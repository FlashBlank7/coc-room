import {
  createSyncChunks,
  roomCommandSchema,
  roomEventSchema,
  type ParticipantV1,
  type RoomCommandV1,
  type RoomEventV1,
} from "@coc-room/protocol";
import { describe, expect, it } from "vitest";

import { MemoryRepository, type RoomRecord } from "../data/repository";
import {
  RoomSession,
  type RoomSessionTransport,
} from "./RoomSession";
import type { ConnectionPath, RoomWireMessage } from "./RoomTransport";

const ROOM_ID = "room_123456789012";
const HOST_PEER_ID = "host_peer_123456";
const PLAYER_PEER_ID = "player_peer_1234";

const HOST: ParticipantV1 = {
  peerId: HOST_PEER_ID,
  displayName: "Keeper",
  role: "host",
};

const PLAYER: ParticipantV1 = {
  peerId: PLAYER_PEER_ID,
  displayName: "Canonical Investigator",
  role: "player",
};

class FakeTransport implements RoomSessionTransport {
  onWireMessage?: (fromPeerId: string, message: RoomWireMessage) => void | Promise<void>;
  onPresence?: (participants: ParticipantV1[]) => void;
  onPathChange?: (peerId: string, path: ConnectionPath) => void;
  onError?: (message: string) => void;

  readonly sentToHost: RoomWireMessage[] = [];
  readonly sentToPeers: Array<{ peerId: string; message: RoomWireMessage }> = [];
  readonly broadcasts: RoomWireMessage[] = [];
  sendToHostResult = true;
  sendToPeerResult = true;

  constructor(private readonly operations: string[] = []) {}

  async start(): Promise<void> {}
  stop(): void {}

  sendToHost(message: RoomWireMessage): boolean {
    this.sentToHost.push(structuredClone(message));
    return this.sendToHostResult;
  }

  sendToPeer(peerId: string, message: RoomWireMessage): boolean {
    this.sentToPeers.push({ peerId, message: structuredClone(message) });
    return this.sendToPeerResult;
  }

  broadcast(message: RoomWireMessage): void {
    this.broadcasts.push(structuredClone(message));
    this.operations.push(`broadcast:${eventMessage(message)}`);
  }

  async deliver(fromPeerId: string, message: RoomWireMessage): Promise<void> {
    await this.onWireMessage?.(fromPeerId, structuredClone(message));
  }

  emitPresence(participants: ParticipantV1[]): void {
    this.onPresence?.(participants);
  }

  emitPath(peerId: string, path: ConnectionPath): void {
    this.onPathChange?.(peerId, path);
  }
}

class RecordingRepository extends MemoryRepository {
  failNextSave = false;

  constructor(private readonly operations: string[]) {
    super();
  }

  override async saveEvent(event: RoomEventV1): Promise<boolean> {
    if (this.failNextSave) {
      this.failNextSave = false;
      this.operations.push(`persist-failed:${chatText(event)}`);
      throw new Error("injected persistence failure");
    }
    const result = await super.saveEvent(event);
    this.operations.push(`persist:${chatText(event)}`);
    return result;
  }
}

class GatedRepository extends MemoryRepository {
  private gate?: Promise<void>;
  private releaseGate?: () => void;
  private markStarted?: () => void;
  saveStarted: Promise<void> = Promise.resolve();

  gateNextSave(): void {
    this.saveStarted = new Promise((resolve) => {
      this.markStarted = resolve;
    });
    this.gate = new Promise((resolve) => {
      this.releaseGate = resolve;
    });
  }

  releaseSave(): void {
    this.releaseGate?.();
  }

  override async saveEvent(event: RoomEventV1): Promise<boolean> {
    const gate = this.gate;
    if (gate) {
      this.gate = undefined;
      this.markStarted?.();
      await gate;
    }
    return super.saveEvent(event);
  }
}

class LifecycleRecordingRepository extends MemoryRepository {
  constructor(private readonly operations: string[]) {
    super();
  }

  override async saveRoom(room: RoomRecord): Promise<void> {
    this.operations.push("room:saved");
    await super.saveRoom(room);
  }

  override async saveEvent(event: RoomEventV1): Promise<boolean> {
    this.operations.push(`event:saved:${event.sequence}`);
    return super.saveEvent(event);
  }
}

class StartupSyncTransport extends FakeTransport {
  constructor(
    private readonly startupEvent: RoomEventV1,
    private readonly lifecycleOperations: string[],
  ) {
    super();
  }

  override async start(): Promise<void> {
    this.lifecycleOperations.push("transport:started");
    const [chunk] = createSyncChunks([this.startupEvent], {
      roomId: ROOM_ID,
      requestId: "ff9883e8-e594-43db-8419-5d70898b2ee2",
    });
    if (!chunk) throw new Error("expected a startup sync chunk");
    await this.deliver(HOST_PEER_ID, { kind: "sync.chunk", chunk });
  }
}

describe("RoomSession", () => {
  it("saves a newly joined room before startup sync events can be persisted", async () => {
    const operations: string[] = [];
    const repository = new LifecycleRecordingRepository(operations);
    const startupEvent = roomEventSchema.parse({
      protocolVersion: 1,
      roomId: ROOM_ID,
      eventId: "acee8cfb-c6d5-4c3f-b001-97e7df6faef6",
      sequence: 1,
      sender: HOST,
      occurredAt: "2026-08-27T00:00:01.000Z",
      type: "chat.message",
      payload: { message: "history", format: "plain" },
    });
    const transport = new StartupSyncTransport(startupEvent, operations);
    const session = createSession("player", repository, transport);

    await session.start();

    expect(operations).toEqual(["room:saved", "transport:started", "event:saved:1"]);
    expect(await repository.listEvents(ROOM_ID)).toEqual([startupEvent]);
    expect((await repository.listRooms()).find((room) => room.id === ROOM_ID)?.lastSeq).toBe(1);
  });

  it("persists before applying or broadcasting and rebuilds authority after a failed save", async () => {
    const operations: string[] = [];
    const repository = new RecordingRepository(operations);
    const transport = new FakeTransport(operations);
    const session = createSession("host", repository, transport);
    const snapshots: RoomEventV1[][] = [];
    session.onEvents = (events) => {
      snapshots.push(structuredClone(events));
      if (events.length > 0) operations.push(`replica:${chatText(events.at(-1)!)}`);
    };

    await session.start();
    operations.length = 0;

    await session.submit("chat.send", { message: "first", format: "plain" });
    expect(operations).toEqual(["persist:first", "replica:first", "broadcast:first"]);

    repository.failNextSave = true;
    await expect(
      session.submit("chat.send", { message: "must-not-escape", format: "plain" }),
    ).rejects.toThrow("injected persistence failure");

    expect(transport.broadcasts).toHaveLength(1);
    expect(snapshots.at(-1)?.map(chatText)).toEqual(["first"]);
    expect((await repository.listEvents(ROOM_ID)).map(chatText)).toEqual(["first"]);

    await session.submit("chat.send", { message: "after-reload", format: "plain" });
    const persisted = await repository.listEvents(ROOM_ID);
    expect(persisted.map((event) => event.sequence)).toEqual([1, 2]);
    expect(persisted.map(chatText)).toEqual(["first", "after-reload"]);
    expect(transport.broadcasts.map(eventFromWire).map(chatText)).toEqual(["first", "after-reload"]);
  });

  it("uses the authenticated presence name and strips relay-only presence fields", async () => {
    const repository = new MemoryRepository();
    const transport = new FakeTransport();
    const session = createSession("host", repository, transport);
    const errors: string[] = [];
    const presenceSnapshots: ParticipantV1[][] = [];
    session.onError = (message) => errors.push(message);
    session.onPresence = (participants) => presenceSnapshots.push(participants);
    await session.start();

    const relayPlayer = { ...PLAYER, status: "online" as const };
    transport.emitPresence([{ ...HOST, status: "online" } as ParticipantV1, relayPlayer]);
    const command = chatCommand({ ...PLAYER, displayName: "Spoofed Name" }, "hello");
    await transport.deliver(PLAYER_PEER_ID, { kind: "command", command });

    expect(errors).toEqual([]);
    const [event] = await repository.listEvents(ROOM_ID);
    expect(event?.sender).toEqual(PLAYER);
    expect(event?.sender).not.toHaveProperty("status");
    expect(presenceSnapshots.at(-1)).toEqual([HOST, PLAYER]);
  });

  it("waits for the first command to persist before ACKing a concurrent duplicate", async () => {
    const repository = new GatedRepository();
    const transport = new FakeTransport();
    const session = createSession("host", repository, transport);
    await session.start();
    transport.emitPresence([HOST, PLAYER]);

    const command = chatCommand(PLAYER, "only once");
    repository.gateNextSave();
    const firstDelivery = transport.deliver(PLAYER_PEER_ID, { kind: "command", command });
    await repository.saveStarted;
    const duplicateDelivery = transport.deliver(PLAYER_PEER_ID, { kind: "command", command });
    await Promise.resolve();

    expect(transport.broadcasts).toEqual([]);
    expect(transport.sentToPeers).toEqual([]);

    repository.releaseSave();
    await Promise.all([firstDelivery, duplicateDelivery]);

    const persisted = await repository.listEvents(ROOM_ID);
    expect(persisted).toHaveLength(1);
    expect(transport.broadcasts).toHaveLength(1);
    expect(transport.sentToPeers).toHaveLength(1);
    expect(transport.sentToPeers[0]?.peerId).toBe(PLAYER_PEER_ID);
    expect(eventFromWire(transport.sentToPeers[0]!.message)).toEqual(
      eventFromWire(transport.broadcasts[0]!),
    );
  });

  it("resends a pending player command after host presence and stops after its event ACK", async () => {
    const repository = new MemoryRepository();
    const transport = new FakeTransport();
    transport.sendToHostResult = false;
    const session = createSession("player", repository, transport);
    await session.start();

    transport.emitPresence([PLAYER, HOST]);
    transport.sentToHost.length = 0;

    await session.submit("chat.send", { message: "retry me", format: "plain" });
    const initialAttempt = transport.sentToHost[0];
    if (initialAttempt?.kind !== "command") throw new Error("expected a command attempt");
    const pendingCommand = initialAttempt.command;

    transport.emitPresence([PLAYER]);
    transport.sentToHost.length = 0;
    transport.sendToHostResult = true;
    transport.emitPresence([
      { ...PLAYER, status: "online" } as ParticipantV1,
      { ...HOST, status: "online" } as ParticipantV1,
    ]);

    expect(transport.sentToHost.map((message) => message.kind)).toEqual(["sync.request", "command"]);
    const resent = transport.sentToHost[1];
    expect(resent?.kind).toBe("command");
    if (resent?.kind !== "command") throw new Error("expected a resent command");
    expect(resent.command.commandId).toBe(pendingCommand.commandId);

    const ack = roomEventSchema.parse({
      protocolVersion: 1,
      roomId: ROOM_ID,
      eventId: "699382cc-4743-42e8-bf08-625f3b4b99a5",
      sequence: 1,
      sender: PLAYER,
      occurredAt: "2026-08-27T00:00:01.000Z",
      causedByCommandId: pendingCommand.commandId,
      type: "chat.message",
      payload: pendingCommand.payload,
    });
    await transport.deliver(HOST_PEER_ID, { kind: "event", event: ack });

    transport.sentToHost.length = 0;
    transport.emitPresence([PLAYER, HOST]);
    expect(transport.sentToHost.map((message) => message.kind)).toEqual(["sync.request"]);
  });

  it("rejects player commands while the host is absent and resumes after presence returns", async () => {
    const repository = new MemoryRepository();
    const transport = new FakeTransport();
    const session = createSession("player", repository, transport);
    await session.start();

    expect(session.isHostAvailable).toBe(false);
    await expect(session.submit("chat.send", { message: "paused", format: "plain" }))
      .rejects.toThrow("房主当前离线，房间已暂停");
    expect(transport.sentToHost).toEqual([]);

    transport.emitPresence([PLAYER, HOST]);
    transport.sentToHost.length = 0;
    expect(session.isHostAvailable).toBe(true);
    await session.submit("chat.send", { message: "resumed", format: "plain" });
    expect(transport.sentToHost).toHaveLength(1);
    expect(transport.sentToHost[0]?.kind).toBe("command");

    transport.emitPath(HOST_PEER_ID, "offline");
    expect(session.isHostAvailable).toBe(false);
    await expect(session.submit("chat.send", { message: "path lost", format: "plain" }))
      .rejects.toThrow("房主当前离线，房间已暂停");

    transport.emitPresence([PLAYER, HOST]);
    expect(session.isHostAvailable).toBe(true);
  });

  it("keeps host authority active without relying on a presence echo", async () => {
    const repository = new MemoryRepository();
    const transport = new FakeTransport();
    const session = createSession("host", repository, transport);
    await session.start();

    expect(session.isHostAvailable).toBe(true);
    await session.submit("chat.send", { message: "host remains authoritative", format: "plain" });
    expect((await repository.listEvents(ROOM_ID))).toHaveLength(1);
  });
});

function createSession(
  role: "host" | "player",
  repository: MemoryRepository,
  transport: FakeTransport,
): RoomSession {
  const room = roomRecord(role);
  return new RoomSession({
    room,
    displayName: role === "host" ? HOST.displayName : PLAYER.displayName,
    relayUrl: room.relayUrl,
    repository,
    transportFactory: () => transport,
  });
}

function roomRecord(role: "host" | "player"): RoomRecord {
  return {
    id: ROOM_ID,
    name: "Test Room",
    localRole: role,
    localPeerId: role === "host" ? HOST_PEER_ID : PLAYER_PEER_ID,
    hostPeerId: HOST_PEER_ID,
    inviteToken: "token_12345678901234567890",
    ...(role === "host" ? { joinToken: "join_123456789012345678901" } : {}),
    relayUrl: "wss://relay.example.test/v1/rooms/ws",
    lastSeq: 0,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

function chatCommand(sender: ParticipantV1, message: string): RoomCommandV1 {
  return roomCommandSchema.parse({
    protocolVersion: 1,
    roomId: ROOM_ID,
    commandId: crypto.randomUUID(),
    sender,
    sentAt: "2026-08-27T00:00:00.000Z",
    type: "chat.send",
    payload: { message, format: "plain" },
  });
}

function eventFromWire(message: RoomWireMessage): RoomEventV1 {
  if (message.kind !== "event") throw new Error("expected an event wire message");
  return message.event;
}

function eventMessage(message: RoomWireMessage): string {
  return message.kind === "event" ? chatText(message.event) : message.kind;
}

function chatText(event: RoomEventV1): string {
  if (event.type !== "chat.message") throw new Error("expected a chat event");
  return event.payload.message;
}
