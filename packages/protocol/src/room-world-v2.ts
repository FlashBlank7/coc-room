import {
  boardV1Schema,
  expandAudienceV2,
  isAudienceMemberV2,
  isAudienceSubsetV2,
  isSameAudienceV2,
  projectRoomEventV2,
  roomEventV2Schema,
  type AudienceMemberV2,
  type AudienceTargetV2,
  type AudienceV2,
  type BoardEdgeV1,
  type BoardItemReferenceV1,
  type BoardItemV1,
  type BoardV1,
  type NpcInteractionSessionV1,
  type RoomArtifactV2,
  type RoomEntityV2,
  type RoomEventV2,
  type RoomEventViewV2,
  type TableSeatV2,
} from "./schemas/room-v2.js";
import type { Coc7Character } from "./schemas/character.js";
import type { CharacterBriefingV1 } from "./schemas/character-briefing.js";

export type NpcSessionMessageV2 = Extract<RoomEventV2, { type: "npc.session.message" }>["payload"] & {
  readonly occurredAt: string;
  /** Stable sender label captured with the authoritative event. Presence can
   * omit other or offline seats, so UI must not depend on live presence to
   * identify a human speaker in a targeted panel. */
  readonly speakerDisplayName?: string;
};
export type ActiveAudioCueV2 = Extract<RoomEventV2, { type: "audio.cued" }>["payload"];
export type CheckRequestV2 = Extract<RoomEventV2, { type: "check.requested" }>["payload"] & {
  readonly requesterSeatId: string;
  readonly requestedAt: string;
  readonly audience: AudienceV2;
};
export type CheckAuthorizationV2 = Omit<
  Extract<RoomEventV2, { type: "check.authorized" }>["payload"],
  "skillName"
> & {
  /** Always populated in world state. Legacy authorization events inherit the
   * skill from their request during replay. */
  readonly skillName: string;
  readonly requesterSeatId: string;
  readonly authorizedAt: string;
  readonly resolvedByEventId?: string;
  readonly resolvedSuccess?: boolean;
};
export type CheckClosureV2 = Extract<RoomEventV2, { type: "check.closed" }>["payload"] & {
  readonly closedBySeatId: string;
  readonly closedByRole: "host" | "player";
  readonly closedAt: string;
};
export type CheckOutcomeV2 = Extract<RoomEventV2, { type: "check.outcome.described" }>["payload"] & {
  readonly describedBySeatId: string;
  readonly describedAt: string;
  readonly audience: AudienceV2;
};
export type ClueClaimV2 = Extract<RoomEventV2, { type: "clue.claimed" }>["payload"] & {
  readonly seatId: string;
  readonly displayName: string;
  readonly claimedAt: string;
};

export interface RoomWorldStateV2 {
  readonly roomId?: string;
  readonly lastSequence: number;
  readonly entities: ReadonlyMap<string, RoomEntityV2>;
  readonly artifacts: ReadonlyMap<string, RoomArtifactV2>;
  readonly boards: ReadonlyMap<string, BoardV1>;
  readonly npcSessions: ReadonlyMap<string, NpcInteractionSessionV1>;
  readonly npcMessages: ReadonlyMap<string, readonly NpcSessionMessageV2[]>;
  readonly latestCharacters: ReadonlyMap<string, Coc7Character>;
  readonly tableSeats: ReadonlyMap<string, TableSeatV2>;
  readonly checkRequests: ReadonlyMap<string, CheckRequestV2>;
  readonly checkAuthorizations: ReadonlyMap<string, CheckAuthorizationV2>;
  readonly checkClosures: ReadonlyMap<string, CheckClosureV2>;
  readonly checkOutcomes: ReadonlyMap<string, CheckOutcomeV2>;
  readonly clueClaims: ReadonlyMap<string, readonly ClueClaimV2[]>;
  readonly activeAudio: ReadonlyMap<string, ActiveAudioCueV2>;
  readonly activeBoardId?: string;
  /** The host-selected narrative scene, independent from the active board. */
  readonly activeSceneEntityId?: string;
  readonly activeModule?: Readonly<{ moduleId: string; revision: number; title: string }>;
  readonly defaultVisibility: "public" | "secret";
  readonly characterBriefing?: CharacterBriefingV1;
  /** Effective audiences include monotonic `audience.expanded` updates. */
  readonly eventAudiences: ReadonlyMap<string, AudienceV2>;
  /** Content target for each snapshot event, used to replay durable expansions. */
  readonly eventAudienceTargets: ReadonlyMap<string, AudienceTargetV2>;
}

export function createRoomWorldStateV2(roomId?: string): RoomWorldStateV2 {
  return {
    ...(roomId === undefined ? {} : { roomId }),
    lastSequence: 0,
    entities: new Map(),
    artifacts: new Map(),
    boards: new Map(),
    npcSessions: new Map(),
    npcMessages: new Map(),
    latestCharacters: new Map(),
    tableSeats: new Map(),
    checkRequests: new Map(),
    checkAuthorizations: new Map(),
    checkClosures: new Map(),
    checkOutcomes: new Map(),
    clueClaims: new Map(),
    activeAudio: new Map(),
    defaultVisibility: "public",
    eventAudiences: new Map(),
    eventAudienceTargets: new Map(),
  };
}

/**
 * Purely applies one already sequenced V2 event. The input maps and nested
 * board values are never mutated, which makes the function safe for Zustand,
 * React memoization, tests, and deterministic replay.
 */
