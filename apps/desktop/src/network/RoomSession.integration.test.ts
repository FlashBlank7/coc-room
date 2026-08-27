import type {
  ModulePackageV1,
  ParticipantV1,
  RoomEventV1,
} from "@coc-room/protocol";
import { describe, expect, it } from "vitest";

import { MemoryRepository, type RoomRecord } from "../data/repository";
import {
  RoomSession,
  type RoomSessionTransport,
  type RoomSessionTransportFactory,
} from "./RoomSession";
import type {
  ConnectionPath,
  RoomTransportOptions,
  RoomWireMessage,
} from "./RoomTransport";

const ROOM_ID = "room.integration.123456";
const HOST_PEER_ID = "host.integration.123456";
const PLAYER_PEER_ID = "player.integration.123456";

const HOST: ParticipantV1 = {
  peerId: HOST_PEER_ID,
  displayName: "Keeper",
  role: "host",
};

const PLAYER: ParticipantV1 = {
  peerId: PLAYER_PEER_ID,
  displayName: "Investigator",
  role: "player",
};

interface WireDelivery {
  fromPeerId: string;
  toPeerId: string;
  message: RoomWireMessage;
}

class PairedMemoryTransportNetwork {
  readonly deliveries: WireDelivery[] = [];

  private readonly transports = new Map<string, PairedMemoryTransport>();
  private readonly onlinePeerIds = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];

  readonly transportFactory: RoomSessionTransportFactory = (options) => {
    if (this.transports.has(options.participant.peerId)) {
      throw new Error(`duplicate in-memory peer: ${options.participant.peerId}`);
    }
    const transport = new PairedMemoryTransport(this, options);
    this.transports.set(options.participant.peerId, transport);
    return transport;
  };

  connect(transport: PairedMemoryTransport): void {
    this.onlinePeerIds.add(transport.peerId);
    this.publishPresence();
  }

  disconnect(transport: PairedMemoryTransport): void {
    if (!this.onlinePeerIds.delete(transport.peerId)) return;
    this.publishPresence();
  }

  send(fromPeerId: string, toPeerId: string, message: RoomWireMessage): boolean {
    const recipient = this.transports.get(toPeerId);
    if (
      !recipient ||
      !this.onlinePeerIds.has(fromPeerId) ||
      !this.onlinePeerIds.has(toPeerId)
    ) {
      return false;
    }

    const clonedMessage = structuredClone(message);
    this.deliveries.push({ fromPeerId, toPeerId, message: clonedMessage });
    this.enqueue(() => recipient.receive(fromPeerId, clonedMessage));
    return true;
  }

  broadcast(fromPeerId: string, message: RoomWireMessage): void {
    for (const peerId of this.onlinePeerIds) {
      if (peerId !== fromPeerId) this.send(fromPeerId, peerId, message);
    }
  }

  async settle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
  }

  private publishPresence(): void {
    const participants = [...this.onlinePeerIds].map(
      (peerId) => this.transports.get(peerId)!.participant,
    );
    for (const peerId of this.onlinePeerIds) {
      const transport = this.transports.get(peerId)!;
      this.enqueue(() => transport.receivePresence(structuredClone(participants)));
    }
  }

  private enqueue(task: () => void | Promise<void>): void {
    let delivery: Promise<void>;
    delivery = Promise.resolve()
      .then(task)
      .catch((error: unknown) => {
        this.failures.push(error);
      })
      .finally(() => {
        this.pending.delete(delivery);
      });
    this.pending.add(delivery);
  }
}

class PairedMemoryTransport implements RoomSessionTransport {
  onWireMessage?: (fromPeerId: string, message: RoomWireMessage) => void | Promise<void>;
  onPresence?: (participants: ParticipantV1[]) => void;
  onPathChange?: (peerId: string, path: ConnectionPath) => void;
  onError?: (message: string) => void;

  constructor(
    private readonly network: PairedMemoryTransportNetwork,
    private readonly options: RoomTransportOptions,
  ) {}

  get peerId(): string {
    return this.options.participant.peerId;
  }

  get participant(): ParticipantV1 {
    return this.options.participant;
  }

  async start(): Promise<void> {
    this.network.connect(this);
  }

  stop(): void {
    this.network.disconnect(this);
  }

  sendToHost(message: RoomWireMessage): boolean {
    return this.sendToPeer(this.options.hostPeerId, message);
  }

