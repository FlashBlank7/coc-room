import { describe, expect, it } from "vitest";

import {
  boardV1Schema,
  deriveRoomWorldStateFromViewsV2,
  deriveRoomWorldStateV2,
  npcInteractionSessionV1Schema,
  projectRoomEventFromWorldV2,
  projectRoomEventV2,
  reduceRoomWorldStateV2,
  roomEntityV2Schema,
  roomEventV2Schema,
  type AudienceV2,
  type BoardItemV1,
  type BoardV1,
  type RoomArtifactV2,
  type RoomEntityV2,
  type RoomEventV2,
  type NpcInteractionSessionV1,
  type SeatV2,
} from "../src";

const HOST: SeatV2 = {
  seatId: "seat-host",
  role: "host",
  displayName: "守秘人",
  peerId: "peer-host",
  extensions: {},
};

const ALICE: SeatV2 = {
  seatId: "seat-alice",
  role: "player",
  displayName: "Alice",
  peerId: "peer-alice",
  extensions: {},
};

const BOB: SeatV2 = {
  seatId: "seat-bob",
  role: "player",
  displayName: "Bob",
  peerId: "peer-bob",
  extensions: {},
};

const ROOM: AudienceV2 = { kind: "room" };
const ALICE_ONLY: AudienceV2 = { kind: "seats", seatIds: [ALICE.seatId] };
const BOB_ONLY: AudienceV2 = { kind: "seats", seatIds: [BOB.seatId] };
const ALICE_AND_BOB: AudienceV2 = {
  kind: "seats",
  seatIds: [ALICE.seatId, BOB.seatId],
};

describe("RoomEventV2 audience views", () => {
  it("returns a payload only to targeted seats and always lets the host inspect it", () => {
    const secret = entityEvent(1, entity("clue-secret", "clue", ALICE_ONLY), ALICE_ONLY);

    expect(projectRoomEventV2(secret, ALICE)).toMatchObject({
      view: "full",
      event: { eventId: secret.eventId, type: "entity.upserted" },
    });
    const bobView = projectRoomEventV2(secret, BOB);
    expect(bobView).toEqual({
      view: "redacted",
      protocolVersion: 2,
      roomId: "room-v2",
      eventId: secret.eventId,
      sequence: 1,
      occurredAt: timestamp(1),
    });
    expect(bobView).not.toHaveProperty("type");
    expect(bobView).not.toHaveProperty("payload");
    expect(bobView).not.toHaveProperty("audience");
    expect(projectRoomEventV2(secret, HOST).view).toBe("full");
  });

  it("replays monotonic event and entity audience expansions", () => {
    const secret = entityEvent(1, entity("clue-expand", "clue", ALICE_ONLY), ALICE_ONLY);
    const expandEvent = event(2, {
      type: "audience.expanded",
      audience: ALICE_AND_BOB,
      payload: {
        target: { kind: "event", eventId: secret.eventId },
        audience: ALICE_AND_BOB,
      },
    });
    const expandEntity = event(3, {
      type: "audience.expanded",
      audience: ROOM,
      payload: {
        target: { kind: "entity", entityId: "clue-expand" },
        audience: ROOM,
      },
    });

    const state = deriveRoomWorldStateV2([expandEntity, secret, expandEvent]);
    // Expanding a content target durably reveals its complete revision
    // history; publishing only a sanitized current value uses a new ID.
    expect(state.eventAudiences.get(secret.eventId)).toEqual(ROOM);
    expect(state.entities.get("clue-expand")?.audience).toEqual(ROOM);
    expect(projectRoomEventFromWorldV2(state, secret, BOB).view).toBe("full");
  });
});

