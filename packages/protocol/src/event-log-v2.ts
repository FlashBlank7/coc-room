import { rollDice, type RandomIntSource } from "./dice.js";
import {
  audienceV2Schema,
  isAudienceMemberV2,
  isSameAudienceV2,
  projectRoomEventV2,
  roomCommandV2Schema,
  roomEventV2Schema,
  roomEventViewV2Schema,
  seatV2Schema,
  type AudienceMemberV2,
  type AudienceV2,
  type BoardItemV1,
  type RoomCommandV2,
  type RoomEventProposalV2,
  type RoomEventV2,
  type RoomEventViewV2,
  type SeatV2,
} from "./schemas/room-v2.js";
import {
  createRoomWorldStateV2,
  deriveRoomWorldStateFromViewsV2,
  reduceRoomWorldStateV2,
  type RoomWorldStateV2,
} from "./room-world-v2.js";

export interface HostEventSequencerV2Options {
  readonly initialEvents?: readonly RoomEventV2[];
  readonly createEventId?: () => string;
  readonly clock?: () => Date;
  readonly rng?: RandomIntSource;
}

export interface CommitEventV2Result {
  readonly event: RoomEventV2;
  readonly duplicate: boolean;
}

/** Host authority for V2 events, permissions, revisions and audience defaults. */
export class HostEventSequencerV2 {
  readonly roomId: string;

  private readonly createEventId: () => string;
  private readonly clock: () => Date;
  private readonly rng?: RandomIntSource;
  private readonly bySequence = new Map<number, RoomEventV2>();
  private readonly byId = new Map<string, RoomEventV2>();
  private readonly byCommandId = new Map<string, RoomEventV2>();
  private state: RoomWorldStateV2;
  private nextSequence = 1;

  constructor(roomId: string, options: HostEventSequencerV2Options = {}) {
    if (!roomId) throw new Error("roomId cannot be empty");
    this.roomId = roomId;
    this.createEventId = options.createEventId ?? createUuid;
    this.clock = options.clock ?? (() => new Date());
    this.rng = options.rng;
    this.state = createRoomWorldStateV2(roomId);
    for (const candidate of [...(options.initialEvents ?? [])].sort((a, b) => a.sequence - b.sequence)) {
      const event = roomEventV2Schema.parse(candidate);
      if (event.roomId !== roomId) throw new Error(`Event ${event.eventId} belongs to another room`);
      this.remember(event);
    }
  }

  get lastSequence(): number {
    return this.nextSequence - 1;
  }

  get world(): RoomWorldStateV2 {
    return this.state;
  }

  /**
   * Performs schema, identity, permission and optimistic-revision checks
   * without consuming an event ID, RNG value, sequence, or mutating state.
   * Hosts use this before accepting potentially slow player asset uploads.
   */
  preflightCommand(
    candidate: RoomCommandV2,
    expectedSender: SeatV2,
  ): { readonly duplicate: boolean } {
    const command = roomCommandV2Schema.parse(candidate);
    if (command.roomId !== this.roomId) throw new Error("V2 command belongs to another room");
    if (command.sender.seatId !== expectedSender.seatId || command.sender.role !== expectedSender.role) {
      throw new Error("V2 command sender does not match the authenticated seat");
    }
    if (this.byCommandId.has(command.commandId)) return { duplicate: true };
    if (command.type === "dice.roll") {
      validateDiceAuthorization(command, expectedSender, this.state);
      return { duplicate: false };
    }

    const sender = seatV2Schema.parse(expectedSender);
    const proposal = normalizeProposal(command.proposal as RoomEventProposalV2, sender, this.state);
    const preview = roomEventV2Schema.parse({
      protocolVersion: 2,
      roomId: this.roomId,
      // UUID command IDs are safe preview IDs and are never persisted as the
      // event identity. A pathological collision is rejected before upload.
      eventId: command.commandId,
      sequence: this.nextSequence,
      sender,
      occurredAt: command.sentAt,
      causedByCommandId: command.commandId,
      ...proposal,
    });
    authorizeEvent(preview, this.state);
    reduceRoomWorldStateV2(this.state, preview);
    return { duplicate: false };
  }