  sendToPeer(peerId: string, message: RoomWireMessage): boolean {
    return this.network.send(this.peerId, peerId, message);
  }

  broadcast(message: RoomWireMessage): void {
    this.network.broadcast(this.peerId, message);
  }

  receive(fromPeerId: string, message: RoomWireMessage): void | Promise<void> {
    return this.onWireMessage?.(fromPeerId, structuredClone(message));
  }

  receivePresence(participants: ParticipantV1[]): void {
    this.onPresence?.(participants);
  }
}

describe("RoomSession two-client integration", () => {
  it("orders player commands, catches up after reconnect, and reveals only public content", async () => {
    const network = new PairedMemoryTransportNetwork();
    const hostRepository = new MemoryRepository();
    const playerRepository = new MemoryRepository();
    const host = createSession("host", hostRepository, network.transportFactory);
    const player = createSession("player", playerRepository, network.transportFactory);
    const errors: string[] = [];
    host.onError = (message) => errors.push(`host: ${message}`);
    player.onError = (message) => errors.push(`player: ${message}`);

    await host.start();
    await player.start();
    await network.settle();

    await player.submit("chat.send", {
      message: "I inspect the window.",
      format: "plain",
    });
    await network.settle();

    let hostEvents = await hostRepository.listEvents(ROOM_ID);
    let playerEvents = await playerRepository.listEvents(ROOM_ID);
    expect(playerEvents).toEqual(hostEvents);
    expect(hostEvents).toMatchObject([
      {
        sequence: 1,
        sender: PLAYER,
        type: "chat.message",
        payload: { message: "I inspect the window.", format: "plain" },
      },
    ]);

    const diceTrafficStart = network.deliveries.length;
    await player.submit("dice.roll", {
      expression: "d100",
      reason: "Spot Hidden",
      bonusDice: 0,
      penaltyDice: 0,
      target: 60,
      requiredDifficulty: "regular",
    });
    await network.settle();

    const diceTraffic = network.deliveries.slice(diceTrafficStart);
    const diceCommandDelivery = diceTraffic.find(
      (delivery) =>
        delivery.fromPeerId === PLAYER_PEER_ID &&
        delivery.toPeerId === HOST_PEER_ID &&
        delivery.message.kind === "command" &&
        delivery.message.command.type === "dice.roll",
    );
    expect(diceCommandDelivery?.message.kind).toBe("command");
    if (diceCommandDelivery?.message.kind !== "command") {
      throw new Error("expected the player dice command to reach the host");
    }
    const diceResultDelivery = diceTraffic.find(
      (delivery) =>
        delivery.fromPeerId === HOST_PEER_ID &&
        delivery.toPeerId === PLAYER_PEER_ID &&
        delivery.message.kind === "event" &&
        delivery.message.event.type === "dice.result",
    );
    expect(diceResultDelivery?.message.kind).toBe("event");
    if (
      diceResultDelivery?.message.kind !== "event" ||
      diceResultDelivery.message.event.type !== "dice.result"
    ) {
      throw new Error("expected the host to publish a dice result event");
    }
    expect(diceResultDelivery.message.event).toMatchObject({
      sequence: 2,
      sender: PLAYER,
      causedByCommandId: diceCommandDelivery.message.command.commandId,
      payload: { reason: "Spot Hidden" },
    });
    expect(diceResultDelivery.message.event.payload.result.total).toBeGreaterThanOrEqual(1);
    expect(diceResultDelivery.message.event.payload.result.total).toBeLessThanOrEqual(100);
    expect(await playerRepository.listEvents(ROOM_ID)).toEqual(
      await hostRepository.listEvents(ROOM_ID),
    );

    player.stop();
    await network.settle();
    await host.submit("chat.send", {
      message: "The clock strikes while the investigator is away.",
      format: "plain",
    });
    await network.settle();

    expect(await hostRepository.listEvents(ROOM_ID)).toHaveLength(3);
    expect(await playerRepository.listEvents(ROOM_ID)).toHaveLength(2);

    const reconnectTrafficStart = network.deliveries.length;
    await player.start();
    await network.settle();

    const reconnectTraffic = network.deliveries.slice(reconnectTrafficStart);
    expect(reconnectTraffic).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromPeerId: PLAYER_PEER_ID,
          toPeerId: HOST_PEER_ID,
          message: expect.objectContaining({ kind: "sync.request", lastSequence: 2 }),
        }),
        expect.objectContaining({
          fromPeerId: HOST_PEER_ID,
          toPeerId: PLAYER_PEER_ID,
          message: expect.objectContaining({ kind: "sync.chunk" }),
        }),
      ]),
    );
    hostEvents = await hostRepository.listEvents(ROOM_ID);
    playerEvents = await playerRepository.listEvents(ROOM_ID);
    expect(playerEvents).toEqual(hostEvents);
    expect(playerEvents.map((event) => event.sequence)).toEqual([1, 2, 3]);

    const modulePackage = keeperModule();
    await hostRepository.saveModule({
      package: modulePackage,
      sourceText: "KEEPER SOURCE: the patron is secretly the moth queen.",
    });
    await host.submit("module.switch", {
      moduleId: modulePackage.moduleId,
      revision: modulePackage.revision,
      title: modulePackage.metadata.title,
    });
    await network.settle();
    const revealTrafficStart = network.deliveries.length;
    await host.submit("content.reveal", {
      moduleId: modulePackage.moduleId,
      revision: modulePackage.revision,
      contentId: "handout.public-window",
      contentType: "handout",
      title: "Note by the window",
      body: "A pale moth rests beside a handwritten address.",
    });
    await network.settle();

    const revealTraffic = network.deliveries.slice(revealTrafficStart);
    expect(revealTraffic).toHaveLength(1);
    expect(revealTraffic[0]).toMatchObject({
      fromPeerId: HOST_PEER_ID,
      toPeerId: PLAYER_PEER_ID,
      message: {
        kind: "event",
        event: {
          type: "content.revealed",
          payload: {
            moduleId: modulePackage.moduleId,
            contentId: "handout.public-window",
            title: "Note by the window",
            body: "A pale moth rests beside a handwritten address.",
          },
        },
      },
    });
    expect(await playerRepository.listModules()).toEqual([]);
    expect(await hostRepository.listModules()).toEqual([
      { package: modulePackage, sourceText: "KEEPER SOURCE: the patron is secretly the moth queen." },
    ]);

    playerEvents = await playerRepository.listEvents(ROOM_ID);
    expect(playerEvents).toEqual(await hostRepository.listEvents(ROOM_ID));
    expect(playerEvents.at(-1)?.type).toBe("content.revealed");
    expect(JSON.stringify(playerEvents)).not.toContain("moth queen");
    expect(JSON.stringify(playerEvents)).not.toContain("keeperNotes");
    expect(errors).toEqual([]);

    player.stop();
    host.stop();
    await network.settle();
  });
});