describe("V2 check event evolution", () => {
  it("parses legacy and enriched check events while requiring closure text", () => {
    const legacyRequest = event(1, {
      type: "check.requested",
      audience: ROOM,
      payload: {
        requestId: "check-legacy",
        characterId: "character-legacy",
        characterName: "Legacy Investigator",
        skillName: "Spot Hidden",
        proposedTarget: 55,
        reason: "Search the desk",
      },
    }, ALICE);
    expect(legacyRequest.type).toBe("check.requested");

    const enrichedRequest = event(2, {
      type: "check.requested",
      audience: ROOM,
      payload: {
        requestId: "check-enriched",
        characterId: "character-enriched",
        characterName: "Enriched Investigator",
        skillName: "Spot Hidden",
        proposedTarget: 60,
        goal: "Find who used the room last",
        approach: "Compare dust patterns around every drawer",
        suggestedSkillName: "Spot Hidden",
        reason: "Inspect the desk for recent use",
      },
    }, ALICE);
    expect(enrichedRequest).toMatchObject({
      payload: {
        goal: "Find who used the room last",
        suggestedSkillName: "Spot Hidden",
      },
    });

    const legacyAuthorization = event(3, {
      type: "check.authorized",
      audience: ROOM,
      payload: {
        requestId: "check-legacy",
        target: 55,
        requiredDifficulty: "regular",
        bonusDice: 0,
        penaltyDice: 0,
        note: "Legacy authorization",
      },
    });
    expect(legacyAuthorization.type).toBe("check.authorized");
    expect(event(4, {
      type: "check.authorized",
      audience: ROOM,
      payload: {
        requestId: "check-enriched",
        skillName: "Listen",
        target: 50,
        requiredDifficulty: "hard",
        bonusDice: 0,
        penaltyDice: 0,
        note: "Keeper-selected skill",
      },
    })).toMatchObject({ payload: { skillName: "Listen" } });

    expect(() => event(5, {
      type: "check.closed",
      audience: ROOM,
      payload: { requestId: "check-legacy", outcome: "no-roll", note: "" },
    })).toThrow();
  });

  it("projects a targeted check outcome without leaking its text", () => {
    const outcome = event(1, {
      type: "check.outcome.described",
      audience: ALICE_ONLY,
      payload: { requestId: "check-secret", text: "Only Alice learns what the roll changed." },
    });

    expect(projectRoomEventV2(outcome, ALICE)).toMatchObject({
      view: "full",
      event: { type: "check.outcome.described" },
    });
    const bobView = projectRoomEventV2(outcome, BOB);
    expect(bobView).toMatchObject({ view: "redacted", eventId: outcome.eventId });
    expect(JSON.stringify(bobView)).not.toContain("Only Alice");
  });
});