  commitCommand(
    candidate: RoomCommandV2,
    expectedSender: SeatV2,
  ): CommitEventV2Result {
    const command = roomCommandV2Schema.parse(candidate);
    if (command.roomId !== this.roomId) throw new Error("V2 command belongs to another room");
    if (command.sender.seatId !== expectedSender.seatId || command.sender.role !== expectedSender.role) {
      throw new Error("V2 command sender does not match the authenticated seat");
    }
    const duplicate = this.byCommandId.get(command.commandId);
    if (duplicate !== undefined) return { event: duplicate, duplicate: true };
    // Relay display names and command bodies are untrusted. Event audit fields
    // always come from the host's authenticated seat roster.
    const sender = seatV2Schema.parse(expectedSender);
    if (command.type === "dice.roll") validateDiceAuthorization(command, sender, this.state);

    const proposal = command.type === "dice.roll"
      ? {
          type: "dice.result" as const,
          audience: sender.role === "host" ? command.audience : { kind: "room" as const },
          payload: {
            reason: command.payload.reason,
            ...(command.payload.checkRequestId === undefined
              ? {}
              : { checkRequestId: command.payload.checkRequestId }),
            result: rollDice(command.payload.expression, {
              rng: this.rng,
              bonusDice: command.payload.bonusDice,
              penaltyDice: command.payload.penaltyDice,
              target: command.payload.target,
              requiredDifficulty: command.payload.requiredDifficulty,
            }),
          },
        }
      : normalizeProposal(command.proposal as RoomEventProposalV2, sender, this.state);

    const event = roomEventV2Schema.parse({
      protocolVersion: 2,
      roomId: this.roomId,
      eventId: this.createEventId(),
      sequence: this.nextSequence,
      sender,
      occurredAt: this.clock().toISOString(),
      causedByCommandId: command.commandId,
      ...proposal,
    });
    authorizeEvent(event, this.state);
    this.remember(event);
    return { event, duplicate: false };
  }

  eventsAfter(lastSequence: number, limit = Number.POSITIVE_INFINITY): RoomEventV2[] {
    if (!Number.isInteger(lastSequence) || lastSequence < 0) {
      throw new RangeError("lastSequence must be a non-negative integer");
    }
    if (!(limit > 0)) return [];
    return [...this.bySequence.values()]
      .filter(({ sequence }) => sequence > lastSequence)
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, limit);
  }

  viewsAfter(member: AudienceMemberV2, lastSequence: number, limit = Number.POSITIVE_INFINITY): RoomEventViewV2[] {
    return this.eventsAfter(lastSequence, limit).map((event) => projectRoomEventV2(
      event,
      member,
      this.state.eventAudiences.get(event.eventId),
    ));
  }

  findById(eventId: string): RoomEventV2 | undefined {
    return this.byId.get(eventId);
  }

  private remember(event: RoomEventV2): void {
    if (event.sequence !== this.nextSequence) {
      throw new Error(`V2 event sequence ${event.sequence} does not follow ${this.nextSequence - 1}`);
    }
    if (this.byId.has(event.eventId)) throw new Error(`Duplicate V2 event ID ${event.eventId}`);
    const nextState = reduceRoomWorldStateV2(this.state, event);
    this.state = nextState;
    this.bySequence.set(event.sequence, event);
    this.byId.set(event.eventId, event);
    if (event.causedByCommandId) this.byCommandId.set(event.causedByCommandId, event);
    this.nextSequence += 1;
  }
}

/** A client replica that supports an in-place redacted-to-full audience upgrade. */
export class EventViewReplicaV2 {
  readonly roomId: string;
  private readonly bySequence = new Map<number, RoomEventViewV2>();
  private readonly sequenceById = new Map<string, number>();
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

  apply(candidate: RoomEventViewV2): "applied" | "upgraded" | "duplicate" {
    const view = roomEventViewV2Schema.parse(candidate);
    const metadata = viewMetadata(view);
    if (metadata.roomId !== this.roomId) throw new Error("V2 event view belongs to another room");
    const knownSequence = this.sequenceById.get(metadata.eventId);
    if (knownSequence !== undefined && knownSequence !== metadata.sequence) {
      throw new Error(`V2 event ID ${metadata.eventId} was reused at another sequence`);
    }
    const existing = this.bySequence.get(metadata.sequence);
    if (existing !== undefined) {
      const existingMetadata = viewMetadata(existing);
      if (existingMetadata.eventId !== metadata.eventId) {
        throw new Error(`V2 sequence ${metadata.sequence} is already occupied`);
      }
      if (JSON.stringify(existing) === JSON.stringify(view)) return "duplicate";
      if (existing.view === "redacted" && view.view === "full") {
        this.bySequence.set(metadata.sequence, view);
        return "upgraded";
      }
      throw new Error("A full V2 event view cannot be changed or downgraded");
    }
    this.bySequence.set(metadata.sequence, view);
    this.sequenceById.set(metadata.eventId, metadata.sequence);
    while (this.bySequence.has(this.contiguousSequence + 1)) this.contiguousSequence += 1;
    return "applied";
  }