export function reduceRoomWorldStateV2(
  candidateState: RoomWorldStateV2,
  candidateEvent: RoomEventV2,
): RoomWorldStateV2 {
  const event = roomEventV2Schema.parse(candidateEvent);
  if (candidateState.roomId !== undefined && candidateState.roomId !== event.roomId) {
    throw new Error(`V2 event ${event.eventId} belongs to a different room`);
  }
  if (event.sequence !== candidateState.lastSequence + 1) {
    throw new Error(
      `V2 event sequence ${event.sequence} does not follow ${candidateState.lastSequence}`,
    );
  }
  if (candidateState.eventAudiences.has(event.eventId)) {
    throw new Error(`Duplicate V2 event ID: ${event.eventId}`);
  }

  const state: MutableRoomWorldStateV2 = {
    roomId: candidateState.roomId ?? event.roomId,
    lastSequence: event.sequence,
    entities: new Map(candidateState.entities),
    artifacts: new Map(candidateState.artifacts),
    boards: new Map(
      [...candidateState.boards].map(([boardId, board]) => [boardId, cloneBoard(board)]),
    ),
    npcSessions: new Map(candidateState.npcSessions),
    npcMessages: new Map(
      [...candidateState.npcMessages].map(([sessionId, messages]) => [sessionId, [...messages]]),
    ),
    latestCharacters: new Map(candidateState.latestCharacters),
    tableSeats: new Map(candidateState.tableSeats),
    checkRequests: new Map(candidateState.checkRequests),
    checkAuthorizations: new Map(candidateState.checkAuthorizations),
    checkClosures: new Map(candidateState.checkClosures),
    checkOutcomes: new Map(candidateState.checkOutcomes),
    clueClaims: new Map(
      [...candidateState.clueClaims].map(([artifactId, claims]) => [artifactId, [...claims]]),
    ),
    activeAudio: new Map(candidateState.activeAudio),
    activeBoardId: candidateState.activeBoardId,
    activeSceneEntityId: candidateState.activeSceneEntityId,
    activeModule: candidateState.activeModule,
    defaultVisibility: candidateState.defaultVisibility,
    characterBriefing: candidateState.characterBriefing,
    eventAudiences: new Map(candidateState.eventAudiences),
    eventAudienceTargets: new Map(candidateState.eventAudienceTargets),
  };

  switch (event.type) {
    case "chat.message":
      if (event.payload.persona !== undefined && event.sender.role !== "host") {
        throw new Error("only the host may speak as an NPC");
      }
      break;
    case "system.notice":
      break;
    case "dice.result": {
      const requestId = event.payload.checkRequestId;
      if (requestId === undefined) break;
      if (state.checkClosures.has(requestId)) throw new Error(`check ${requestId} was closed`);
      const authorization = state.checkAuthorizations.get(requestId);
      if (authorization === undefined) throw new Error(`check ${requestId} was not authorized`);
      if (authorization.resolvedByEventId !== undefined) throw new Error(`check ${requestId} was already rolled`);
      if (authorization.requesterSeatId !== event.sender.seatId) {
        throw new Error(`check ${requestId} may only be rolled by its requester`);
      }
      const result = event.payload.result;
      if (
        result.kind !== "percentile"
        || result.check === undefined
        || result.check.target !== authorization.target
        || result.check.requiredDifficulty !== authorization.requiredDifficulty
        || result.bonusDice !== authorization.bonusDice
        || result.penaltyDice !== authorization.penaltyDice
      ) {
        throw new Error(`check ${requestId} result does not match its authorization`);
      }
      state.checkAuthorizations.set(requestId, {
        ...authorization,
        resolvedByEventId: event.eventId,
        resolvedSuccess: result.check.success,
      });
      break;
    }
    case "table.seat.updated": {
      requirePublicTableEvent(event);
      if (event.sender.role !== "host") throw new Error("只有 KP 可以设置桌上座位");
      const previous = state.tableSeats.get(event.payload.tableSeatId);
      if (!previous && state.tableSeats.size >= 7) throw new Error("房间最多放置 7 个玩家座位");
      state.tableSeats.set(event.payload.tableSeatId, { ...previous, ...event.payload, keeperSeatId: event.sender.seatId });
      break;
    }
    case "table.seat.claimed": {
      requirePublicTableEvent(event);
      const seat = requireTableSeat(state, event.payload.tableSeatId);
      if (seat.occupantSeatId) throw new Error("这个座位已经有人，请选择空位");
      if ([...state.tableSeats.values()].some((item) => item.occupantSeatId === event.sender.seatId)) throw new Error("你已经入座，请先离开原座位");
      transferTableCharacter(state, seat, event.sender.seatId, event.occurredAt, event.sender.displayName);
      state.tableSeats.set(seat.tableSeatId, { ...seat, occupantSeatId: event.sender.seatId });
      break;
    }
    case "table.seat.released": {
      requirePublicTableEvent(event);
      const seat = requireTableSeat(state, event.payload.tableSeatId);
      requireTableControl(seat, event.sender);
      transferTableCharacter(state, seat, seat.keeperSeatId, event.occurredAt);
      const { occupantSeatId: _occupant, ...vacant } = seat;
      state.tableSeats.set(seat.tableSeatId, vacant);
      break;
    }
    case "table.seat.character.assigned": {
      requirePublicTableEvent(event);
      const seat = requireTableSeat(state, event.payload.tableSeatId);
      requireTableControl(seat, event.sender);
      requireCharacterNotAwaitingRoll(state, seat.characterId);
      const character = event.payload.character;
      if (character) {
        requireCharacterNotAwaitingRoll(state, character.id);
        const owner = seat.occupantSeatId ?? seat.keeperSeatId;
        if (character.ownerPeerId !== owner) throw new Error("角色卡必须归属于这个座位的玩家；空位由 KP 保管");
        if ([...state.tableSeats.values()].some((item) => item.tableSeatId !== seat.tableSeatId && item.characterId === character.id)) throw new Error("这张角色卡已放在另一个座位，请使用独立副本");
        const existing = state.latestCharacters.get(character.id);
        if (existing && existing.ownerPeerId !== owner) throw new Error("不能借放置角色卡取得其他玩家的角色");
        state.latestCharacters.set(character.id, character);
        state.tableSeats.set(seat.tableSeatId, { ...seat, characterId: character.id });
      } else {
        const { characterId: _character, ...empty } = seat;
        state.tableSeats.set(seat.tableSeatId, empty);
      }
      break;
    }
    case "character.updated": {
      const character = event.payload.character;
      const existing = state.latestCharacters.get(character.id);
      if (existing !== undefined && existing.ownerPeerId !== character.ownerPeerId) {
        throw new Error(`character ${character.id} changed owner in authoritative history`);
      }
      if (
        existing === undefined
        && event.sender.role !== "host"
        && [...state.entities.values()].some((entity) => entity.kind === "character"
          && typeof entity.data.ownerSeatId !== "string"
          && entity.data.characterId === character.id)
      ) {
        throw new Error(`character ${character.id} is already referenced by an unowned token; only the host may establish its owner`);
      }
      state.latestCharacters.set(character.id, character);
      break;
    }
    case "check.requested": {
      if (state.checkRequests.has(event.payload.requestId)) {
        throw new Error(`duplicate check request ${event.payload.requestId}`);
      }
      const character = state.latestCharacters.get(event.payload.characterId);
      if (character === undefined || (event.sender.role !== "host" && character.ownerPeerId !== event.sender.seatId)) {
        throw new Error("a check request requires the requester's room character");
      }
      if (character.ownerPeerId !== event.sender.seatId && !isAudienceMemberV2(event.audience, { seatId: character.ownerPeerId, role: "player" })) {
        throw new Error("a keeper-initiated check must be visible to the investigator");
      }
      if (character.name !== event.payload.characterName) {
        throw new Error("check request character name does not match the room character");
      }
      if (event.payload.pushOfRequestId !== undefined) {
        const originalRequest = state.checkRequests.get(event.payload.pushOfRequestId);
        const originalAuthorization = state.checkAuthorizations.get(event.payload.pushOfRequestId);
        if (originalRequest === undefined || originalAuthorization?.resolvedByEventId === undefined) {
          throw new Error("a pushed check requires one completed original check");
        }
        if (originalAuthorization.resolvedSuccess !== false) {
          throw new Error("only a failed check may be pushed");
        }
        if (originalRequest.pushOfRequestId !== undefined) {
          throw new Error("a pushed check cannot be pushed again");
        }
        if (!state.checkOutcomes.has(originalRequest.requestId)) {
          throw new Error("a pushed check requires the original failed outcome to be described first");
        }
        if (
          originalRequest.requesterSeatId !== event.sender.seatId
          || originalRequest.characterId !== event.payload.characterId
        ) {
          throw new Error("a check may only be pushed by the original investigator");
        }
        if (!isSameAudienceV2(event.audience, originalRequest.audience)) {
          throw new Error("a pushed check must use the original request audience");
        }
        if (event.payload.skillName !== originalAuthorization.skillName) {
          throw new Error("a pushed check must use the original authorized skill");
        }
        if (
          event.payload.suggestedSkillName !== undefined
          && event.payload.suggestedSkillName !== originalAuthorization.skillName
        ) {
          throw new Error("a pushed check suggestion must use the original authorized skill");
        }
        const originalApproach = originalRequest.approach ?? originalRequest.reason;
        const pushedApproach = event.payload.approach ?? event.payload.reason;
        if (normalizeCheckApproach(pushedApproach) === normalizeCheckApproach(originalApproach)) {
          throw new Error("a pushed check requires a different approach");
        }
        const previousPushes = [...state.checkRequests.values()].filter(
          ({ pushOfRequestId }) => pushOfRequestId === event.payload.pushOfRequestId,
        );
        const alreadyHasLiveOrConsumedPush = previousPushes.some(({ requestId }) => {
          if (state.checkAuthorizations.has(requestId)) return true;
          const closure = state.checkClosures.get(requestId);
          return closure === undefined || closure.outcome === "no-roll";
        });
        if (alreadyHasLiveOrConsumedPush) {
          throw new Error("a failed check may only be pushed once");
        }
      }
      state.checkRequests.set(event.payload.requestId, {
        ...event.payload,
        requesterSeatId: character.ownerPeerId,
        requestedAt: event.occurredAt,
        audience: event.audience,
      });
      break;
    }
    case "check.authorized": {
      if (event.sender.role !== "host") throw new Error("only the host may authorize checks");
      if (state.checkClosures.has(event.payload.requestId)) {
        throw new Error(`check ${event.payload.requestId} was closed`);
      }
      if (state.checkAuthorizations.has(event.payload.requestId)) {
        throw new Error(`check ${event.payload.requestId} was already authorized`);
      }
      const request = state.checkRequests.get(event.payload.requestId);
      if (request === undefined) throw new Error(`check request ${event.payload.requestId} does not exist`);
      if (!isSameAudienceV2(event.audience, request.audience)) {
        throw new Error(`check ${event.payload.requestId} authorization must use the request audience`);
      }
      if (request.pushOfRequestId !== undefined && !event.payload.failureConsequence?.trim()) {
        throw new Error("authorizing a pushed check requires its failure consequence");
      }
      state.checkAuthorizations.set(event.payload.requestId, {
        ...event.payload,
        skillName: event.payload.skillName ?? request.skillName,
        requesterSeatId: request.requesterSeatId,
        authorizedAt: event.occurredAt,
      });
      break;
    }
    case "check.closed": {
      const request = state.checkRequests.get(event.payload.requestId);
      if (request === undefined) throw new Error(`check request ${event.payload.requestId} does not exist`);
      const authorization = state.checkAuthorizations.get(event.payload.requestId);
      if (authorization !== undefined) {
        // An authorized check whose dice have not yet been rolled may still be
        // walked back with an explicit cancellation: the host withdraws a
        // mistaken ruling, or the requester declines the roll (for a push this
        // is the informed choice after reading the consequence). Once the dice
        // have landed the check is terminal and only its outcome may follow.
        const cancelsUnrolledAuthorization = authorization.resolvedByEventId === undefined
          && event.payload.outcome === "cancelled"
          && (event.sender.role === "host" || event.sender.seatId === request.requesterSeatId);
        if (!cancelsUnrolledAuthorization) {
          throw new Error(authorization.resolvedByEventId !== undefined
            ? `check ${event.payload.requestId} was already rolled`
            : `check ${event.payload.requestId} was already authorized`);
        }
      }
      if (state.checkClosures.has(event.payload.requestId)) {
        throw new Error(`check ${event.payload.requestId} was already closed`);
      }
      if (!isSameAudienceV2(event.audience, request.audience)) {
        throw new Error(`check ${event.payload.requestId} closure must use the request audience`);
      }
      if (
        event.sender.role !== "host"
        && (
          event.sender.seatId !== request.requesterSeatId
          || event.payload.outcome !== "cancelled"
        )
      ) {
        throw new Error("only the host may resolve a check; its requester may only cancel it");
      }
      state.checkClosures.set(event.payload.requestId, {
        ...event.payload,
        closedBySeatId: event.sender.seatId,
        closedByRole: event.sender.role,
        closedAt: event.occurredAt,
      });
      break;
    }
    case "check.outcome.described": {
      if (event.sender.role !== "host") {
        throw new Error("only the host may describe a check outcome");
      }
      const request = state.checkRequests.get(event.payload.requestId);
      if (request === undefined) {
        throw new Error(`check request ${event.payload.requestId} does not exist`);
      }
      if (!isSameAudienceV2(event.audience, request.audience)) {
        throw new Error(`check ${event.payload.requestId} outcome must use the request audience`);
      }
      const authorization = state.checkAuthorizations.get(event.payload.requestId);
      if (authorization?.resolvedByEventId === undefined) {
        throw new Error(`check ${event.payload.requestId} outcome requires a completed roll`);
      }
      if (state.checkOutcomes.has(event.payload.requestId)) {
        throw new Error(`check ${event.payload.requestId} outcome was already described`);
      }
      state.checkOutcomes.set(event.payload.requestId, {
        ...event.payload,
        describedBySeatId: event.sender.seatId,
        describedAt: event.occurredAt,
        audience: event.audience,
      });
      break;
    }
    case "clue.claimed": {
      const artifact = state.artifacts.get(event.payload.artifactId);
      if (artifact === undefined || artifact.kind !== "clue" || artifact.archived) {
        throw new Error(`clue artifact ${event.payload.artifactId} is not available`);
      }
      if (!isSameAudienceV2(event.audience, artifact.audience) || !isAudienceMemberV2(artifact.audience, event.sender)) {
        throw new Error(`clue ${artifact.artifactId} is not visible to the claimant`);
      }
      const character = state.latestCharacters.get(event.payload.characterId);
      if (character === undefined || character.ownerPeerId !== event.sender.seatId) {
        throw new Error("a clue may only be claimed for the claimant's room character");
      }
      if (character.name !== event.payload.characterName) {
        throw new Error("clue claim character name does not match the room character");
      }
      const claims = state.clueClaims.get(artifact.artifactId) ?? [];
      if (claims.some(({ seatId, characterId }) => seatId === event.sender.seatId && characterId === character.id)) {
        throw new Error(`clue ${artifact.artifactId} was already claimed by ${character.id}`);
      }
      state.clueClaims.set(artifact.artifactId, [...claims, {
        ...event.payload,
        seatId: event.sender.seatId,
        displayName: event.sender.displayName,
        claimedAt: event.occurredAt,
      }]);
      break;
    }
    case "clue.unclaimed": {
      const artifact = state.artifacts.get(event.payload.artifactId);
      if (artifact === undefined || artifact.kind !== "clue" || artifact.archived) {
        throw new Error(`clue artifact ${event.payload.artifactId} is not available`);
      }
      if (!isSameAudienceV2(event.audience, artifact.audience) || !isAudienceMemberV2(artifact.audience, event.sender)) {
        throw new Error(`clue ${artifact.artifactId} is not visible to the claimant`);
      }
      const character = state.latestCharacters.get(event.payload.characterId);
      if (character === undefined) {
        throw new Error(`clue claim character ${event.payload.characterId} does not exist`);
      }
      if (event.sender.role !== "host" && character.ownerPeerId !== event.sender.seatId) {
        throw new Error("a player may only remove their own clue claim");
      }
      if (character.name !== event.payload.characterName) {
        throw new Error("clue unclaim character name does not match the room character");
      }
      const claims = state.clueClaims.get(artifact.artifactId) ?? [];
      const targetSeatId = character.ownerPeerId;
      if (!claims.some(({ seatId, characterId }) => seatId === targetSeatId && characterId === character.id)) {
        throw new Error(`clue ${artifact.artifactId} is not claimed by ${character.id}`);
      }
      const remaining = claims.filter(
        ({ seatId, characterId }) => seatId !== targetSeatId || characterId !== character.id,
      );
      if (remaining.length === 0) state.clueClaims.delete(artifact.artifactId);
      else state.clueClaims.set(artifact.artifactId, remaining);
      break;
    }
    case "module.switched":
      state.activeModule = event.payload;
      break;
    case "room.settings.updated":
      if (event.sender.role !== "host") throw new Error("only the host may change room settings");
      if (event.payload.characterBriefing && event.audience.kind !== "room") throw new Error("character briefing must be public");
      if (event.payload.characterBriefing) state.characterBriefing = event.payload.characterBriefing;
      state.defaultVisibility = event.payload.defaultVisibility;
      break;
    case "artifact.upserted":
      applyArtifact(state, event.payload.artifact, event.audience);
      break;
    case "entity.upserted":
      applyEntity(state, event.payload.entity, event.audience);
      break;
    case "scene.focused": {
      if (event.sender.role !== "host") throw new Error("only the host may focus the current scene");
      const scene = state.entities.get(event.payload.sceneEntityId);
      if (scene === undefined) {
        throw new Error(`scene entity ${event.payload.sceneEntityId} does not exist`);
      }
      if (scene.kind !== "scene") {
        throw new Error(`entity ${scene.entityId} is not a scene`);
      }
      if (!isSameAudienceV2(event.audience, scene.audience)) {
        throw new Error(`scene focus must use scene ${scene.entityId} audience`);
      }
      state.activeSceneEntityId = scene.entityId;
      break;
    }
    case "npc.session.upserted":
      applyNpcSession(state, event.payload.session, event.audience);
      break;
    case "board.created":
      applyBoardCreated(state, event.payload.board, event.audience);
      break;
    case "board.updated":
      applyBoardUpdated(state, event.payload.board, event.audience);
      break;
    case "board.activated": {
      const board = requireBoard(state, event.payload.boardId);
      requireExactPayloadAudience(event.audience, board.audience, `board ${board.boardId}`);
      if (board.archived) throw new Error(`archived board ${board.boardId} cannot be activated`);
      state.activeBoardId = board.boardId;
      break;
    }
    case "board.item.upserted":
      applyBoardItemUpserted(
        state,
        event.payload.boardId,
        event.payload.boardRevision,
        event.payload.item,
        event.audience,
      );
      break;
    case "board.item.removed":
      applyBoardItemRemoved(
        state,
        event.payload.boardId,
        event.payload.boardRevision,
        event.payload.itemId,
        event.audience,
      );
      break;
    case "board.edge.upserted":
      applyBoardEdgeUpserted(
        state,
        event.payload.boardId,
        event.payload.boardRevision,
        event.payload.edge,
        event.audience,
      );
      break;
    case "board.edge.removed":
      applyBoardEdgeRemoved(
        state,
        event.payload.boardId,
        event.payload.boardRevision,
        event.payload.edgeId,
        event.audience,
      );
      break;
    case "board.fog.revealed":
      applyFogReveal(state, event.payload, event.audience);
      break;
    case "audience.expanded":
      // The expansion event itself may only expose a target identifier to the
      // resulting audience (or a narrower subset of it).
      if (!isAudienceSubsetV2(event.audience, event.payload.audience)) {
        throw new Error("audience expansion event is broader than its resulting audience");
      }
      applyAudienceExpansion(state, event.payload.target, event.payload.audience);
      break;
    case "npc.session.message": {
      const session = requireNpcSession(state, event.payload.sessionId);
      requirePayloadAudience(event.audience, session.audience, `NPC session ${session.sessionId}`);
      if (session.status !== "active") throw new Error(`NPC session ${session.sessionId} is not active`);
      const messages = state.npcMessages.get(session.sessionId) ?? [];
      if (messages.some(({ messageId }) => messageId === event.payload.messageId)) {
        throw new Error(`duplicate NPC session message ${event.payload.messageId}`);
      }
      state.npcMessages.set(session.sessionId, [
        ...messages,
        {
          ...event.payload,
          occurredAt: event.occurredAt,
          ...(event.payload.role === "human" ? { speakerDisplayName: event.sender.displayName } : {}),
        },
      ]);
      break;
    }
    case "audio.cued":
      state.activeAudio.set(event.payload.cueId, event.payload);
      break;
    case "audio.stopped":
      state.activeAudio.delete(event.payload.cueId);
      break;
  }

  state.eventAudiences.set(event.eventId, event.audience);
  const target = audienceTargetForEvent(event);
  if (target !== undefined) state.eventAudienceTargets.set(event.eventId, target);
  return freezeStateShape(state);
}