describe("RoomWorldStateV2 revisions and placement", () => {
  it("replays and clones the host's authoritative current scene", () => {
    const scene = entity("scene-reading-room", "scene", ROOM);
    const created = entityEvent(1, scene, ROOM);
    const focused = event(2, {
      type: "scene.focused",
      audience: ROOM,
      payload: { sceneEntityId: scene.entityId },
    });

    expect(roomEventV2Schema.safeParse({
      ...focused,
      payload: { sceneEntityId: scene.entityId, unexpected: true },
    }).success).toBe(false);

    const beforeFocus = deriveRoomWorldStateV2([created]);
    const afterFocus = reduceRoomWorldStateV2(beforeFocus, focused);
    expect(beforeFocus.activeSceneEntityId).toBeUndefined();
    expect(afterFocus.activeSceneEntityId).toBe(scene.entityId);
    expect(afterFocus.entities).not.toBe(beforeFocus.entities);

    const replayed = deriveRoomWorldStateV2([
      event(3, {
        type: "system.notice",
        audience: ROOM,
        payload: { message: "调查继续", level: "info" },
      }),
      focused,
      created,
    ]);
    expect(replayed.activeSceneEntityId).toBe(scene.entityId);
    expect(replayed.eventAudiences.get(focused.eventId)).toEqual(ROOM);
    expect(replayed.eventAudienceTargets.get(focused.eventId)).toEqual({
      kind: "entity",
      entityId: scene.entityId,
    });
  });

  it("rejects an invalid or unauthorized current-scene focus", () => {
    const location = entity("location-library", "location", ROOM);
    const scene = entity("scene-secret-library", "scene", ALICE_ONLY);

    expect(() => deriveRoomWorldStateV2([
      event(1, {
        type: "scene.focused",
        audience: ROOM,
        payload: { sceneEntityId: "scene-missing" },
      }),
    ])).toThrow(/does not exist/i);

    expect(() => deriveRoomWorldStateV2([
      entityEvent(1, location, ROOM),
      event(2, {
        type: "scene.focused",
        audience: ROOM,
        payload: { sceneEntityId: location.entityId },
      }),
    ])).toThrow(/not a scene/i);

    expect(() => deriveRoomWorldStateV2([
      entityEvent(1, scene, ALICE_ONLY),
      event(2, {
        type: "scene.focused",
        audience: ROOM,
        payload: { sceneEntityId: scene.entityId },
      }),
    ])).toThrow(/must use scene .* audience/i);

    expect(() => deriveRoomWorldStateV2([
      entityEvent(1, entity("scene-public", "scene", ROOM), ROOM),
      event(2, {
        type: "scene.focused",
        audience: ROOM,
        payload: { sceneEntityId: "scene-public" },
      }, ALICE),
    ])).toThrow(/only the host/i);
  });

  it("expands current-scene event visibility with its scene entity", () => {
    const scene = entity("scene-expand", "scene", ALICE_ONLY);
    const focused = event(2, {
      type: "scene.focused",
      audience: ALICE_ONLY,
      payload: { sceneEntityId: scene.entityId },
    });
    const state = deriveRoomWorldStateV2([
      entityEvent(1, scene, ALICE_ONLY),
      focused,
      event(3, {
        type: "audience.expanded",
        audience: ROOM,
        payload: {
          target: { kind: "entity", entityId: scene.entityId },
          audience: ROOM,
        },
      }),
    ]);

    expect(state.activeSceneEntityId).toBe(scene.entityId);
    expect(state.eventAudiences.get(focused.eventId)).toEqual(ROOM);
    expect(projectRoomEventFromWorldV2(state, focused, BOB).view).toBe("full");
  });

  it("rejects conflicting artifact revisions", () => {
    const first = artifact("artifact-map", 1);
    const skipped = artifact("artifact-map", 3);
    expect(() => deriveRoomWorldStateV2([
      artifactEvent(1, first),
      artifactEvent(2, skipped),
    ])).toThrow(/artifact artifact-map revision conflict: expected 2, received 3/i);

    const reused = { ...first, title: "conflicting revision" };
    expect(() => deriveRoomWorldStateV2([
      artifactEvent(1, first),
      artifactEvent(2, reused),
    ])).toThrow(/revision conflict/i);
  });

  it("places one location-independent NPC on multiple boards", () => {
    const npc = entity("npc-curator", "npc", ROOM);
    expect(roomEntityV2Schema.safeParse({ ...npc, locationId: "location-secret" }).success).toBe(false);

    const session = event(2, {
      type: "npc.session.upserted",
      audience: ROOM,
      payload: {
        session: {
          schemaVersion: 1,
          sessionId: "npc-session-curator",
          revision: 1,
          npcEntityId: npc.entityId,
          title: "与馆长交谈",
          description: "公开交互",
          status: "active",
          audience: ROOM,
          provider: "codex",
          model: "",
          autoReply: false,
          mode: "shadow",
          pinnedContext: [],
          startedAt: timestamp(2),
          extensions: {},
        },
      },
    });
    const firstItem = item("npc-on-scene", { kind: "entity", entityId: npc.entityId });
    const secondItem = item("npc-on-evidence", { kind: "entity", entityId: npc.entityId });
    const events = [
      entityEvent(1, npc, ROOM),
      session,
      boardEvent(3, board("board-scene", "scene", [firstItem])),
      boardEvent(4, board("board-evidence", "evidence", [secondItem])),
    ];

    const state = deriveRoomWorldStateV2(events);
    expect(state.npcSessions.get("npc-session-curator")?.npcEntityId).toBe(npc.entityId);
    expect(state.boards.get("board-scene")?.items[0]?.reference).toEqual({
      kind: "entity",
      entityId: npc.entityId,
    });
    expect(state.boards.get("board-evidence")?.items[0]?.reference).toEqual({
      kind: "entity",
      entityId: npc.entityId,
    });
    expect(state.entities.get(npc.entityId)).not.toHaveProperty("locationId");
  });

  it("keeps the authoritative human speaker name with an NPC panel message", () => {
    const npc = entity("npc-panel-speaker", "npc", ALICE_ONLY);
    const session = event(2, {
      type: "npc.session.upserted",
      audience: ALICE_ONLY,
      payload: {
        session: {
          schemaVersion: 1,
          sessionId: "npc-session-speaker",
          revision: 1,
          npcEntityId: npc.entityId,
          title: "与门房交谈",
          description: "定向交谈",
          status: "active",
          audience: ALICE_ONLY,
          provider: "codex",
          model: "",
          autoReply: false,
          mode: "shadow",
          pinnedContext: [],
          startedAt: timestamp(2),
          extensions: {},
        },
      },
    });
    const message = event(3, {
      type: "npc.session.message",
      audience: ALICE_ONLY,
      payload: {
        sessionId: "npc-session-speaker",
        messageId: eventId(30),
        role: "human",
        speakerSeatId: ALICE.seatId,
        spokenText: "昨晚是谁关的门？",
      },
    }, ALICE);

    const state = deriveRoomWorldStateV2([
      entityEvent(1, npc, ALICE_ONLY),
      session,
      message,
    ]);

    expect(state.npcMessages.get("npc-session-speaker")?.[0]).toMatchObject({
      speakerSeatId: ALICE.seatId,
      speakerDisplayName: "Alice",
      spokenText: "昨晚是谁关的门？",
    });
  });

  it("enforces the NPC panel lifecycle and makes a closed session terminal", () => {
    const npc = entity("npc-lifecycle", "npc", ALICE_ONLY);
    const active: NpcInteractionSessionV1 = {
      schemaVersion: 1,
      sessionId: "npc-session-lifecycle",
      revision: 1,
      npcEntityId: npc.entityId,
      title: "与门房交谈",
      description: "定向交谈",
      status: "active",
      audience: ALICE_ONLY,
      provider: "codex",
      model: "",
      autoReply: true,
      mode: "shadow",
      pinnedContext: [],
      startedAt: timestamp(2),
      extensions: {},
    };
    expect(npcInteractionSessionV1Schema.safeParse({
      ...active,
      status: "closed",
      endedAt: timestamp(3),
      autoReply: true,
    }).success).toBe(false);

    const paused: NpcInteractionSessionV1 = { ...active, revision: 2, status: "paused", autoReply: false };
    const pausedState = deriveRoomWorldStateV2([
      entityEvent(1, npc, ALICE_ONLY),
      event(2, { type: "npc.session.upserted", audience: ALICE_ONLY, payload: { session: active } }),
      event(3, { type: "npc.session.upserted", audience: ALICE_ONLY, payload: { session: paused } }),
    ]);
    const pausedMessage = event(4, {
      type: "npc.session.message",
      audience: ALICE_ONLY,
      payload: { sessionId: active.sessionId, messageId: eventId(40), role: "human", speakerSeatId: ALICE.seatId, spokenText: "还能听见吗？" },
    }, ALICE);
    expect(() => reduceRoomWorldStateV2(pausedState, pausedMessage)).toThrow(/is not active/i);

    const resumed: NpcInteractionSessionV1 = { ...paused, revision: 3, status: "active" };
    const resumedEvent = event(4, { type: "npc.session.upserted", audience: ALICE_ONLY, payload: { session: resumed } });
    const acceptedMessage = event(5, {
      type: "npc.session.message",
      audience: ALICE_ONLY,
      payload: { sessionId: active.sessionId, messageId: eventId(50), role: "human", speakerSeatId: ALICE.seatId, spokenText: "我们继续。" },
    }, ALICE);
    const closed: NpcInteractionSessionV1 = {
      ...resumed,
      revision: 4,
      status: "closed",
      autoReply: false,
      endedAt: timestamp(6),
    };
    const closedState = deriveRoomWorldStateV2([
      entityEvent(1, npc, ALICE_ONLY),
      event(2, { type: "npc.session.upserted", audience: ALICE_ONLY, payload: { session: active } }),
      event(3, { type: "npc.session.upserted", audience: ALICE_ONLY, payload: { session: paused } }),
      resumedEvent,
      acceptedMessage,
      event(6, { type: "npc.session.upserted", audience: ALICE_ONLY, payload: { session: closed } }),
    ]);
    expect(closedState.npcSessions.get(active.sessionId)).toMatchObject({
      status: "closed",
      autoReply: false,
      endedAt: timestamp(6),
    });
    expect(closedState.npcMessages.get(active.sessionId)).toHaveLength(1);
    expect(() => reduceRoomWorldStateV2(closedState, event(7, {
      type: "npc.session.message",
      audience: ALICE_ONLY,
      payload: { sessionId: active.sessionId, messageId: eventId(70), role: "human", speakerSeatId: ALICE.seatId, spokenText: "结束后追问。" },
    }, ALICE))).toThrow(/is not active/i);
    expect(() => reduceRoomWorldStateV2(closedState, event(7, {
      type: "npc.session.upserted",
      audience: ALICE_ONLY,
      payload: { session: { ...closed, revision: 5, title: "试图改写旧会话" } },
    }))).toThrow(/closed NPC session .* cannot be updated/i);
  });

  it("projects separate audiences for two conversations with the same NPC", () => {
    const npc = entity("npc-two-panels", "npc", ROOM);
    const aliceSession: NpcInteractionSessionV1 = {
      schemaVersion: 1,
      sessionId: "npc-session-alice",
      revision: 1,
      npcEntityId: npc.entityId,
      title: "Alice 与馆长交谈",
      description: "只给 Alice",
      status: "active",
      audience: ALICE_ONLY,
      provider: "codex",
      model: "",
      autoReply: false,
      mode: "shadow",
      pinnedContext: [],
      startedAt: timestamp(2),
      extensions: {},
    };
    const bobSession: NpcInteractionSessionV1 = {
      ...aliceSession,
      sessionId: "npc-session-bob",
      title: "Bob 与馆长交谈",
      description: "只给 Bob",
      audience: BOB_ONLY,
      startedAt: timestamp(5),
    };
    const events = [
      entityEvent(1, npc, ROOM),
      event(2, { type: "npc.session.upserted", audience: ALICE_ONLY, payload: { session: aliceSession } }),
      event(3, {
        type: "npc.session.message",
        audience: ALICE_ONLY,
        payload: { sessionId: aliceSession.sessionId, messageId: eventId(30), role: "human", speakerSeatId: ALICE.seatId, spokenText: "Alice 的秘密问题" },
      }, ALICE),
      event(4, {
        type: "npc.session.upserted",
        audience: ALICE_ONLY,
        payload: { session: { ...aliceSession, revision: 2, status: "closed", endedAt: timestamp(4) } },
      }),
      event(5, { type: "npc.session.upserted", audience: BOB_ONLY, payload: { session: bobSession } }),
      event(6, {
        type: "npc.session.message",
        audience: BOB_ONLY,
        payload: { sessionId: bobSession.sessionId, messageId: eventId(60), role: "human", speakerSeatId: BOB.seatId, spokenText: "Bob 的秘密问题" },
      }, BOB),
    ];
    const authority = deriveRoomWorldStateV2(events);
    expect(authority.npcSessions.get(aliceSession.sessionId)?.status).toBe("closed");
    expect(authority.npcSessions.get(bobSession.sessionId)?.status).toBe("active");

    const aliceWorld = deriveRoomWorldStateFromViewsV2(events.map((candidate) => projectRoomEventV2(candidate, ALICE)));
    const bobWorld = deriveRoomWorldStateFromViewsV2(events.map((candidate) => projectRoomEventV2(candidate, BOB)));
    expect([...aliceWorld.npcSessions.keys()]).toEqual([aliceSession.sessionId]);
    expect(aliceWorld.npcMessages.get(aliceSession.sessionId)?.[0]?.spokenText).toBe("Alice 的秘密问题");
    expect(JSON.stringify([...aliceWorld.npcMessages.values()])).not.toContain("Bob 的秘密问题");
    expect([...bobWorld.npcSessions.keys()]).toEqual([bobSession.sessionId]);
    expect(bobWorld.npcMessages.get(bobSession.sessionId)?.[0]?.spokenText).toBe("Bob 的秘密问题");
    expect(JSON.stringify([...bobWorld.npcMessages.values()])).not.toContain("Alice 的秘密问题");
  });

  it("requires embedded items, edges and fog to use exactly the board audience", () => {
    const privateBoard = board("board-private", "evidence", [
      item("public-note", { kind: "text", text: "leak" }, ROOM),
    ], ALICE_ONLY);
    expect(boardV1Schema.safeParse(privateBoard).success).toBe(false);

    const edgeLeak = board("board-edge-private", "evidence", [
      item("note-a", { kind: "text", text: "A" }, ALICE_ONLY),
      item("note-b", { kind: "text", text: "B" }, ALICE_ONLY),
    ], ALICE_ONLY);
    edgeLeak.edges = [{
      schemaVersion: 1,
      edgeId: "edge-public",
      fromItemId: "note-a",
      toItemId: "note-b",
      kind: "related",
      label: "leak",
      audience: ROOM,
      extensions: {},
    }];
    expect(boardV1Schema.safeParse(edgeLeak).success).toBe(false);

    const publicBoardWithSecretText = board("board-public-secret-text", "evidence", [
      item("secret-text", { kind: "text", text: "诱饵秘密" }, ALICE_ONLY),
    ], ROOM);
    expect(boardV1Schema.safeParse(publicBoardWithSecretText).success).toBe(false);

    const fogLeak = board("board-public-secret-fog", "map", [], ROOM);
    fogLeak.fogMask = {
      schemaVersion: 1,
      maskId: "secret-fog",
      revision: 1,
      mode: "cover-all",
      audience: ALICE_ONLY,
      revealedRegions: [],
      extensions: {},
    };
    expect(boardV1Schema.safeParse(fogLeak).success).toBe(false);
  });

  it("rejects putting a targeted artifact reference on a public board", () => {
    const secret = { ...artifact("artifact-secret", 1), audience: ALICE_ONLY };
    const leakingBoard = board("board-public-leak", "evidence", [
      item("secret-clue", { kind: "artifact", artifactId: secret.artifactId }, ALICE_ONLY),
    ], ROOM);
    expect(() => deriveRoomWorldStateV2([
      artifactEvent(1, secret),
      boardEvent(2, leakingBoard),
    ])).toThrow(/board items embedded in a snapshot must use the board audience/i);
  });

  it("replays additive fog reveals in host sequence order", () => {
    const map = board("board-map", "map", []);
    map.fogMask = {
      schemaVersion: 1,
      maskId: "fog-main",
      revision: 1,
      mode: "cover-all",
      audience: ROOM,
      revealedRegions: [],
      extensions: {},
    };
    const firstReveal = fogEvent(2, 2, 2, "fog-region-entry", 100);
    const secondReveal = fogEvent(3, 3, 3, "fog-region-hall", 500);

    const state = deriveRoomWorldStateV2([
      secondReveal,
      boardEvent(1, map),
      firstReveal,
    ]);
    const finalBoard = state.boards.get(map.boardId);
    expect(finalBoard?.revision).toBe(3);
    expect(finalBoard?.fogMask?.revision).toBe(3);
    expect(finalBoard?.fogMask?.revealedRegions.map(({ regionId }) => regionId)).toEqual([
      "fog-region-entry",
      "fog-region-hall",
    ]);
  });
});