  orderedViews(): RoomEventViewV2[] {
    return [...this.bySequence.entries()]
      .filter(([sequence]) => sequence <= this.contiguousSequence)
      .sort(([left], [right]) => left - right)
      .map(([, view]) => view);
  }

  missingSequences(): number[] {
    const highest = Math.max(this.contiguousSequence, ...this.bySequence.keys());
    const missing: number[] = [];
    for (let sequence = this.contiguousSequence + 1; sequence <= highest; sequence += 1) {
      if (!this.bySequence.has(sequence)) missing.push(sequence);
    }
    return missing;
  }

  deriveWorld(): RoomWorldStateV2 {
    // Out-of-order live delivery and audience upgrades may be buffered ahead
    // of a gap. UI projections must never observe that non-contiguous suffix.
    return deriveRoomWorldStateFromViewsV2(
      this.orderedViews().filter((view) => viewSequenceV2(view) <= this.contiguousSequence),
    );
  }
}

function viewSequenceV2(view: RoomEventViewV2): number {
  return view.view === "full" ? view.event.sequence : view.sequence;
}

function normalizeProposal(
  proposal: RoomEventProposalV2,
  sender: SeatV2,
  state: RoomWorldStateV2,
): RoomEventProposalV2 {
  if (sender.role === "host") return proposal;
  const defaultAudience: AudienceV2 = state.defaultVisibility === "public"
    ? { kind: "room" }
    : { kind: "seats", seatIds: [sender.seatId] };
  switch (proposal.type) {
    case "chat.message":
    case "character.updated":
    case "check.requested":
    case "table.seat.claimed":
    case "table.seat.released":
    case "table.seat.character.assigned":
      return { ...proposal, audience: { kind: "room" } };
    case "check.closed": {
      const request = state.checkRequests.get(proposal.payload.requestId);
      return { ...proposal, audience: request?.audience ?? { kind: "room" } };
    }
    case "clue.claimed":
    case "clue.unclaimed": {
      const artifact = state.artifacts.get(proposal.payload.artifactId);
      const audience = artifact?.audience ?? proposal.audience;
      return { ...proposal, audience };
    }
    case "entity.upserted": {
      const existing = state.entities.get(proposal.payload.entity.entityId);
      const audience = existing?.audience ?? defaultAudience;
      return {
        ...proposal,
        audience,
        payload: { entity: { ...proposal.payload.entity, audience } },
      };
    }
    case "artifact.upserted": {
      const existing = state.artifacts.get(proposal.payload.artifact.artifactId);
      const audience = existing?.audience ?? defaultAudience;
      return {
        ...proposal,
        audience,
        payload: { artifact: { ...proposal.payload.artifact, audience } },
      };
    }
    case "board.item.upserted": {
      const board = state.boards.get(proposal.payload.boardId);
      if (!board || board.kind !== "evidence") return proposal;
      const current = board.items.find(({ itemId }) => itemId === proposal.payload.item.itemId);
      const audience = current?.audience ?? board.audience;
      return { ...proposal, audience, payload: { ...proposal.payload, item: { ...proposal.payload.item, audience, locked: current?.locked ?? false } } };
    }
    case "board.edge.upserted": {
      const board = state.boards.get(proposal.payload.boardId);
      const current = board?.edges.find(({ edgeId }) => edgeId === proposal.payload.edge.edgeId);
      const audience = current?.audience ?? board?.audience ?? proposal.audience;
      return { ...proposal, audience, payload: { ...proposal.payload, edge: { ...proposal.payload.edge, audience } } };
    }
    case "board.item.removed":
    case "board.edge.removed": {
      const board = state.boards.get(proposal.payload.boardId);
      return board ? { ...proposal, audience: board.audience } : proposal;
    }
    case "npc.session.message": {
      const session = state.npcSessions.get(proposal.payload.sessionId);
      return session ? { ...proposal, audience: session.audience } : proposal;
    }
    default:
      return proposal;
  }
}