/** Sorts an unordered set of authoritative events and deterministically replays it. */
export function deriveRoomWorldStateV2(
  candidateEvents: readonly RoomEventV2[],
): RoomWorldStateV2 {
  const events = roomEventV2Schema.array().parse(candidateEvents);
  const roomIds = new Set<string>();
  const eventIds = new Set<string>();
  const sequences = new Set<number>();
  for (const event of events) {
    roomIds.add(event.roomId);
    if (eventIds.has(event.eventId)) throw new Error(`Duplicate V2 event ID: ${event.eventId}`);
    if (sequences.has(event.sequence)) {
      throw new Error(`Duplicate V2 event sequence: ${event.sequence}`);
    }
    eventIds.add(event.eventId);
    sequences.add(event.sequence);
  }
  if (roomIds.size > 1) throw new Error("Cannot derive a V2 world from multiple rooms");

  const roomId = events[0]?.roomId;
  let state = createRoomWorldStateV2(roomId);
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    state = reduceRoomWorldStateV2(state, event);
  }
  return state;
}

/** Replays a seat-specific stream while treating redacted headers as ordered no-ops. */
export function deriveRoomWorldStateFromViewsV2(
  candidateViews: readonly RoomEventViewV2[],
): RoomWorldStateV2 {
  const views = [...candidateViews].sort((left, right) => viewSequence(left) - viewSequence(right));
  let state = createRoomWorldStateV2(viewRoomId(views[0]));
  for (const view of views) {
    const sequence = viewSequence(view);
    if (sequence !== state.lastSequence + 1) {
      throw new Error(`V2 event view sequence ${sequence} does not follow ${state.lastSequence}`);
    }
    if (view.view === "redacted") {
      state = { ...state, lastSequence: sequence };
    } else {
      state = reduceRoomWorldStateV2(state, view.event);
    }
  }
  return state;
}