function entity(
  entityId: string,
  kind: RoomEntityV2["kind"],
  audience: AudienceV2,
): RoomEntityV2 {
  return {
    schemaVersion: 2,
    entityId,
    revision: 1,
    kind,
    name: entityId,
    description: "visible only to its audience",
    artifactIds: [],
    audience,
    data: {},
    extensions: {},
  };
}

function artifact(artifactId: string, revision: number): RoomArtifactV2 {
  return {
    schemaVersion: 2,
    artifactId,
    revision,
    kind: "map-background",
    title: "地图",
    description: "",
    body: "",
    attachments: [],
    asset: {
      schemaVersion: 1,
      assetId: `sha256:${"a".repeat(64)}`,
      mediaType: "image/webp",
      byteLength: 1_024,
      width: 1_920,
      height: 1_080,
    },
    audience: ROOM,
    locked: false,
    archived: false,
    extensions: {},
  };
}

function item(
  itemId: string,
  reference: BoardItemV1["reference"],
  audience: AudienceV2 = ROOM,
): BoardItemV1 {
  return {
    schemaVersion: 1,
    itemId,
    reference,
    label: itemId,
    position: { x: 1_000, y: 2_000 },
    rotationDegrees: 0,
    scale: 1,
    zIndex: 0,
    locked: false,
    audience,
    extensions: {},
  };
}

