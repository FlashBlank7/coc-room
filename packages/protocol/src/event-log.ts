import type { RandomIntSource } from "./dice.js";
import { rollDice } from "./dice.js";
import type {
  RoomCommandV1,
  RoomEventDraftV1,
  RoomEventV1,
} from "./schemas/room.js";
import { roomCommandSchema, roomEventSchema } from "./schemas/room.js";

export type EventIdFactory = () => string;
export type Clock = () => Date;

function defaultEventIdFactory(): string {
  if (globalThis.crypto?.randomUUID !== undefined) {
    return globalThis.crypto.randomUUID();
  }
  if (globalThis.crypto?.getRandomValues === undefined) {
    throw new Error("A Web Crypto implementation is required to generate event IDs");
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface HostEventSequencerOptions {
  readonly initialEvents?: readonly RoomEventV1[];
  readonly createEventId?: EventIdFactory;
  readonly clock?: Clock;
}

export interface CommitEventResult {
  readonly event: RoomEventV1;
  readonly duplicate: boolean;
}

/**
 * In-memory authority helper for the host. Persist each returned event before
 * broadcasting it; hydrate initialEvents from SQLite after a restart.
 */
export class HostEventSequencer {
  readonly roomId: string;

  private readonly createEventId: EventIdFactory;
  private readonly clock: Clock;
  private readonly eventsBySequence = new Map<number, RoomEventV1>();
  private readonly eventsById = new Map<string, RoomEventV1>();
  private readonly eventsByCommandId = new Map<string, RoomEventV1>();
  private readonly characterOwners = new Map<string, string>();
  private activeModule?: Readonly<{ moduleId: string; revision: number }>;
  private nextSequence = 1;

  constructor(roomId: string, options: HostEventSequencerOptions = {}) {
    if (roomId.length === 0) {
      throw new Error("roomId cannot be empty");
    }
    this.roomId = roomId;
    this.createEventId = options.createEventId ?? defaultEventIdFactory;
    this.clock = options.clock ?? (() => new Date());

    const sorted = [...(options.initialEvents ?? [])].sort((left, right) => left.sequence - right.sequence);
    for (const candidate of sorted) {
      const event = roomEventSchema.parse(candidate);
      if (event.roomId !== roomId) {
        throw new Error(`Event ${event.eventId} belongs to a different room`);
      }
      if (this.eventsById.has(event.eventId)) {
        throw new Error(`Duplicate event ID in initial history: ${event.eventId}`);
      }
      if (this.eventsBySequence.has(event.sequence)) {
        throw new Error(`Duplicate sequence in initial history: ${event.sequence}`);
      }
      if (event.causedByCommandId !== undefined && this.eventsByCommandId.has(event.causedByCommandId)) {
        throw new Error(`Duplicate command ID in initial history: ${event.causedByCommandId}`);
      }
      this.remember(event);
      this.nextSequence = Math.max(this.nextSequence, event.sequence + 1);
    }
  }

  get lastSequence(): number {
    return this.nextSequence - 1;
  }

  get size(): number {
    return this.eventsById.size;
  }

  commit(draft: RoomEventDraftV1): CommitEventResult {
    if (draft.roomId !== undefined && draft.roomId !== this.roomId) {
      throw new Error(`Event draft belongs to room ${draft.roomId}, not ${this.roomId}`);
    }
    if (draft.causedByCommandId !== undefined) {
      const existing = this.eventsByCommandId.get(draft.causedByCommandId);
      if (existing !== undefined) {
        return { event: existing, duplicate: true };
      }
    }

    const event = roomEventSchema.parse({
      ...draft,
      protocolVersion: 1,
      roomId: this.roomId,
      eventId: this.createEventId(),
      sequence: this.nextSequence,
      occurredAt: this.clock().toISOString(),
    });
    if (this.eventsById.has(event.eventId)) {
      throw new Error(`Event ID factory produced a duplicate: ${event.eventId}`);
    }

    this.remember(event);
    this.nextSequence += 1;
    return { event, duplicate: false };
  }

  /**
   * Validates an untrusted command against both its authenticated sender and
   * the room's authoritative history before sequencing it. Production hosts
   * should use this entry point instead of resolving a command separately.
   */
  commitCommand(
    candidate: RoomCommandV1,
    options: CommandToEventOptions = {},
  ): CommitEventResult {
    const command = roomCommandSchema.parse(candidate);
    const draft = commandToEventDraft(command, options);

    // A retried command must return the exact event that was confirmed the
    // first time, even if the active module has since changed.
    const existing = this.eventsByCommandId.get(command.commandId);
    if (existing !== undefined) {
      return { event: existing, duplicate: true };
    }

    this.validateCommandAgainstHistory(command);
    return this.commit(draft);
  }

  eventsAfter(lastSequence: number, limit = Number.POSITIVE_INFINITY): RoomEventV1[] {
    if (!Number.isInteger(lastSequence) || lastSequence < 0) {
      throw new RangeError("lastSequence must be a non-negative integer");
    }
    if (!(limit > 0)) {
      return [];
    }

    return [...this.eventsBySequence.values()]
      .filter((event) => event.sequence > lastSequence)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit);
  }

  findByCommandId(commandId: string): RoomEventV1 | undefined {
    return this.eventsByCommandId.get(commandId);
  }

  private remember(event: RoomEventV1): void {
    if (event.type === "character.updated") {
      const character = event.payload.character;
      const existingOwner = this.characterOwners.get(character.id);
      if (existingOwner !== undefined && existingOwner !== character.ownerPeerId) {
        throw new Error(`Character ${character.id} changed owner in authoritative history`);
      }
    }

    this.eventsBySequence.set(event.sequence, event);
    this.eventsById.set(event.eventId, event);
    if (event.causedByCommandId !== undefined) {
      this.eventsByCommandId.set(event.causedByCommandId, event);
    }
    if (event.type === "character.updated") {
      const character = event.payload.character;
      this.characterOwners.set(character.id, character.ownerPeerId);
    }
    if (event.type === "module.switched") {
      this.activeModule = {
        moduleId: event.payload.moduleId,
        revision: event.payload.revision,
      };
    }
  }

  private validateCommandAgainstHistory(command: RoomCommandV1): void {
    if (command.type === "character.update") {
      const character = command.payload.character;
      const existingOwner = this.characterOwners.get(character.id);
      if (existingOwner !== undefined && existingOwner !== character.ownerPeerId) {
        throw new Error("A character's owner cannot be changed");
      }
      if (existingOwner !== undefined && command.sender.role !== "host" && existingOwner !== command.sender.peerId) {
        throw new Error("Players may only update their own character");
      }
    }

    if (command.type === "content.reveal") {
      if (
        this.activeModule === undefined ||
        this.activeModule.moduleId !== command.payload.moduleId ||
        this.activeModule.revision !== command.payload.revision
      ) {
        throw new Error("Content may only be revealed from the room's active module revision");
      }
    }
  }
}

export interface ReplicaApplyResult {
  readonly status: "applied" | "duplicate";
  readonly lastContiguousSequence: number;
}

/** Idempotent client-side view of confirmed events, including out-of-order delivery. */
export class EventReplica {
  readonly roomId: string;

  private readonly bySequence = new Map<number, RoomEventV1>();
  private readonly byId = new Map<string, RoomEventV1>();
  private contiguousSequence: number;

  constructor(roomId: string, baseSequence = 0) {
    if (!Number.isInteger(baseSequence) || baseSequence < 0) {
      throw new RangeError("baseSequence must be a non-negative integer");
    }
    this.roomId = roomId;
    this.contiguousSequence = baseSequence;
  }

  get lastContiguousSequence(): number {
    return this.contiguousSequence;
  }

  apply(candidate: RoomEventV1): ReplicaApplyResult {
    const event = roomEventSchema.parse(candidate);
    if (event.roomId !== this.roomId) {
      throw new Error(`Event ${event.eventId} belongs to a different room`);
    }

    const eventWithSameId = this.byId.get(event.eventId);
    if (eventWithSameId !== undefined) {
      if (JSON.stringify(eventWithSameId) !== JSON.stringify(event)) {
        throw new Error(`Event ID ${event.eventId} was reused with different content`);
      }
      return { status: "duplicate", lastContiguousSequence: this.contiguousSequence };
    }

    const eventAtSequence = this.bySequence.get(event.sequence);
    if (eventAtSequence !== undefined) {
      throw new Error(`Sequence ${event.sequence} is already occupied by ${eventAtSequence.eventId}`);
    }

    this.byId.set(event.eventId, event);
    this.bySequence.set(event.sequence, event);
    while (this.bySequence.has(this.contiguousSequence + 1)) {
      this.contiguousSequence += 1;
    }
    return { status: "applied", lastContiguousSequence: this.contiguousSequence };
  }

  orderedEvents(): RoomEventV1[] {
    return [...this.bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  }

  missingSequences(upTo = this.highestSequence()): number[] {
    if (!Number.isInteger(upTo) || upTo < this.contiguousSequence) {
      return [];
    }
    const missing: number[] = [];
    for (let sequence = this.contiguousSequence + 1; sequence <= upTo; sequence += 1) {
      if (!this.bySequence.has(sequence)) {
        missing.push(sequence);
      }
    }
    return missing;
  }

  private highestSequence(): number {
    let highest = this.contiguousSequence;
    for (const sequence of this.bySequence.keys()) {
      highest = Math.max(highest, sequence);
    }
    return highest;
  }
}

export interface CommandToEventOptions {
  readonly rng?: RandomIntSource;
  /** Authoritative connection identity, when resolving an untrusted remote command. */
  readonly expectedSender?: Readonly<{ peerId: string; role: "host" | "player" }>;
}

/** Validates permissions and resolves a player command into an unsequenced event. */
export function commandToEventDraft(
  candidate: RoomCommandV1,
  options: CommandToEventOptions = {},
): RoomEventDraftV1 {
  const command = roomCommandSchema.parse(candidate);
  if (
    options.expectedSender !== undefined &&
    (command.sender.peerId !== options.expectedSender.peerId ||
      command.sender.role !== options.expectedSender.role)
  ) {
    throw new Error("Command sender does not match the authenticated connection identity");
  }
  const common = {
    roomId: command.roomId,
    sender: command.sender,
    causedByCommandId: command.commandId,
  } as const;

  switch (command.type) {
    case "chat.send":
      return { ...common, type: "chat.message", payload: command.payload };
    case "dice.roll":
      return {
        ...common,
        type: "dice.result",
        payload: {
          reason: command.payload.reason,
          result: rollDice(command.payload.expression, {
            rng: options.rng,
            bonusDice: command.payload.bonusDice,
            penaltyDice: command.payload.penaltyDice,
            target: command.payload.target,
            requiredDifficulty: command.payload.requiredDifficulty,
          }),
        },
      };
    case "character.update":
      if (
        command.sender.role !== "host" &&
        command.payload.character.ownerPeerId !== command.sender.peerId
      ) {
        throw new Error("Players may only update their own character");
      }
      return { ...common, type: "character.updated", payload: command.payload };
    case "module.switch":
      requireHost(command);
      return { ...common, type: "module.switched", payload: command.payload };
    case "content.reveal":
      requireHost(command);
      return { ...common, type: "content.revealed", payload: command.payload };
  }
}

function requireHost(command: RoomCommandV1): void {
  if (command.sender.role !== "host") {
    throw new Error(`Only the host may submit ${command.type}`);
  }
}