/** Alias for callers that name reducers after the event they apply. */
export const reduceRoomWorldEventV2 = reduceRoomWorldStateV2;

/** Projects an event using the effective audience reconstructed by the reducer. */
export function projectRoomEventFromWorldV2(
  state: RoomWorldStateV2,
  event: RoomEventV2,
  member: AudienceMemberV2,
): RoomEventViewV2 {
  const effectiveAudience = state.eventAudiences.get(event.eventId);
  return projectRoomEventV2(event, member, effectiveAudience);
}

interface MutableRoomWorldStateV2 {
  roomId: string;
  lastSequence: number;
  entities: Map<string, RoomEntityV2>;
  artifacts: Map<string, RoomArtifactV2>;
  boards: Map<string, BoardV1>;
  npcSessions: Map<string, NpcInteractionSessionV1>;
  npcMessages: Map<string, NpcSessionMessageV2[]>;
  latestCharacters: Map<string, Coc7Character>;
  tableSeats: Map<string, TableSeatV2>;
  checkRequests: Map<string, CheckRequestV2>;
  checkAuthorizations: Map<string, CheckAuthorizationV2>;
  checkClosures: Map<string, CheckClosureV2>;
  checkOutcomes: Map<string, CheckOutcomeV2>;
  clueClaims: Map<string, ClueClaimV2[]>;
  activeAudio: Map<string, ActiveAudioCueV2>;
  activeBoardId?: string;
  activeSceneEntityId?: string;
  activeModule?: { moduleId: string; revision: number; title: string };
  defaultVisibility: "public" | "secret";
  characterBriefing?: CharacterBriefingV1;
  eventAudiences: Map<string, AudienceV2>;
  eventAudienceTargets: Map<string, AudienceTargetV2>;
}