function authorizeEvent(event: RoomEventV2, state: RoomWorldStateV2): void {
  if (event.sender.role === "host") return;
  if (!isAudienceMemberV2(event.audience, event.sender)) {
    throw new Error("A player cannot submit content they cannot see");
  }
  switch (event.type) {
    case "chat.message":
    case "dice.result":
      return;
    case "check.requested":
      return;
    case "table.seat.claimed":
    case "table.seat.released":
    case "table.seat.character.assigned":
      // The reducer checks vacancy, occupant identity and card ownership
      // against the same authoritative state used to sequence the command.
      return;
    case "check.closed": {
      const request = state.checkRequests.get(event.payload.requestId);
      if (request === undefined) throw new Error(`check request ${event.payload.requestId} does not exist`);
      if (event.sender.seatId !== request.requesterSeatId || event.payload.outcome !== "cancelled") {
        throw new Error("Only the host may resolve a check; its requester may only cancel it");
      }
      return;
    }
    case "clue.claimed":
    case "clue.unclaimed":
      if (!isSameAudienceV2(event.audience, state.artifacts.get(event.payload.artifactId)?.audience ?? event.audience)) {
        throw new Error("clue focus change must use the clue audience");
      }
      return;
    case "character.updated":
      // `ownerPeerId` is the retained V1 field name, but V2 deliberately stores
      // the stable seat ID here. A transient WebRTC peer ID changes on every
      // reconnect and must never define character ownership.
      if (event.payload.character.ownerPeerId !== event.sender.seatId) {
        throw new Error("Players may only update their own character");
      }
      if (
        state.latestCharacters.get(event.payload.character.id)?.ownerPeerId !== undefined
        && state.latestCharacters.get(event.payload.character.id)?.ownerPeerId !== event.sender.seatId
      ) {
        throw new Error("Players may not take ownership of another seat's character");
      }
      return;
    case "entity.upserted": {
      const current = state.entities.get(event.payload.entity.entityId);
      if (event.payload.entity.kind !== "clue" || (current !== undefined && current.kind !== "clue")) {
        throw new Error("Only the host may create or edit location, NPC, scene, or custom entities");
      }
      return;
    }
    case "artifact.upserted": {
      const current = state.artifacts.get(event.payload.artifact.artifactId);
      if (current?.locked) throw new Error("Only the host may edit a locked artifact");
      if (event.payload.artifact.locked !== (current?.locked ?? false)) {
        throw new Error("Only the host may change artifact locks");
      }
      if (event.payload.artifact.archived !== (current?.archived ?? false)) {
        throw new Error("Only the host may archive artifacts");
      }
      return;
    }
    case "board.item.upserted": {
      const board = requireVisibleBoard(state, event.payload.boardId, event.sender);
      const current = board.items.find(({ itemId }) => itemId === event.payload.item.itemId);
      if (board.kind !== "evidence") {
        if (!current) throw new Error("Players may not create items on scene or map boards");
        if (current.locked) throw new Error("Only the host may edit a locked board item");
        if (event.payload.item.locked !== current.locked) {
          throw new Error("Only the host may change board item locks");
        }
        if (
          !isSameAudienceV2(event.audience, current.audience)
          || !isSameAudienceV2(event.payload.item.audience, current.audience)
        ) {
          throw new Error("Players may not change a scene or map item audience");
        }
        if (!isPlayerOwnedCharacterItem(current, event.sender.seatId, state)) {
          throw new Error("Players may only move their own character token");
        }
        if (!isPositionOnlyBoardItemUpdate(current, event.payload.item)) {
          throw new Error("Players may only change their own character token position");
        }
        return;
      }
      if (current?.locked) throw new Error("Only the host may edit a locked board item");
      if (event.payload.item.locked !== (current?.locked ?? false)) {
        throw new Error("Only the host may change board item locks");
      }
      return;
    }
    case "board.item.removed": {
      const board = requireVisibleBoard(state, event.payload.boardId, event.sender);
      if (board.kind !== "evidence") {
        throw new Error("Players may not remove items from scene or map boards");
      }
      if (board.items.find(({ itemId }) => itemId === event.payload.itemId)?.locked) {
        throw new Error("Only the host may remove a locked board item");
      }
      return;
    }
    case "board.edge.upserted":
    case "board.edge.removed": {
      const board = requireVisibleBoard(state, event.payload.boardId, event.sender);
      if (board.kind !== "evidence") {
        throw new Error("Players may only edit connections on evidence boards");
      }
      return;
    }
    case "npc.session.message": {
      const session = state.npcSessions.get(event.payload.sessionId);
      if (!session || !isAudienceMemberV2(session.audience, event.sender)) {
        throw new Error("NPC interaction session is not visible to this seat");
      }
      if (session.status !== "active") {
        throw new Error("Players cannot submit messages to an inactive NPC interaction session");
      }
      if (event.payload.role !== "human" || event.payload.speakerSeatId !== event.sender.seatId) {
        throw new Error("Players may only submit their own human NPC-panel messages");
      }
      return;
    }
    default:
      throw new Error(`Only the host may submit ${event.type}`);
  }
}