function board(
  boardId: string,
  kind: BoardV1["kind"],
  items: BoardItemV1[],
  audience: AudienceV2 = ROOM,
): BoardV1 {
  return {
    schemaVersion: 1,
    boardId,
    revision: 1,
    kind,
    name: boardId,
    description: "",
    audience,
    logicalSize: { width: 10_000, height: 10_000 },
    archived: false,
    items,
    edges: [],
    extensions: {},
  };
}

function entityEvent(
  sequence: number,
  value: RoomEntityV2,
  audience: AudienceV2,
): RoomEventV2 {
  return event(sequence, {
    type: "entity.upserted",
    audience,
    payload: { entity: value },
  });
}

function artifactEvent(sequence: number, value: RoomArtifactV2): RoomEventV2 {
  return event(sequence, {
    type: "artifact.upserted",
    audience: value.audience,
    payload: { artifact: value },
  });
}

function boardEvent(sequence: number, value: BoardV1): RoomEventV2 {
  return event(sequence, {
    type: "board.created",
    audience: value.audience,
    payload: { board: value },
  });
}

function fogEvent(
  sequence: number,
  boardRevision: number,
  maskRevision: number,
  regionId: string,
  offset: number,
): RoomEventV2 {
  return event(sequence, {
    type: "board.fog.revealed",
    audience: ROOM,
    payload: {
      boardId: "board-map",
      boardRevision,
      maskId: "fog-main",
      maskRevision,
      region: {
        regionId,
        points: [
          { x: offset, y: offset },
          { x: offset + 100, y: offset },
          { x: offset + 100, y: offset + 100 },
        ],
      },
    },
  });
}

function event(
  sequence: number,
  body: Pick<RoomEventV2, "type" | "audience" | "payload">,
  sender: SeatV2 = HOST,
): RoomEventV2 {
  return roomEventV2Schema.parse({
    protocolVersion: 2,
    roomId: "room-v2",
    eventId: eventId(sequence),
    sequence,
    sender,
    occurredAt: timestamp(sequence),
    ...body,
  });
}

function eventId(sequence: number): string {
  return `20000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function timestamp(sequence: number): string {
  return `2026-08-29T12:00:${String(sequence).padStart(2, "0")}.000Z`;
}