function requirePublicTableEvent(event: RoomEventV2): void {
  if (event.audience.kind !== "room") throw new Error("桌上座位变更必须让全房间可见");
}

function requireTableSeat(state: MutableRoomWorldStateV2, id: string): TableSeatV2 {
  const seat = state.tableSeats.get(id);
  if (!seat) throw new Error("座位不存在，请等待 KP 设置座位");
  return seat;
}

function requireTableControl(seat: TableSeatV2, sender: RoomEventV2["sender"]): void {
  if (sender.role !== "host" && seat.occupantSeatId !== sender.seatId) throw new Error("只能调整自己座位上的角色卡");
}

function requireCharacterNotAwaitingRoll(state: MutableRoomWorldStateV2, characterId?: string): void {
  if (characterId && [...state.checkRequests.values()].some((request) => request.characterId === characterId
    && !state.checkClosures.has(request.requestId) && !state.checkAuthorizations.get(request.requestId)?.resolvedByEventId)) {
    throw new Error("这张角色卡还有未完成的检定，请先完成或取消检定再调整座位");
  }
}

function transferTableCharacter(state: MutableRoomWorldStateV2, seat: TableSeatV2, ownerSeatId: string, updatedAt: string, playerName?: string): void {
  requireCharacterNotAwaitingRoll(state, seat.characterId);
  const character = seat.characterId ? state.latestCharacters.get(seat.characterId) : undefined;
  if (!character || character.ownerPeerId === ownerSeatId) return;
  state.latestCharacters.set(character.id, { ...character, ownerPeerId: ownerSeatId, updatedAt, ...(playerName ? { playerName } : {}) });
  // Existing tokens follow the same explicit transfer, including after replay.
  for (const entity of state.entities.values()) if (entity.kind === "character" && entity.data.characterId === character.id
    && (typeof entity.data.ownerSeatId !== "string" || entity.data.ownerSeatId === character.ownerPeerId)) {
    state.entities.set(entity.entityId, { ...entity, revision: entity.revision + 1, data: { ...entity.data, ownerSeatId } });
  }
}

function applyArtifact(
  state: MutableRoomWorldStateV2,
  artifact: RoomArtifactV2,
  eventAudience: AudienceV2,
): void {
  requirePayloadAudience(eventAudience, artifact.audience, `artifact ${artifact.artifactId}`);
  const previous = state.artifacts.get(artifact.artifactId);
  requireNextRevision(previous?.revision, artifact.revision, `artifact ${artifact.artifactId}`);
  if (previous !== undefined) {
    if (previous.kind !== artifact.kind) {
      throw new Error(`artifact ${artifact.artifactId} cannot change kind`);
    }
    expandAudienceV2(previous.audience, artifact.audience);
  }
  state.artifacts.set(artifact.artifactId, artifact);
}

function applyEntity(
  state: MutableRoomWorldStateV2,
  entity: RoomEntityV2,
  eventAudience: AudienceV2,
): void {
  requirePayloadAudience(eventAudience, entity.audience, `entity ${entity.entityId}`);
  const previous = state.entities.get(entity.entityId);
  requireNextRevision(previous?.revision, entity.revision, `entity ${entity.entityId}`);
  if (previous !== undefined) {
    if (previous.kind !== entity.kind) throw new Error(`entity ${entity.entityId} cannot change kind`);
    expandAudienceV2(previous.audience, entity.audience);
  }
  for (const artifactId of entity.artifactIds) {
    const artifact = requireArtifact(state, artifactId);
    if (!isAudienceSubsetV2(entity.audience, artifact.audience)) {
      throw new Error(`entity ${entity.entityId} exposes artifact ${artifactId} beyond its audience`);
    }
  }
  state.entities.set(entity.entityId, entity);
}