function createSession(
  role: "host" | "player",
  repository: MemoryRepository,
  transportFactory: RoomSessionTransportFactory,
): RoomSession {
  const room = roomRecord(role);
  return new RoomSession({
    room,
    displayName: role === "host" ? HOST.displayName : PLAYER.displayName,
    relayUrl: room.relayUrl,
    repository,
    transportFactory,
  });
}

function roomRecord(role: "host" | "player"): RoomRecord {
  return {
    id: ROOM_ID,
    name: "Integration Room",
    localRole: role,
    localPeerId: role === "host" ? HOST_PEER_ID : PLAYER_PEER_ID,
    hostPeerId: HOST_PEER_ID,
    inviteToken: "token.integration.12345678901234567890",
    ...(role === "host" ? { joinToken: "join.integration.12345678901234567890" } : {}),
    relayUrl: "wss://relay.example.test/v1/rooms/ws",
    lastSeq: 0,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

function keeperModule(): ModulePackageV1 {
  return {
    schemaVersion: 1,
    moduleId: "module.integration.moth",
    revision: 1,
    metadata: {
      title: "The Moth at the Window",
      authors: ["Integration Test"],
      language: "en",
      summary: "A test module containing information that must remain keeper-only.",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
    overview: "KEEPER SECRET: the patron is secretly the moth queen.",
    sourceDocuments: [
      {
        id: "source.keeper-manuscript",
        name: "Keeper manuscript",
        mediaType: "text/markdown",
      },
    ],
    chapters: [],
    scenes: [],
    locations: [],
    npcs: [],
    clues: [],
    handouts: [],
    suggestedChecks: [],
    keeperNotes: [
      {
        id: "note.moth-queen",
        title: "The patron's identity",
        content: "The patron is secretly the moth queen.",
        relatedEntityIds: [],
        sourceRefs: [
          {
            sourceId: "source.keeper-manuscript",
            start: 0,
            end: 51,
          },
        ],
      },
    ],
    relations: [],
    extensions: {},
  };
}