function isPlayerOwnedCharacterItem(
  item: BoardItemV1,
  seatId: string,
  state: RoomWorldStateV2,
): boolean {
  if (item.reference.kind !== "entity") return false;
  const entity = state.entities.get(item.reference.entityId);
  if (!entity || entity.kind !== "character") return false;
  if (typeof entity.data.ownerSeatId === "string") return entity.data.ownerSeatId === seatId;
  if (typeof entity.data.characterId !== "string") return false;
  return state.latestCharacters.get(entity.data.characterId)?.ownerPeerId === seatId;
}

function isPositionOnlyBoardItemUpdate(current: BoardItemV1, candidate: BoardItemV1): boolean {
  return current.schemaVersion === candidate.schemaVersion
    && current.itemId === candidate.itemId
    && jsonValuesEqual(current.reference, candidate.reference)
    && current.label === candidate.label
    && jsonValuesEqual(current.size, candidate.size)
    && current.rotationDegrees === candidate.rotationDegrees
    && current.scale === candidate.scale
    && current.zIndex === candidate.zIndex
    && current.locked === candidate.locked
    && isSameAudienceV2(current.audience, candidate.audience)
    && jsonValuesEqual(current.extensions, candidate.extensions);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key]));
}

function validateDiceAuthorization(
  command: Extract<RoomCommandV2, { type: "dice.roll" }>,
  sender: SeatV2,
  state: RoomWorldStateV2,
): void {
  const requestId = command.payload.checkRequestId;
  if (requestId === undefined) return;
  if (state.checkClosures.has(requestId)) throw new Error(`check ${requestId} was closed`);
  const authorization = state.checkAuthorizations.get(requestId);
  if (authorization === undefined) throw new Error(`check ${requestId} was not authorized`);
  if (authorization.resolvedByEventId !== undefined) throw new Error(`check ${requestId} was already rolled`);
  if (authorization.requesterSeatId !== sender.seatId) {
    throw new Error(`check ${requestId} may only be rolled by its requester`);
  }
  if (
    command.payload.expression.replace(/\s+/g, "").toLocaleLowerCase() !== "1d100"
    || command.payload.target !== authorization.target
    || command.payload.requiredDifficulty !== authorization.requiredDifficulty
    || command.payload.bonusDice !== authorization.bonusDice
    || command.payload.penaltyDice !== authorization.penaltyDice
  ) {
    throw new Error(`dice command does not match check ${requestId} authorization`);
  }
}

function requireVisibleBoard(state: RoomWorldStateV2, boardId: string, seat: SeatV2) {
  const board = state.boards.get(boardId);
  if (!board || !isAudienceMemberV2(board.audience, seat)) {
    throw new Error(`Board ${boardId} is not visible to this seat`);
  }
  if (board.archived) throw new Error(`Board ${boardId} is archived`);
  return board;
}

function viewMetadata(view: RoomEventViewV2): { roomId: string; eventId: string; sequence: number } {
  return view.view === "full"
    ? { roomId: view.event.roomId, eventId: view.event.eventId, sequence: view.event.sequence }
    : { roomId: view.roomId, eventId: view.eventId, sequence: view.sequence };
}

function createUuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new Error("Web Crypto randomUUID is required for V2 event IDs");
}

export function createRoomCommandV2(
  roomId: string,
  sender: SeatV2,
  proposal: RoomEventProposalV2,
  commandId = createUuid(),
  sentAt = new Date().toISOString(),
): RoomCommandV2 {
  return roomCommandV2Schema.parse({
    protocolVersion: 2,
    roomId,
    commandId,
    sender,
    sentAt,
    type: "event.submit",
    proposal,
  });
}

export function defaultAudienceForSeatV2(mode: "public" | "secret", seatId: string): AudienceV2 {
  return audienceV2Schema.parse(mode === "public"
    ? { kind: "room" }
    : { kind: "seats", seatIds: [seatId] });
}