function applyNpcSession(
  state: MutableRoomWorldStateV2,
  session: NpcInteractionSessionV1,
  eventAudience: AudienceV2,
): void {
  requirePayloadAudience(eventAudience, session.audience, `NPC session ${session.sessionId}`);
  const npc = state.entities.get(session.npcEntityId);
  if (npc?.kind !== "npc") {
    throw new Error(`NPC session ${session.sessionId} requires an existing NPC entity`);
  }
  if (!isAudienceSubsetV2(session.audience, npc.audience)) {
    throw new Error(`NPC session ${session.sessionId} is broader than its NPC audience`);
  }
  const previous = state.npcSessions.get(session.sessionId);
  requireNextRevision(previous?.revision, session.revision, `NPC session ${session.sessionId}`);
  if (previous !== undefined) {
    if (previous.npcEntityId !== session.npcEntityId) {
      throw new Error(`NPC session ${session.sessionId} cannot change NPC`);
    }
    expandAudienceV2(previous.audience, session.audience);
    if (previous.status === "closed") throw new Error(`closed NPC session ${session.sessionId} cannot be updated`);
  }
  state.npcSessions.set(session.sessionId, session);
}

function applyBoardCreated(
  state: MutableRoomWorldStateV2,
  candidateBoard: BoardV1,
  eventAudience: AudienceV2,
): void {
  const board = boardV1Schema.parse(candidateBoard);
  requireExactPayloadAudience(eventAudience, board.audience, `board ${board.boardId}`);
  if (state.boards.has(board.boardId)) throw new Error(`board ${board.boardId} already exists`);
  requireNextRevision(undefined, board.revision, `board ${board.boardId}`);
  validateBoardReferences(state, board);
  state.boards.set(board.boardId, cloneBoard(board));
}

function applyBoardUpdated(
  state: MutableRoomWorldStateV2,
  candidateBoard: BoardV1,
  eventAudience: AudienceV2,
): void {
  const board = boardV1Schema.parse(candidateBoard);
  const previous = requireBoard(state, board.boardId);
  requireNextRevision(previous.revision, board.revision, `board ${board.boardId}`);
  requireExactPayloadAudience(eventAudience, board.audience, `board ${board.boardId}`);
  if (previous.kind !== board.kind) throw new Error(`board ${board.boardId} cannot change kind`);
  expandAudienceV2(previous.audience, board.audience);
  validateBoardReferences(state, board);
  state.boards.set(board.boardId, cloneBoard(board));
  if (board.archived && state.activeBoardId === board.boardId) state.activeBoardId = undefined;
}

function applyBoardItemUpserted(
  state: MutableRoomWorldStateV2,
  boardId: string,
  boardRevision: number,
  item: BoardItemV1,
  eventAudience: AudienceV2,
): void {
  const board = requireBoard(state, boardId);
  requireNextRevision(board.revision, boardRevision, `board ${boardId}`);
  requireExactPayloadAudience(eventAudience, item.audience, `board item ${item.itemId}`);
  validateBoardItem(state, board, item);
  const previous = board.items.find(({ itemId }) => itemId === item.itemId);
  if (previous !== undefined) {
    if (JSON.stringify(previous.reference) !== JSON.stringify(item.reference)) {
      throw new Error(`board item ${item.itemId} cannot change reference`);
    }
    expandAudienceV2(previous.audience, item.audience);
  }
  const items = previous === undefined
    ? [...board.items, item]
    : board.items.map((candidate) => candidate.itemId === item.itemId ? item : candidate);
  state.boards.set(boardId, { ...board, revision: boardRevision, items });
}

function applyBoardItemRemoved(
  state: MutableRoomWorldStateV2,
  boardId: string,
  boardRevision: number,
  itemId: string,
  eventAudience: AudienceV2,
): void {
  const board = requireBoard(state, boardId);
  requireNextRevision(board.revision, boardRevision, `board ${boardId}`);
  requireExactPayloadAudience(eventAudience, board.audience, `board ${boardId}`);
  if (!board.items.some((item) => item.itemId === itemId)) {
    throw new Error(`board item ${itemId} does not exist on ${boardId}`);
  }
  state.boards.set(boardId, {
    ...board,
    revision: boardRevision,
    items: board.items.filter((item) => item.itemId !== itemId),
    edges: board.edges.filter(
      (edge) => edge.fromItemId !== itemId && edge.toItemId !== itemId,
    ),
  });
}

function applyBoardEdgeUpserted(
  state: MutableRoomWorldStateV2,
  boardId: string,
  boardRevision: number,
  edge: BoardEdgeV1,
  eventAudience: AudienceV2,
): void {
  const board = requireBoard(state, boardId);
  requireNextRevision(board.revision, boardRevision, `board ${boardId}`);
  requireExactPayloadAudience(eventAudience, edge.audience, `board edge ${edge.edgeId}`);
  validateBoardEdge(board, edge);
  const previous = board.edges.find(({ edgeId }) => edgeId === edge.edgeId);
  if (previous !== undefined) {
    if (
      previous.fromItemId !== edge.fromItemId ||
      previous.toItemId !== edge.toItemId
    ) {
      throw new Error(`board edge ${edge.edgeId} cannot change endpoints`);
    }
    expandAudienceV2(previous.audience, edge.audience);
  }
  const edges = previous === undefined
    ? [...board.edges, edge]
    : board.edges.map((candidate) => candidate.edgeId === edge.edgeId ? edge : candidate);
  state.boards.set(boardId, { ...board, revision: boardRevision, edges });
}

function applyBoardEdgeRemoved(
  state: MutableRoomWorldStateV2,
  boardId: string,
  boardRevision: number,
  edgeId: string,
  eventAudience: AudienceV2,
): void {
  const board = requireBoard(state, boardId);
  requireNextRevision(board.revision, boardRevision, `board ${boardId}`);
  requireExactPayloadAudience(eventAudience, board.audience, `board ${boardId}`);
  if (!board.edges.some((edge) => edge.edgeId === edgeId)) {
    throw new Error(`board edge ${edgeId} does not exist on ${boardId}`);
  }
  state.boards.set(boardId, {
    ...board,
    revision: boardRevision,
    edges: board.edges.filter((edge) => edge.edgeId !== edgeId),
  });
}

function applyFogReveal(
  state: MutableRoomWorldStateV2,
  payload: Extract<RoomEventV2, { type: "board.fog.revealed" }>['payload'],
  eventAudience: AudienceV2,
): void {
  const board = requireBoard(state, payload.boardId);
  requireNextRevision(board.revision, payload.boardRevision, `board ${board.boardId}`);
  const mask = board.fogMask;
  if (mask === undefined || mask.maskId !== payload.maskId) {
    throw new Error(`fog mask ${payload.maskId} does not exist on ${board.boardId}`);
  }
  requireNextRevision(mask.revision, payload.maskRevision, `fog mask ${mask.maskId}`);
  requireExactPayloadAudience(eventAudience, mask.audience, `fog mask ${mask.maskId}`);
  if (mask.revealedRegions.some(({ regionId }) => regionId === payload.region.regionId)) {
    throw new Error(`fog region ${payload.region.regionId} has already been revealed`);
  }
  state.boards.set(board.boardId, {
    ...board,
    revision: payload.boardRevision,
    fogMask: {
      ...mask,
      revision: payload.maskRevision,
      revealedRegions: [...mask.revealedRegions, payload.region],
    },
  });
}

function applyAudienceExpansion(
  state: MutableRoomWorldStateV2,
  target: AudienceTargetV2,
  next: AudienceV2,
): void {
  switch (target.kind) {
    case "event": {
      const current = state.eventAudiences.get(target.eventId);
      if (current === undefined) throw new Error(`V2 event ${target.eventId} does not exist`);
      state.eventAudiences.set(target.eventId, expandAudienceV2(current, next));
      return;
    }
    case "artifact": {
      const current = requireArtifact(state, target.artifactId);
      state.artifacts.set(target.artifactId, {
        ...current,
        audience: expandAudienceV2(current.audience, next),
      });
      expandTargetEventAudiences(state, target, next);
      return;
    }
    case "entity": {
      const current = requireEntity(state, target.entityId);
      for (const artifactId of current.artifactIds) {
        const artifact = requireArtifact(state, artifactId);
        if (!isAudienceSubsetV2(next, artifact.audience)) {
          throw new Error(`expanded entity audience exceeds artifact ${artifactId}`);
        }
      }
      state.entities.set(target.entityId, {
        ...current,
        audience: expandAudienceV2(current.audience, next),
      });
      expandTargetEventAudiences(state, target, next);
      return;
    }
    case "npc-session": {
      const current = requireNpcSession(state, target.sessionId);
      const npc = requireEntity(state, current.npcEntityId);
      if (!isAudienceSubsetV2(next, npc.audience)) {
        throw new Error(`expanded NPC session audience exceeds NPC ${npc.entityId}`);
      }
      state.npcSessions.set(target.sessionId, {
        ...current,
        audience: expandAudienceV2(current.audience, next),
      });
      expandTargetEventAudiences(state, target, next);
      return;
    }
    case "board": {
      const current = requireBoard(state, target.boardId);
      if (current.items.length > 0 || current.edges.length > 0 || current.fogMask !== undefined) {
        throw new Error(
          `non-empty board ${current.boardId} must expand visibility through a new board.updated snapshot`,
        );
      }
      if (current.backgroundArtifactId !== undefined) {
        const background = requireArtifact(state, current.backgroundArtifactId);
        if (!isAudienceSubsetV2(next, background.audience)) {
          throw new Error(`expanded board audience exceeds its background artifact audience`);
        }
      }
      state.boards.set(target.boardId, {
        ...current,
        audience: expandAudienceV2(current.audience, next),
      });
      expandTargetEventAudiences(state, target, next);
      return;
    }
    case "board-item": {
      const board = requireBoard(state, target.boardId);
      const current = board.items.find(({ itemId }) => itemId === target.itemId);
      if (current === undefined) throw new Error(`board item ${target.itemId} does not exist`);
      if (!isAudienceSubsetV2(next, board.audience)) {
        throw new Error(`expanded item audience exceeds board ${board.boardId}`);
      }
      validateReferenceAudience(state, current.reference, next);
      state.boards.set(board.boardId, {
        ...board,
        items: board.items.map((item) => item.itemId === current.itemId
          ? { ...item, audience: expandAudienceV2(item.audience, next) }
          : item),
      });
      expandTargetEventAudiences(state, target, next);
      return;
    }
    case "board-edge": {
      const board = requireBoard(state, target.boardId);
      const current = board.edges.find(({ edgeId }) => edgeId === target.edgeId);
      if (current === undefined) throw new Error(`board edge ${target.edgeId} does not exist`);
      const expanded = { ...current, audience: expandAudienceV2(current.audience, next) };
      validateBoardEdge(board, expanded);
      state.boards.set(board.boardId, {
        ...board,
        edges: board.edges.map((edge) => edge.edgeId === current.edgeId ? expanded : edge),
      });
      expandTargetEventAudiences(state, target, next);
      return;
    }
    case "fog-mask": {
      const board = requireBoard(state, target.boardId);
      const current = board.fogMask;
      if (current === undefined || current.maskId !== target.maskId) {
        throw new Error(`fog mask ${target.maskId} does not exist`);
      }
      if (!isAudienceSubsetV2(next, board.audience)) {
        throw new Error(`expanded fog audience exceeds board ${board.boardId}`);
      }
      state.boards.set(board.boardId, {
        ...board,
        fogMask: { ...current, audience: expandAudienceV2(current.audience, next) },
      });
      expandTargetEventAudiences(state, target, next);
    }
  }
}

function expandTargetEventAudiences(
  state: MutableRoomWorldStateV2,
  target: AudienceTargetV2,
  next: AudienceV2,
): void {
  const key = audienceTargetKey(target);
  for (const [eventId, candidate] of state.eventAudienceTargets) {
    if (audienceTargetKey(candidate) !== key) continue;
    const current = state.eventAudiences.get(eventId);
    if (current !== undefined) state.eventAudiences.set(eventId, expandAudienceV2(current, next));
  }
}

function audienceTargetForEvent(event: RoomEventV2): AudienceTargetV2 | undefined {
  switch (event.type) {
    case "artifact.upserted":
      return { kind: "artifact", artifactId: event.payload.artifact.artifactId };
    case "entity.upserted":
      return { kind: "entity", entityId: event.payload.entity.entityId };
    case "scene.focused":
      return { kind: "entity", entityId: event.payload.sceneEntityId };
    case "npc.session.upserted":
      return { kind: "npc-session", sessionId: event.payload.session.sessionId };
    case "board.created":
    case "board.updated":
      return { kind: "board", boardId: event.payload.board.boardId };
    case "board.item.upserted":
      return { kind: "board-item", boardId: event.payload.boardId, itemId: event.payload.item.itemId };
    case "board.edge.upserted":
      return { kind: "board-edge", boardId: event.payload.boardId, edgeId: event.payload.edge.edgeId };
    case "board.fog.revealed":
      return { kind: "fog-mask", boardId: event.payload.boardId, maskId: event.payload.maskId };
    default:
      return undefined;
  }
}

function audienceTargetKey(target: AudienceTargetV2): string {
  switch (target.kind) {
    case "event": return `event:${target.eventId}`;
    case "artifact": return `artifact:${target.artifactId}`;
    case "entity": return `entity:${target.entityId}`;
    case "npc-session": return `npc-session:${target.sessionId}`;
    case "board": return `board:${target.boardId}`;
    case "board-item": return `board-item:${target.boardId}:${target.itemId}`;
    case "board-edge": return `board-edge:${target.boardId}:${target.edgeId}`;
    case "fog-mask": return `fog-mask:${target.boardId}:${target.maskId}`;
  }
}

function validateBoardReferences(state: MutableRoomWorldStateV2, board: BoardV1): void {
  if (board.backgroundArtifactId !== undefined) {
    const artifact = requireArtifact(state, board.backgroundArtifactId);
    if (!isAudienceSubsetV2(board.audience, artifact.audience)) {
      throw new Error(`board ${board.boardId} is broader than its background artifact audience`);
    }
  }
  for (const item of board.items) validateBoardItem(state, board, item);
  for (const edge of board.edges) validateBoardEdge(board, edge);
}

function validateBoardItem(
  state: MutableRoomWorldStateV2,
  board: BoardV1,
  item: BoardItemV1,
): void {
  if (!isSameAudienceV2(item.audience, board.audience)) {
    throw new Error(`board item ${item.itemId} must use board ${board.boardId} audience`);
  }
  // A public board must never advertise the existence/ID of a secret
  // reference, even when the individual item event is targeted. Every viewer
  // of the board must already be entitled to the referenced content.
  validateReferenceAudience(state, item.reference, board.audience);
}

function validateReferenceAudience(
  state: MutableRoomWorldStateV2,
  reference: BoardItemReferenceV1,
  audience: AudienceV2,
): void {
  let targetAudience: AudienceV2 | undefined;
  let label: string | undefined;
  switch (reference.kind) {
    case "text":
      return;
    case "entity": {
      const entity = requireEntity(state, reference.entityId);
      targetAudience = entity.audience;
      label = `entity ${reference.entityId}`;
      break;
    }
    case "artifact": {
      const artifact = requireArtifact(state, reference.artifactId);
      targetAudience = artifact.audience;
      label = `artifact ${reference.artifactId}`;
      break;
    }
    case "npc-session": {
      const session = requireNpcSession(state, reference.sessionId);
      targetAudience = session.audience;
      label = `NPC session ${reference.sessionId}`;
      break;
    }
  }
  if (!isAudienceSubsetV2(audience, targetAudience)) {
    throw new Error(`board item audience exceeds referenced ${label}`);
  }
}

function validateBoardEdge(board: BoardV1, edge: BoardEdgeV1): void {
  const from = board.items.find(({ itemId }) => itemId === edge.fromItemId);
  const to = board.items.find(({ itemId }) => itemId === edge.toItemId);
  if (from === undefined || to === undefined) {
    throw new Error(`board edge ${edge.edgeId} endpoints must exist on ${board.boardId}`);
  }
  if (
    !isSameAudienceV2(edge.audience, board.audience) ||
    !isSameAudienceV2(edge.audience, from.audience) ||
    !isSameAudienceV2(edge.audience, to.audience)
  ) {
    throw new Error(`board edge ${edge.edgeId} must use its board and endpoint audience`);
  }
}

function requirePayloadAudience(
  eventAudience: AudienceV2,
  payloadAudience: AudienceV2,
  label: string,
): void {
  if (!isAudienceSubsetV2(eventAudience, payloadAudience)) {
    throw new Error(`event audience exposes ${label} beyond its audience`);
  }
}

function requireExactPayloadAudience(
  eventAudience: AudienceV2,
  payloadAudience: AudienceV2,
  label: string,
): void {
  if (!isSameAudienceV2(eventAudience, payloadAudience)) {
    throw new Error(`event audience must match ${label} audience`);
  }
}

function requireNextRevision(
  previous: number | undefined,
  next: number,
  label: string,
): void {
  const expected = previous === undefined ? 1 : previous + 1;
  if (next !== expected) {
    throw new Error(`${label} revision conflict: expected ${expected}, received ${next}`);
  }
}

function requireArtifact(state: MutableRoomWorldStateV2, artifactId: string): RoomArtifactV2 {
  const artifact = state.artifacts.get(artifactId);
  if (artifact === undefined) throw new Error(`artifact ${artifactId} does not exist`);
  return artifact;
}

function requireEntity(state: MutableRoomWorldStateV2, entityId: string): RoomEntityV2 {
  const entity = state.entities.get(entityId);
  if (entity === undefined) throw new Error(`entity ${entityId} does not exist`);
  return entity;
}

function requireBoard(state: MutableRoomWorldStateV2, boardId: string): BoardV1 {
  const board = state.boards.get(boardId);
  if (board === undefined) throw new Error(`board ${boardId} does not exist`);
  return board;
}

/** Only exact repeats are machine-rejected. Whether a changed description is
 * substantively different remains a Keeper ruling. */
function normalizeCheckApproach(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function requireNpcSession(
  state: MutableRoomWorldStateV2,
  sessionId: string,
): NpcInteractionSessionV1 {
  const session = state.npcSessions.get(sessionId);
  if (session === undefined) throw new Error(`NPC session ${sessionId} does not exist`);
  return session;
}

function cloneBoard(board: BoardV1): BoardV1 {
  return {
    ...board,
    items: board.items.map((item) => ({
      ...item,
      reference: { ...item.reference },
      position: { ...item.position },
      ...(item.size === undefined ? {} : { size: { ...item.size } }),
      extensions: { ...item.extensions },
    })),
    edges: board.edges.map((edge) => ({ ...edge, extensions: { ...edge.extensions } })),
    ...(board.fogMask === undefined
      ? {}
      : {
          fogMask: {
            ...board.fogMask,
            revealedRegions: board.fogMask.revealedRegions.map((region) => ({
              ...region,
              points: region.points.map((point) => ({ ...point })),
            })),
            extensions: { ...board.fogMask.extensions },
          },
        }),
    extensions: { ...board.extensions },
  };
}

function freezeStateShape(state: MutableRoomWorldStateV2): RoomWorldStateV2 {
  return {
    roomId: state.roomId,
    lastSequence: state.lastSequence,
    entities: new Map(state.entities),
    artifacts: new Map(state.artifacts),
    boards: new Map(state.boards),
    npcSessions: new Map(state.npcSessions),
    npcMessages: new Map(
      [...state.npcMessages].map(([sessionId, messages]) => [sessionId, [...messages]]),
    ),
    latestCharacters: new Map(state.latestCharacters),
    tableSeats: new Map(state.tableSeats),
    checkRequests: new Map(state.checkRequests),
    checkAuthorizations: new Map(state.checkAuthorizations),
    checkClosures: new Map(state.checkClosures),
    checkOutcomes: new Map(state.checkOutcomes),
    clueClaims: new Map(
      [...state.clueClaims].map(([artifactId, claims]) => [artifactId, [...claims]]),
    ),
    activeAudio: new Map(state.activeAudio),
    ...(state.activeBoardId === undefined ? {} : { activeBoardId: state.activeBoardId }),
    ...(state.activeSceneEntityId === undefined
      ? {}
      : { activeSceneEntityId: state.activeSceneEntityId }),
    ...(state.activeModule === undefined ? {} : { activeModule: { ...state.activeModule } }),
    defaultVisibility: state.defaultVisibility,
    ...(state.characterBriefing === undefined ? {} : { characterBriefing: { ...state.characterBriefing, recommendedSkills: [...state.characterBriefing.recommendedSkills] } }),
    eventAudiences: new Map(state.eventAudiences),
    eventAudienceTargets: new Map(state.eventAudienceTargets),
  };
}

function viewSequence(view: RoomEventViewV2): number {
  return view.view === "full" ? view.event.sequence : view.sequence;
}

function viewRoomId(view: RoomEventViewV2 | undefined): string | undefined {
  return view?.view === "full" ? view.event.roomId : view?.roomId;
}
