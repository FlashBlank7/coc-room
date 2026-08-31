import { describe, expect, it } from "vitest";

import {
  EventViewReplicaV2,
  HostEventSequencerV2,
  createRoomCommandV2,
  roomCommandV2Schema,
  type AudienceV2,
  type BoardItemV1,
  type BoardV1,
  type Coc7Character,
  type RoomEventProposalV2,
  type RoomEntityV2,
  type SeatV2,
} from "../src";

const ROOM_ID = "room-v2-authority";
const HOST: SeatV2 = {
  seatId: "seat-host",
  role: "host",
  displayName: "Keeper",
  peerId: "peer-host-v2",
  extensions: {},
};
const ALICE: SeatV2 = {
  seatId: "seat-alice",
  role: "player",
  displayName: "Alice",
  peerId: "peer-alice-v2",
  extensions: {},
};
const BOB: SeatV2 = {
  seatId: "seat-bob",
  role: "player",
  displayName: "Bob",
  peerId: "peer-bob-v2",
  extensions: {},
};
const ROOM: AudienceV2 = { kind: "room" };

describe("HostEventSequencerV2", () => {
  it("applies the room secret default to new player artifacts and redacts the other seat", () => {
    const sequencer = deterministicSequencer();
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "room.settings.updated",
      audience: ROOM,
      payload: { defaultVisibility: "secret" },
    }, commandId(1)), HOST);

    const proposal: RoomEventProposalV2 = {
      type: "artifact.upserted",
      audience: ROOM, // untrusted player input is replaced by the room default
      payload: {
        artifact: {
          schemaVersion: 2,
          artifactId: "clue-player-created",
          revision: 1,
          kind: "clue",
          title: "私下发现",
          description: "",
          body: "只有 Alice 与 KP 可以看到的文字",
          attachments: [],
          audience: ROOM,
          locked: false,
          archived: false,
          extensions: {},
        },
      },
    };
    const committed = sequencer.commitCommand(
      createRoomCommandV2(ROOM_ID, ALICE, proposal, commandId(2)),
      ALICE,
    ).event;

    expect(committed.audience).toEqual({ kind: "seats", seatIds: [ALICE.seatId] });
    const [bobView] = sequencer.viewsAfter(BOB, 1);
    expect(bobView).toMatchObject({ view: "redacted", sequence: 2 });
    expect(JSON.stringify(bobView)).not.toContain("只有 Alice");
  });

  it("rolls at the host and rejects forged player-only operations", () => {
    const values = [4, 2];
    const sequencer = deterministicSequencer(() => values.shift() ?? 0);
    const command = roomCommandV2Schema.parse({
      protocolVersion: 2,
      roomId: ROOM_ID,
      commandId: commandId(3),
      sender: ALICE,
      sentAt: "2026-08-29T00:00:00.000Z",
      type: "dice.roll",
      audience: { kind: "seats", seatIds: [ALICE.seatId] },
      payload: {
        expression: "d100",
        reason: "侦查",
        bonusDice: 0,
        penaltyDice: 0,
        target: 60,
        requiredDifficulty: "regular",
      },
    });
    const roll = sequencer.commitCommand(command, ALICE).event;
    expect(roll).toMatchObject({
      type: "dice.result",
      audience: ROOM,
      payload: { result: { total: 24 } },
    });

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "room.settings.updated",
      audience: ROOM,
      payload: { defaultVisibility: "public" },
    }, commandId(4)), ALICE)).toThrow(/only the host/i);
  });

  it("uses the stable seat ID for V2 character ownership across peer reconnects", () => {
    const sequencer = deterministicSequencer();
    const reconnectedAlice: SeatV2 = { ...ALICE, peerId: "peer-alice-after-reconnect" };
    const event = sequencer.commitCommand(createRoomCommandV2(ROOM_ID, reconnectedAlice, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: investigator(ALICE.seatId) },
    }, commandId(5)), reconnectedAlice).event;
    expect(event.type).toBe("character.updated");

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, reconnectedAlice, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: investigator(BOB.seatId) },
    }, commandId(6)), reconnectedAlice)).toThrow(/own character/i);
  });

  it("does not let a player take over another seat's existing character ID", () => {
    const sequencer = deterministicSequencer();
    const bobCharacter = { ...investigator(BOB.seatId), id: "character-bob", name: "Bob Investigator" };
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, BOB, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: bobCharacter },
    }, commandId(90)), BOB);

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: { ...bobCharacter, ownerPeerId: ALICE.seatId, playerName: "Alice" } },
    }, commandId(91)), ALICE)).toThrow(/take ownership/i);
    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: { ...bobCharacter, ownerPeerId: ALICE.seatId, playerName: "Alice" } },
    }, commandId(92)), HOST)).toThrow(/changed owner in authoritative history/i);
    expect(sequencer.world.latestCharacters.get(bobCharacter.id)?.ownerPeerId).toBe(BOB.seatId);
  });

  it("does not let a player claim a legacy character token before the host establishes its owner", () => {
    const sequencer = deterministicSequencer();
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "entity.upserted",
      audience: ROOM,
      payload: {
        entity: roomEntity(
          "entity-orphan-character",
          "character",
          "Legacy character token",
          { characterId: "character-orphan" },
        ),
      },
    }, commandId(93)), HOST);

    const orphanCharacter = {
      ...investigator(ALICE.seatId),
      id: "character-orphan",
      name: "Established by the host",
    };
    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: orphanCharacter },
    }, commandId(94)), ALICE)).toThrow(/unowned token|only the host/i);

    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: orphanCharacter },
    }, commandId(95)), HOST);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: { ...orphanCharacter, occupation: "Detective" } },
    }, commandId(96)), ALICE);
    expect(sequencer.world.latestCharacters.get(orphanCharacter.id)).toMatchObject({
      ownerPeerId: ALICE.seatId,
      occupation: "Detective",
    });
  });

  it("lets players create clues but reserves NPC and location entities for the host", () => {
    const sequencer = deterministicSequencer();
    const baseEntity = {
      schemaVersion: 2 as const,
      revision: 1,
      name: "玩家发现",
      description: "可见描述",
      artifactIds: [],
      audience: ROOM,
      data: {},
      extensions: {},
    };
    const clue = sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "entity.upserted",
      audience: ROOM,
      payload: { entity: { ...baseEntity, entityId: "player-clue", kind: "clue" } },
    }, commandId(7)), ALICE).event;
    expect(clue.type).toBe("entity.upserted");

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "entity.upserted",
      audience: ROOM,
      payload: { entity: { ...baseEntity, entityId: "forged-npc", kind: "npc" } },
    }, commandId(8)), ALICE)).toThrow(/only the host/i);
  });

  it("lets only the host focus an existing scene with the scene audience", () => {
    const sequencer = deterministicSequencer();
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "entity.upserted",
      audience: ROOM,
      payload: {
        entity: {
          schemaVersion: 2,
          entityId: "scene-foyer",
          revision: 1,
          kind: "scene",
          name: "门厅",
          description: "雨水沿着门框滴落。",
          artifactIds: [],
          audience: ROOM,
          data: {},
          extensions: {},
        },
      },
    }, commandId(9)), HOST);

    const focused = sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "scene.focused",
      audience: ROOM,
      payload: { sceneEntityId: "scene-foyer" },
    }, commandId(10)), HOST).event;
    expect(focused.type).toBe("scene.focused");
    expect(sequencer.world.activeSceneEntityId).toBe("scene-foyer");

    const restored = new HostEventSequencerV2(ROOM_ID, {
      initialEvents: sequencer.eventsAfter(0),
      createEventId: () => "30000000-0000-4000-8000-999999999999",
      clock: () => new Date("2026-08-29T00:00:00.000Z"),
    });
    expect(restored.world.activeSceneEntityId).toBe("scene-foyer");

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "scene.focused",
      audience: ROOM,
      payload: { sceneEntityId: "scene-foyer" },
    }, commandId(11)), ALICE)).toThrow(/only the host/i);
  });

  it("rejects player messages while an NPC panel is inactive and permits a new targeted panel", () => {
    const sequencer = deterministicSequencer();
    const aliceAudience: AudienceV2 = { kind: "seats", seatIds: [ALICE.seatId] };
    const bobAudience: AudienceV2 = { kind: "seats", seatIds: [BOB.seatId] };
    const npc = roomEntity("npc-doorkeeper", "npc", "Doorkeeper", {});
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "entity.upserted",
      audience: ROOM,
      payload: { entity: npc },
    }, commandId(120)), HOST);
    const activeSession = {
      schemaVersion: 1 as const,
      sessionId: "npc-session-alice",
      revision: 1,
      npcEntityId: npc.entityId,
      title: "Alice talks to the doorkeeper",
      description: "Targeted panel",
      status: "active" as const,
      audience: aliceAudience,
      provider: "codex" as const,
      model: "",
      autoReply: false,
      mode: "shadow" as const,
      pinnedContext: [],
      startedAt: "2026-08-29T00:00:00.000Z",
      extensions: {},
    };
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "npc.session.upserted",
      audience: aliceAudience,
      payload: { session: activeSession },
    }, commandId(121)), HOST);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "npc.session.message",
      audience: ROOM,
      payload: { sessionId: activeSession.sessionId, messageId: commandId(122), role: "human", speakerSeatId: ALICE.seatId, spokenText: "First question" },
    }, commandId(122)), ALICE);

    const pausedSession = { ...activeSession, revision: 2, status: "paused" as const };
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "npc.session.upserted",
      audience: aliceAudience,
      payload: { session: pausedSession },
    }, commandId(123)), HOST);
    const pausedMessage = createRoomCommandV2(ROOM_ID, ALICE, {
      type: "npc.session.message",
      audience: ROOM,
      payload: { sessionId: activeSession.sessionId, messageId: commandId(124), role: "human", speakerSeatId: ALICE.seatId, spokenText: "Should be blocked while paused" },
    }, commandId(124));
    const pausedSequence = sequencer.lastSequence;
    expect(() => sequencer.preflightCommand(pausedMessage, ALICE)).toThrow(/cannot submit messages.*inactive/i);
    expect(sequencer.lastSequence).toBe(pausedSequence);

    const resumedSession = { ...pausedSession, revision: 3, status: "active" as const };
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "npc.session.upserted",
      audience: aliceAudience,
      payload: { session: resumedSession },
    }, commandId(125)), HOST);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "npc.session.message",
      audience: ROOM,
      payload: { sessionId: activeSession.sessionId, messageId: commandId(126), role: "human", speakerSeatId: ALICE.seatId, spokenText: "Conversation resumed" },
    }, commandId(126)), ALICE);

    const closedSession = {
      ...resumedSession,
      revision: 4,
      status: "closed" as const,
      autoReply: false,
      endedAt: "2026-08-29T00:05:00.000Z",
    };
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "npc.session.upserted",
      audience: aliceAudience,
      payload: { session: closedSession },
    }, commandId(127)), HOST);
    const closedMessage = createRoomCommandV2(ROOM_ID, ALICE, {
      type: "npc.session.message",
      audience: ROOM,
      payload: { sessionId: activeSession.sessionId, messageId: commandId(128), role: "human", speakerSeatId: ALICE.seatId, spokenText: "Should be blocked after close" },
    }, commandId(128));
    const closedSequence = sequencer.lastSequence;
    expect(() => sequencer.preflightCommand(closedMessage, ALICE)).toThrow(/cannot submit messages.*inactive/i);
    expect(sequencer.lastSequence).toBe(closedSequence);

    const bobSession = {
      ...activeSession,
      sessionId: "npc-session-bob",
      audience: bobAudience,
      title: "Bob talks to the doorkeeper",
    };
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "npc.session.upserted",
      audience: bobAudience,
      payload: { session: bobSession },
    }, commandId(129)), HOST);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, BOB, {
      type: "npc.session.message",
      audience: ROOM,
      payload: { sessionId: bobSession.sessionId, messageId: commandId(130), role: "human", speakerSeatId: BOB.seatId, spokenText: "A separate question" },
    }, commandId(130)), BOB);
    expect(sequencer.world.npcSessions.get(activeSession.sessionId)?.status).toBe("closed");
    expect(sequencer.world.npcSessions.get(bobSession.sessionId)?.audience).toEqual(bobAudience);
    expect(sequencer.world.npcMessages.get(bobSession.sessionId)?.[0]?.speakerSeatId).toBe(BOB.seatId);
  });

  it("allows a player to move only existing character tokens they own on scene and map boards", () => {
    for (const kind of ["scene", "map"] as const) {
      const fixture = boardAuthorityFixture(kind);
      const seatOwned = fixture.item("item-alice-seat");
      const seatMove = fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
        type: "board.item.upserted",
        audience: ROOM,
        payload: {
          boardId: fixture.boardId,
          boardRevision: 2,
          item: { ...seatOwned, position: { x: 310, y: 320 } },
        },
      }, commandId(810)), ALICE).event;
      expect(seatMove).toMatchObject({
        type: "board.item.upserted",
        payload: { item: { itemId: seatOwned.itemId, position: { x: 310, y: 320 } } },
      });

      // Older character entities may have only `characterId`; ownership then
      // resolves through the stable seat ID retained in `ownerPeerId`.
      const characterOwned = fixture.item("item-alice-character");
      fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
        type: "board.item.upserted",
        audience: ROOM,
        payload: {
          boardId: fixture.boardId,
          boardRevision: 3,
          item: { ...characterOwned, position: { x: 410, y: 420 } },
        },
      }, commandId(811)), ALICE);
      expect(fixture.sequencer.world.boards.get(fixture.boardId)?.items.find(({ itemId }) => itemId === characterOwned.itemId)?.position).toEqual({ x: 410, y: 420 });
    }
  });

  it("preflights live-board moves without mutation or consuming rejected command IDs", () => {
    const fixture = boardAuthorityFixture("map");
    const beforeSequence = fixture.sequencer.lastSequence;
    const ownItem = fixture.item("item-alice-seat");
    const allowed = createRoomCommandV2(ROOM_ID, ALICE, {
      type: "board.item.upserted",
      audience: ROOM,
      payload: {
        boardId: fixture.boardId,
        boardRevision: 2,
        item: { ...ownItem, position: { x: 610, y: 620 } },
      },
    }, commandId(812));

    expect(fixture.sequencer.preflightCommand(allowed, ALICE)).toEqual({ duplicate: false });
    expect(fixture.sequencer.lastSequence).toBe(beforeSequence);
    expect(fixture.sequencer.world.boards.get(fixture.boardId)).toMatchObject({ revision: 1 });
    expect(fixture.item("item-alice-seat").position).toEqual({ x: 100, y: 100 });
    expect(fixture.sequencer.commitCommand(allowed, ALICE)).toMatchObject({ duplicate: false });
    expect(fixture.item("item-alice-seat").position).toEqual({ x: 610, y: 620 });

    const rejectedCommandId = commandId(813);
    const bobItem = fixture.item("item-bob");
    const unauthorized = createRoomCommandV2(ROOM_ID, ALICE, {
      type: "board.item.upserted",
      audience: ROOM,
      payload: {
        boardId: fixture.boardId,
        boardRevision: 3,
        item: { ...bobItem, position: { x: 710, y: 720 } },
      },
    }, rejectedCommandId);
    expect(() => fixture.sequencer.preflightCommand(unauthorized, ALICE)).toThrow(/own character token/i);

    const currentOwnItem = fixture.item("item-alice-seat");
    const corrected = createRoomCommandV2(ROOM_ID, ALICE, {
      type: "board.item.upserted",
      audience: ROOM,
      payload: {
        boardId: fixture.boardId,
        boardRevision: 3,
        item: { ...currentOwnItem, position: { x: 630, y: 640 } },
      },
    }, rejectedCommandId);
    expect(fixture.sequencer.commitCommand(corrected, ALICE)).toMatchObject({ duplicate: false });

    const staleCommandId = commandId(814);
    const stale = createRoomCommandV2(ROOM_ID, ALICE, {
      type: "board.item.upserted",
      audience: ROOM,
      payload: {
        boardId: fixture.boardId,
        boardRevision: 99,
        item: { ...fixture.item("item-alice-seat"), position: { x: 650, y: 660 } },
      },
    }, staleCommandId);
    expect(() => fixture.sequencer.preflightCommand(stale, ALICE)).toThrow(/revision/i);

    const afterRejectedPreflight = createRoomCommandV2(ROOM_ID, ALICE, {
      type: "board.item.upserted",
      audience: ROOM,
      payload: {
        boardId: fixture.boardId,
        boardRevision: 4,
        item: { ...fixture.item("item-alice-seat"), position: { x: 650, y: 660 } },
      },
    }, staleCommandId);
    expect(fixture.sequencer.commitCommand(afterRejectedPreflight, ALICE)).toMatchObject({ duplicate: false });
    expect(fixture.item("item-alice-seat").position).toEqual({ x: 650, y: 660 });
  });

  it("rejects malicious scene and map updates to another character or an NPC", () => {
    for (const kind of ["scene", "map"] as const) {
      const fixture = boardAuthorityFixture(kind);
      for (const [index, itemId] of ["item-bob", "item-npc"].entries()) {
        const current = fixture.item(itemId);
        expect(() => fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
          type: "board.item.upserted",
          audience: ROOM,
          payload: {
            boardId: fixture.boardId,
            boardRevision: 2,
            item: { ...current, position: { x: 900 + index, y: 700 } },
          },
        }, commandId(820 + index)), ALICE)).toThrow(/own character token/i);
      }
      expect(fixture.sequencer.world.boards.get(fixture.boardId)?.revision).toBe(1);
    }
  });

  it("rejects every non-position mutation of a player's own live-board token", () => {
    const aliceOnly: AudienceV2 = { kind: "seats", seatIds: [ALICE.seatId] };
    const mutations: ReadonlyArray<readonly [string, (item: BoardItemV1) => BoardItemV1]> = [
      ["label", (item) => ({ ...item, label: "forged label" })],
      ["scale", (item) => ({ ...item, scale: 2 })],
      ["rotation", (item) => ({ ...item, rotationDegrees: 45 })],
      ["size", (item) => ({ ...item, size: { width: 999, height: 999 } })],
      ["reference", (item) => ({ ...item, reference: { kind: "entity", entityId: "entity-npc" } })],
      ["audience", (item) => ({ ...item, audience: aliceOnly })],
      ["locked", (item) => ({ ...item, locked: true })],
    ];

    for (const [index, [label, mutate]] of mutations.entries()) {
      const fixture = boardAuthorityFixture("map");
      expect(
        () => fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
          type: "board.item.upserted",
          audience: ROOM,
          payload: {
            boardId: fixture.boardId,
            boardRevision: 2,
            item: mutate(fixture.item("item-alice-seat")),
          },
        }, commandId(830 + index)), ALICE),
        label,
      ).toThrow();
      expect(fixture.sequencer.world.boards.get(fixture.boardId)?.revision, label).toBe(1);
    }

    const fixture = boardAuthorityFixture("scene");
    expect(() => fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "board.item.upserted",
      audience: aliceOnly,
      payload: {
        boardId: fixture.boardId,
        boardRevision: 2,
        item: { ...fixture.item("item-alice-seat"), position: { x: 330, y: 340 } },
      },
    }, commandId(840)), ALICE)).toThrow(/audience/i);

    expect(() => fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "board.item.upserted",
      audience: ROOM,
      payload: {
        boardId: fixture.boardId,
        boardRevision: 2,
        item: { ...fixture.item("item-locked"), position: { x: 530, y: 540 } },
      },
    }, commandId(841)), ALICE)).toThrow(/locked board item/i);
  });

  it("rejects player item creation, removal and connections on scene and map boards", () => {
    for (const kind of ["scene", "map"] as const) {
      const fixture = boardAuthorityFixture(kind);
      const created = boardItem("item-forged", { kind: "text", text: "forged" }, { x: 500, y: 500 });
      expect(() => fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
        type: "board.item.upserted",
        audience: ROOM,
        payload: { boardId: fixture.boardId, boardRevision: 2, item: created },
      }, commandId(850)), ALICE)).toThrow(/may not create/i);
      expect(() => fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
        type: "board.item.removed",
        audience: ROOM,
        payload: { boardId: fixture.boardId, boardRevision: 2, itemId: "item-alice-seat" },
      }, commandId(851)), ALICE)).toThrow(/may not remove/i);
      expect(() => fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
        type: "board.edge.upserted",
        audience: ROOM,
        payload: {
          boardId: fixture.boardId,
          boardRevision: 2,
          edge: boardEdge("edge-forged", "item-alice-seat", "item-npc"),
        },
      }, commandId(852)), ALICE)).toThrow(/evidence boards/i);
      expect(() => fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
        type: "board.edge.removed",
        audience: ROOM,
        payload: { boardId: fixture.boardId, boardRevision: 2, edgeId: "edge-existing" },
      }, commandId(853)), ALICE)).toThrow(/evidence boards/i);
      expect(fixture.sequencer.world.boards.get(fixture.boardId)?.revision).toBe(1);
    }
  });

  it("rejects narrow host audiences for shared board mutations", () => {
    const hostOnly: AudienceV2 = { kind: "host" };
    const attempts = [
      (fixture: ReturnType<typeof boardAuthorityFixture>) => ({
        type: "board.item.upserted" as const,
        audience: hostOnly,
        payload: {
          boardId: fixture.boardId,
          boardRevision: 2,
          item: { ...fixture.item("item-npc"), position: { x: 610, y: 310 } },
        },
      }),
      (fixture: ReturnType<typeof boardAuthorityFixture>) => ({
        type: "board.item.removed" as const,
        audience: hostOnly,
        payload: { boardId: fixture.boardId, boardRevision: 2, itemId: "item-npc" },
      }),
      (fixture: ReturnType<typeof boardAuthorityFixture>) => ({
        type: "board.edge.upserted" as const,
        audience: hostOnly,
        payload: {
          boardId: fixture.boardId,
          boardRevision: 2,
          edge: boardEdge("edge-host-narrow", "item-alice-seat", "item-npc"),
        },
      }),
      (fixture: ReturnType<typeof boardAuthorityFixture>) => ({
        type: "board.edge.removed" as const,
        audience: hostOnly,
        payload: { boardId: fixture.boardId, boardRevision: 2, edgeId: "edge-existing" },
      }),
    ];

    for (const [index, proposal] of attempts.entries()) {
      const fixture = boardAuthorityFixture("map");
      expect(() => fixture.sequencer.commitCommand(createRoomCommandV2(
        ROOM_ID,
        HOST,
        proposal(fixture),
        commandId(855 + index),
      ), HOST)).toThrow(/event audience must match/i);
      expect(fixture.sequencer.world.boards.get(fixture.boardId)?.revision).toBe(1);
    }
  });

  it("preserves collaborative item and connection editing on evidence boards", () => {
    const fixture = boardAuthorityFixture("evidence");
    const npc = fixture.item("item-npc");
    fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "board.item.upserted",
      audience: ROOM,
      payload: {
        boardId: fixture.boardId,
        boardRevision: 2,
        item: { ...npc, label: "Alice arranged this NPC", position: { x: 620, y: 330 }, scale: 1.2 },
      },
    }, commandId(860)), ALICE);

    const aliceOnly: AudienceV2 = { kind: "seats", seatIds: [ALICE.seatId] };
    const created = { ...boardItem("item-shared-note", { kind: "text", text: "shared theory" }, { x: 700, y: 420 }), audience: aliceOnly };
    const creation = fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "board.item.upserted",
      audience: aliceOnly,
      payload: { boardId: fixture.boardId, boardRevision: 3, item: created },
    }, commandId(861)), ALICE).event;
    expect(creation).toMatchObject({ type: "board.item.upserted", audience: ROOM, payload: { item: { audience: ROOM, locked: false } } });

    fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "board.edge.upserted",
      audience: ROOM,
      payload: {
        boardId: fixture.boardId,
        boardRevision: 4,
        edge: boardEdge("edge-player-theory", "item-npc", "item-shared-note"),
      },
    }, commandId(862)), ALICE);
    const edgeRemoval = fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "board.edge.removed",
      audience: aliceOnly,
      payload: { boardId: fixture.boardId, boardRevision: 5, edgeId: "edge-existing" },
    }, commandId(863)), ALICE).event;
    const itemRemoval = fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "board.item.removed",
      audience: aliceOnly,
      payload: { boardId: fixture.boardId, boardRevision: 6, itemId: "item-shared-note" },
    }, commandId(864)), ALICE).event;
    expect(edgeRemoval.audience).toEqual(ROOM);
    expect(itemRemoval.audience).toEqual(ROOM);

    const board = fixture.sequencer.world.boards.get(fixture.boardId);
    expect(board).toMatchObject({ revision: 6 });
    expect(board?.items.find(({ itemId }) => itemId === "item-npc")).toMatchObject({
      label: "Alice arranged this NPC",
      position: { x: 620, y: 330 },
      scale: 1.2,
    });
    expect(board?.items.some(({ itemId }) => itemId === "item-shared-note")).toBe(false);
    expect(board?.edges.some(({ edgeId }) => edgeId === "edge-player-theory")).toBe(false);

    const bobReplica = new EventViewReplicaV2(ROOM_ID);
    const bobViews = fixture.sequencer.viewsAfter(BOB, 0);
    expect(bobViews.slice(-2).map(({ view }) => view)).toEqual(["full", "full"]);
    for (const view of bobViews) bobReplica.apply(view);
    const bobBoard = bobReplica.deriveWorld().boards.get(fixture.boardId);
    expect(bobBoard?.revision).toBe(6);
    expect(bobBoard?.items.some(({ itemId }) => itemId === "item-shared-note")).toBe(false);
    expect(bobBoard?.edges.some(({ edgeId }) => edgeId === "edge-existing" || edgeId === "edge-player-theory")).toBe(false);

    expect(() => fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "board.item.upserted",
      audience: ROOM,
      payload: {
        boardId: fixture.boardId,
        boardRevision: 7,
        item: { ...fixture.item("item-locked"), position: { x: 800, y: 500 } },
      },
    }, commandId(865)), ALICE)).toThrow(/locked board item/i);
    expect(() => fixture.sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "board.item.upserted",
      audience: ROOM,
      payload: {
        boardId: fixture.boardId,
        boardRevision: 99,
        item: { ...fixture.item("item-npc"), position: { x: 810, y: 510 } },
      },
    }, commandId(866)), ALICE)).toThrow(/revision conflict/i);
    expect(fixture.sequencer.world.boards.get(fixture.boardId)?.revision).toBe(6);
  });

  it("keeps a secret clue claim inside the clue audience and rejects an unauthorized claimant", () => {
    const sequencer = deterministicSequencer();
    const aliceOnly: AudienceV2 = { kind: "seats", seatIds: [ALICE.seatId] };
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "artifact.upserted",
      audience: aliceOnly,
      payload: { artifact: { schemaVersion: 2, artifactId: "secret-clue", revision: 1, kind: "clue", title: "私密线索", description: "", body: "只给 Alice", attachments: [], audience: aliceOnly, locked: true, archived: false, extensions: {} } },
    }, commandId(30)), HOST);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: investigator(ALICE.seatId) },
    }, commandId(31)), ALICE);
    const claim = sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "clue.claimed",
      audience: ROOM,
      payload: { artifactId: "secret-clue", characterId: "character-alice", characterName: "Alice Investigator" },
    }, commandId(32)), ALICE).event;
    expect(claim.audience).toEqual(aliceOnly);
    expect(sequencer.viewsAfter(BOB, 2)[0]).toMatchObject({ view: "redacted" });

    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, BOB, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: { ...investigator(BOB.seatId), id: "character-bob", name: "Bob Investigator" } },
    }, commandId(33)), BOB);
    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, BOB, {
      type: "clue.claimed",
      audience: ROOM,
      payload: { artifactId: "secret-clue", characterId: "character-bob", characterName: "Bob Investigator" },
    }, commandId(34)), BOB)).toThrow(/cannot submit content they cannot see|not visible/i);

    const unclaim = sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "clue.unclaimed",
      audience: ROOM,
      payload: { artifactId: "secret-clue", characterId: "character-alice", characterName: "Alice Investigator" },
    }, commandId(341)), ALICE).event;
    expect(unclaim.audience).toEqual(aliceOnly);
    expect(sequencer.world.clueClaims.has("secret-clue")).toBe(false);
    expect(sequencer.viewsAfter(BOB, unclaim.sequence - 1)[0]).toMatchObject({
      view: "redacted",
      sequence: unclaim.sequence,
    });
  });

  it("keeps independent claims when different room characters claim the same public clue", () => {
    const sequencer = deterministicSequencer();
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "artifact.upserted",
      audience: ROOM,
      payload: {
        artifact: {
          schemaVersion: 2,
          artifactId: "public-clue",
          revision: 1,
          kind: "clue",
          title: "Public clue",
          description: "",
          body: "Everyone may follow this lead.",
          attachments: [],
          audience: ROOM,
          locked: true,
          archived: false,
          extensions: {},
        },
      },
    }, commandId(35)), HOST);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: investigator(ALICE.seatId) },
    }, commandId(36)), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, BOB, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: { ...investigator(BOB.seatId), id: "character-bob", name: "Bob Investigator" } },
    }, commandId(37)), BOB);

    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "clue.claimed",
      audience: ROOM,
      payload: { artifactId: "public-clue", characterId: "character-alice", characterName: "Alice Investigator" },
    }, commandId(38)), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, BOB, {
      type: "clue.claimed",
      audience: ROOM,
      payload: { artifactId: "public-clue", characterId: "character-bob", characterName: "Bob Investigator" },
    }, commandId(39)), BOB);

    expect(sequencer.world.clueClaims.get("public-clue")).toMatchObject([
      { seatId: ALICE.seatId, characterId: "character-alice", characterName: "Alice Investigator" },
      { seatId: BOB.seatId, characterId: "character-bob", characterName: "Bob Investigator" },
    ]);
    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "clue.claimed",
      audience: ROOM,
      payload: { artifactId: "public-clue", characterId: "character-alice", characterName: "Alice Investigator" },
    }, commandId(40)), ALICE)).toThrow(/already claimed/i);

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "clue.unclaimed",
      audience: ROOM,
      payload: { artifactId: "public-clue", characterId: "character-bob", characterName: "Bob Investigator" },
    }, commandId(401)), ALICE)).toThrow(/only remove their own clue claim/i);

    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "clue.unclaimed",
      audience: ROOM,
      payload: { artifactId: "public-clue", characterId: "character-alice", characterName: "Alice Investigator" },
    }, commandId(402)), ALICE);
    expect(sequencer.world.clueClaims.get("public-clue")).toMatchObject([
      { seatId: BOB.seatId, characterId: "character-bob", characterName: "Bob Investigator" },
    ]);

    // Host authority may clean up a participant's focus marker, but the event
    // still identifies the exact character claim instead of editing the clue.
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "clue.unclaimed",
      audience: ROOM,
      payload: { artifactId: "public-clue", characterId: "character-bob", characterName: "Bob Investigator" },
    }, commandId(403)), HOST);
    expect(sequencer.world.clueClaims.has("public-clue")).toBe(false);
  });

  it("binds an authorized check to one requester, one target and one roll", () => {
    const values = [4, 2];
    const sequencer = deterministicSequencer(() => values.shift() ?? 0);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: investigator(ALICE.seatId) },
    }, commandId(40)), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: { requestId: "check-spot", characterId: "character-alice", characterName: "Alice Investigator", skillName: "Spot Hidden", proposedTarget: 60, reason: "Search the phonograph" },
    }, commandId(41)), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.authorized",
      audience: ROOM,
      payload: { requestId: "check-spot", target: 60, requiredDifficulty: "regular", bonusDice: 0, penaltyDice: 0, note: "Allowed" },
    }, commandId(42)), HOST);
    expect(sequencer.world.checkAuthorizations.get("check-spot")?.skillName).toBe("Spot Hidden");

    const diceCommand = (target: number, id: number) => roomCommandV2Schema.parse({
      protocolVersion: 2,
      roomId: ROOM_ID,
      commandId: commandId(id),
      sender: ALICE,
      sentAt: "2026-08-29T00:00:00.000Z",
      type: "dice.roll",
      audience: ROOM,
      payload: { expression: "1d100", reason: "Spot Hidden", bonusDice: 0, penaltyDice: 0, target, requiredDifficulty: "regular", checkRequestId: "check-spot" },
    });
    expect(() => sequencer.commitCommand(diceCommand(61, 43), ALICE)).toThrow(/does not match/i);
    const result = sequencer.commitCommand(diceCommand(60, 44), ALICE).event;
    expect(result).toMatchObject({ type: "dice.result", payload: { checkRequestId: "check-spot", result: { total: 24, check: { success: true } } } });
    expect(() => sequencer.commitCommand(diceCommand(60, 45), ALICE)).toThrow(/already rolled/i);
  });

  it("records one host-described outcome only after the authorized roll completes", () => {
    const values = [4, 2];
    const sequencer = deterministicSequencer(() => values.shift() ?? 0);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: investigator(ALICE.seatId) },
    }, commandId(600)), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: {
        requestId: "check-described",
        characterId: "character-alice",
        characterName: "Alice Investigator",
        skillName: "Spot Hidden",
        suggestedSkillName: "Spot Hidden",
        proposedTarget: 60,
        goal: "Identify the sound behind the wall",
        approach: "Press an ear to each panel in turn",
        reason: "Listen closely at the wall",
      },
    }, commandId(601)), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.authorized",
      audience: ROOM,
      payload: {
        requestId: "check-described",
        skillName: "Listen",
        target: 50,
        requiredDifficulty: "regular",
        bonusDice: 0,
        penaltyDice: 0,
        note: "The sound is faint but distinct",
      },
    }, commandId(602)), HOST);
    expect(sequencer.world.checkAuthorizations.get("check-described")?.skillName).toBe("Listen");

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.outcome.described",
      audience: ROOM,
      payload: { requestId: "check-described", text: "Too early" },
    }, commandId(603)), HOST)).toThrow(/completed roll/i);
    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.outcome.described",
      audience: ROOM,
      payload: { requestId: "check-described", text: "Player-authored outcome" },
    }, commandId(604)), ALICE)).toThrow(/only the host/i);

    sequencer.commitCommand(roomCommandV2Schema.parse({
      protocolVersion: 2,
      roomId: ROOM_ID,
      commandId: commandId(605),
      sender: ALICE,
      sentAt: "2026-08-29T00:00:00.000Z",
      type: "dice.roll",
      audience: ROOM,
      payload: {
        expression: "1d100",
        reason: "Listen",
        bonusDice: 0,
        penaltyDice: 0,
        target: 50,
        requiredDifficulty: "regular",
        checkRequestId: "check-described",
      },
    }), ALICE);

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.outcome.described",
      audience: { kind: "seats", seatIds: [ALICE.seatId] },
      payload: { requestId: "check-described", text: "Wrong audience" },
    }, commandId(606)), HOST)).toThrow(/request audience/i);
    const described = sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.outcome.described",
      audience: ROOM,
      payload: {
        requestId: "check-described",
        text: "A child's counting rhyme repeats behind the plaster.",
      },
    }, commandId(607)), HOST).event;

    expect(described).toMatchObject({
      type: "check.outcome.described",
      payload: { requestId: "check-described" },
    });
    expect(sequencer.world.checkOutcomes.get("check-described")).toMatchObject({
      text: "A child's counting rhyme repeats behind the plaster.",
      describedBySeatId: HOST.seatId,
      audience: ROOM,
    });
    expect(sequencer.viewsAfter(BOB, 0).at(-1)).toMatchObject({
      view: "full",
      event: { type: "check.outcome.described" },
    });
    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.outcome.described",
      audience: ROOM,
      payload: { requestId: "check-described", text: "Second incompatible description" },
    }, commandId(608)), HOST)).toThrow(/already described/i);

    const replayed = new HostEventSequencerV2(ROOM_ID, { initialEvents: sequencer.eventsAfter(0) });
    expect(replayed.world.checkOutcomes.get("check-described")?.text).toContain("counting rhyme");
  });

  it("models one informed pushed roll after a failed check", () => {
    const values = [4, 8, 4, 8];
    const sequencer = deterministicSequencer(() => values.shift() ?? 0);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: investigator(ALICE.seatId) },
    }, commandId(46)), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: { requestId: "check-lock", characterId: "character-alice", characterName: "Alice Investigator", skillName: "Locksmith", proposedTarget: 60, reason: "Pick the cellar lock" },
    }, commandId(47)), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.authorized",
      audience: ROOM,
      payload: { requestId: "check-lock", skillName: "Mechanical Repair", target: 60, requiredDifficulty: "regular", bonusDice: 0, penaltyDice: 0, note: "The old lock may still yield" },
    }, commandId(48)), HOST);
    sequencer.commitCommand(roomCommandV2Schema.parse({
      protocolVersion: 2,
      roomId: ROOM_ID,
      commandId: commandId(49),
      sender: ALICE,
      sentAt: "2026-08-29T00:00:00.000Z",
      type: "dice.roll",
      audience: ROOM,
      payload: { expression: "1d100", reason: "Locksmith", bonusDice: 0, penaltyDice: 0, target: 60, requiredDifficulty: "regular", checkRequestId: "check-lock" },
    }), ALICE);
    expect(sequencer.world.checkAuthorizations.get("check-lock")).toMatchObject({
      skillName: "Mechanical Repair",
      resolvedSuccess: false,
    });

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: {
        requestId: "check-lock-push-before-narration",
        characterId: "character-alice",
        characterName: "Alice Investigator",
        skillName: "Locksmith",
        proposedTarget: 60,
        reason: "Remove the hinge pins",
        pushOfRequestId: "check-lock",
      },
    }, commandId(498)), ALICE)).toThrow(/outcome to be described first/i);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.outcome.described",
      audience: ROOM,
      payload: {
        requestId: "check-lock",
        text: "The pick catches, then slips; the cellar door remains locked.",
      },
    }, commandId(499)), HOST);

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: {
        requestId: "check-lock-push-forged-skill",
        characterId: "character-alice",
        characterName: "Alice Investigator",
        skillName: "Locksmith",
        proposedTarget: 60,
        reason: "Read the hinges for signs of recent use",
        pushOfRequestId: "check-lock",
      },
    }, commandId(500)), ALICE)).toThrow(/original authorized skill/i);
    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: {
        requestId: "check-lock-push-repeated-approach",
        characterId: "character-alice",
        characterName: "Alice Investigator",
        skillName: "Mechanical Repair",
        suggestedSkillName: "Mechanical Repair",
        proposedTarget: 60,
        goal: "Open the cellar door",
        approach: "  PICK   THE CELLAR LOCK  ",
        reason: "Legacy summary intentionally differs",
        pushOfRequestId: "check-lock",
      },
    }, commandId(501)), ALICE)).toThrow(/different approach/i);

    const firstPushedRequest = createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: {
        requestId: "check-lock-push-first",
        characterId: "character-alice",
        characterName: "Alice Investigator",
        skillName: "Mechanical Repair",
        proposedTarget: 60,
        reason: "Remove the hinge pins and work the lock from behind",
        pushOfRequestId: "check-lock",
      },
    }, commandId(50));
    sequencer.commitCommand(firstPushedRequest, ALICE);
    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: {
        requestId: "check-lock-second-push",
        characterId: "character-alice",
        characterName: "Alice Investigator",
        skillName: "Mechanical Repair",
        proposedTarget: 60,
        reason: "Try the hinge pins a second time",
        pushOfRequestId: "check-lock",
      },
    }, commandId(51)), ALICE)).toThrow(/only be pushed once/i);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.closed",
      audience: ROOM,
      payload: { requestId: "check-lock-push-first", outcome: "declined", note: "That is not a substantially different approach" },
    }, commandId(52)), HOST);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: {
        requestId: "check-lock-push",
        characterId: "character-alice",
        characterName: "Alice Investigator",
        skillName: "Mechanical Repair",
        proposedTarget: 60,
        reason: "Take the door off its hinges instead",
        pushOfRequestId: "check-lock",
      },
    }, commandId(53)), ALICE);

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.authorized",
      audience: ROOM,
      payload: { requestId: "check-lock-push", target: 60, requiredDifficulty: "regular", bonusDice: 0, penaltyDice: 0, note: "You can force it" },
    }, commandId(54)), HOST)).toThrow(/failure consequence/i);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.authorized",
      audience: ROOM,
      payload: {
        requestId: "check-lock-push",
        target: 60,
        requiredDifficulty: "regular",
        bonusDice: 0,
        penaltyDice: 0,
        note: "You can force it",
        failureConsequence: "The pick will snap and alert whoever is below",
      },
    }, commandId(55)), HOST);
    sequencer.commitCommand(roomCommandV2Schema.parse({
      protocolVersion: 2,
      roomId: ROOM_ID,
      commandId: commandId(56),
      sender: ALICE,
      sentAt: "2026-08-29T00:00:00.000Z",
      type: "dice.roll",
      audience: ROOM,
      payload: { expression: "1d100", reason: "Pushed Locksmith", bonusDice: 0, penaltyDice: 0, target: 60, requiredDifficulty: "regular", checkRequestId: "check-lock-push" },
    }), ALICE);
    expect(sequencer.world.checkAuthorizations.get("check-lock-push")).toMatchObject({
      resolvedSuccess: false,
      failureConsequence: "The pick will snap and alert whoever is below",
    });

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: {
        requestId: "check-lock-push-again",
        characterId: "character-alice",
        characterName: "Alice Investigator",
        skillName: "Mechanical Repair",
        proposedTarget: 60,
        reason: "Try yet another method",
        pushOfRequestId: "check-lock-push",
      },
    }, commandId(57)), ALICE)).toThrow(/cannot be pushed again/i);
  });

  it("lets the investigator decline an authorized push after seeing its consequence", () => {
    const values = [4, 8];
    const sequencer = deterministicSequencer(() => values.shift() ?? 0);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: investigator(ALICE.seatId) },
    }, commandId(56)), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: { requestId: "check-door", characterId: "character-alice", characterName: "Alice Investigator", skillName: "STR", proposedTarget: 50, reason: "Force the crypt door" },
    }, commandId(57)), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.authorized",
      audience: ROOM,
      payload: { requestId: "check-door", target: 50, requiredDifficulty: "regular", bonusDice: 0, penaltyDice: 0, note: "The slab is heavy" },
    }, commandId(58)), HOST);
    sequencer.commitCommand(roomCommandV2Schema.parse({
      protocolVersion: 2,
      roomId: ROOM_ID,
      commandId: commandId(59),
      sender: ALICE,
      sentAt: "2026-08-29T00:00:00.000Z",
      type: "dice.roll",
      audience: ROOM,
      payload: { expression: "1d100", reason: "STR", bonusDice: 0, penaltyDice: 0, target: 50, requiredDifficulty: "regular", checkRequestId: "check-door" },
    }), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.outcome.described",
      audience: ROOM,
      payload: {
        requestId: "check-door",
        text: "The stone door does not move; your shoulder throbs from the impact.",
      },
    }, commandId(590)), HOST);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: { requestId: "check-door-push", characterId: "character-alice", characterName: "Alice Investigator", skillName: "STR", proposedTarget: 50, reason: "Use a shovel as a lever", pushOfRequestId: "check-door" },
    }, commandId(60)), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.authorized",
      audience: ROOM,
      payload: { requestId: "check-door-push", target: 50, requiredDifficulty: "regular", bonusDice: 0, penaltyDice: 0, note: "You may force it", failureConsequence: "The noise will wake what lies below" },
    }, commandId(61)), HOST);

    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.closed",
      audience: ROOM,
      payload: { requestId: "check-door-push", outcome: "cancelled", note: "That risk is too great" },
    }, commandId(62)), ALICE);
    expect(sequencer.world.checkClosures.get("check-door-push")).toMatchObject({
      outcome: "cancelled",
      closedBySeatId: ALICE.seatId,
    });
    expect(() => sequencer.commitCommand(roomCommandV2Schema.parse({
      protocolVersion: 2,
      roomId: ROOM_ID,
      commandId: commandId(63),
      sender: ALICE,
      sentAt: "2026-08-29T00:00:00.000Z",
      type: "dice.roll",
      audience: ROOM,
      payload: { expression: "1d100", reason: "STR push", bonusDice: 0, penaltyDice: 0, target: 50, requiredDifficulty: "regular", checkRequestId: "check-door-push" },
    }), ALICE)).toThrow(/was closed/i);
  });

  it("lets a requester cancel a pending check and makes closure a durable terminal state", () => {
    const sequencer = deterministicSequencer();
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: investigator(ALICE.seatId) },
    }, commandId(50)), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: { kind: "host" },
      payload: {
        requestId: "check-cancelled",
        characterId: "character-alice",
        characterName: "Alice Investigator",
        skillName: "Listen",
        proposedTarget: 50,
        reason: "Listen at the cellar door",
      },
    }, commandId(51)), ALICE);

    expect(sequencer.world.checkRequests.get("check-cancelled")?.audience).toEqual(ROOM);
    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, BOB, {
      type: "check.closed",
      audience: ROOM,
      payload: { requestId: "check-cancelled", outcome: "cancelled", note: "Not my request" },
    }, commandId(52)), BOB)).toThrow(/requester may only cancel/i);
    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.closed",
      audience: ROOM,
      payload: { requestId: "check-cancelled", outcome: "no-roll", note: "Forged ruling" },
    }, commandId(53)), ALICE)).toThrow(/requester may only cancel/i);

    const closed = sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.closed",
      audience: { kind: "host" },
      payload: { requestId: "check-cancelled", outcome: "cancelled", note: "I try another way" },
    }, commandId(54)), ALICE).event;
    expect(closed).toMatchObject({ type: "check.closed", audience: ROOM });
    expect(sequencer.world.checkClosures.get("check-cancelled")).toMatchObject({
      requestId: "check-cancelled",
      outcome: "cancelled",
      note: "I try another way",
      closedBySeatId: ALICE.seatId,
      closedByRole: "player",
      closedAt: "2026-08-29T00:00:00.000Z",
    });

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.authorized",
      audience: ROOM,
      payload: { requestId: "check-cancelled", target: 50, requiredDifficulty: "regular", bonusDice: 0, penaltyDice: 0, note: "Too late" },
    }, commandId(55)), HOST)).toThrow(/was closed/i);
    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.closed",
      audience: ROOM,
      payload: { requestId: "check-cancelled", outcome: "declined", note: "Second terminal result" },
    }, commandId(56)), HOST)).toThrow(/already closed/i);
    expect(() => sequencer.commitCommand(roomCommandV2Schema.parse({
      protocolVersion: 2,
      roomId: ROOM_ID,
      commandId: commandId(57),
      sender: ALICE,
      sentAt: "2026-08-29T00:00:00.000Z",
      type: "dice.roll",
      audience: ROOM,
      payload: { expression: "1d100", reason: "Listen", bonusDice: 0, penaltyDice: 0, target: 50, requiredDifficulty: "regular", checkRequestId: "check-cancelled" },
    }), ALICE)).toThrow(/was closed/i);

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.closed",
      audience: ROOM,
      payload: { requestId: "check-missing", outcome: "declined", note: "No such request" },
    }, commandId(58)), HOST)).toThrow(/does not exist/i);

    const restored = new HostEventSequencerV2(ROOM_ID, {
      initialEvents: sequencer.eventsAfter(0),
      createEventId: () => "30000000-0000-4000-8000-999999999999",
      clock: () => new Date("2026-08-29T00:00:00.000Z"),
    });
    expect(restored.world.checkClosures.get("check-cancelled")).toEqual(
      sequencer.world.checkClosures.get("check-cancelled"),
    );
  });

  it.each(["no-roll", "declined", "cancelled"] as const)(
    "lets the host close a pending check as %s but never an authorized check",
    (outcome) => {
      const sequencer = deterministicSequencer();
      sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
        type: "character.updated",
        audience: ROOM,
        payload: { character: investigator(ALICE.seatId) },
      }, commandId(60)), ALICE);
      sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
        type: "check.requested",
        audience: ROOM,
        payload: {
          requestId: `check-host-${outcome}`,
          characterId: "character-alice",
          characterName: "Alice Investigator",
          skillName: "Library Use",
          proposedTarget: 60,
          reason: "Read the index",
        },
      }, commandId(61)), ALICE);
      const closed = sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
        type: "check.closed",
        audience: ROOM,
        payload: { requestId: `check-host-${outcome}`, outcome, note: "Keeper ruling" },
      }, commandId(62)), HOST).event;
      expect(closed).toMatchObject({ type: "check.closed", payload: { outcome } });
    },
  );

  it("limits closing an authorized check to an explicit cancellation and keeps the request audience", () => {
    const sequencer = deterministicSequencer();
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: investigator(ALICE.seatId) },
    }, commandId(70)), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: { requestId: "check-authorized", characterId: "character-alice", characterName: "Alice Investigator", skillName: "Spot Hidden", proposedTarget: 60, reason: "Search" },
    }, commandId(71)), ALICE);
    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.closed",
      audience: { kind: "host" },
      payload: { requestId: "check-authorized", outcome: "declined", note: "Hidden result" },
    }, commandId(72)), HOST)).toThrow(/request audience/i);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.authorized",
      audience: ROOM,
      payload: { requestId: "check-authorized", target: 60, requiredDifficulty: "regular", bonusDice: 0, penaltyDice: 0, note: "Roll" },
    }, commandId(73)), HOST);
    // An authorized check may not be resolved with a substitute ruling, and a
    // non-requester player may not touch it. Only an explicit cancellation by
    // the host or the requester withdraws the unrolled ruling.
    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.closed",
      audience: ROOM,
      payload: { requestId: "check-authorized", outcome: "no-roll", note: "Forged shortcut" },
    }, commandId(74)), HOST)).toThrow(/already authorized/i);
    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, BOB, {
      type: "check.closed",
      audience: ROOM,
      payload: { requestId: "check-authorized", outcome: "cancelled", note: "Not my check" },
    }, commandId(75)), BOB)).toThrow(/requester may only cancel/i);
  });

  it("lets the host withdraw a mistaken ruling and the requester walk away before rolling", () => {
    const sequencer = deterministicSequencer();
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: investigator(ALICE.seatId) },
    }, commandId(80)), ALICE);
    const requestCheck = (requestId: string, id: number) => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: { requestId, characterId: "character-alice", characterName: "Alice Investigator", skillName: "Spot Hidden", proposedTarget: 60, reason: "Search the archive" },
    }, commandId(id)), ALICE);
    const authorizeCheck = (requestId: string, id: number) => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.authorized",
      audience: ROOM,
      payload: { requestId, target: 60, requiredDifficulty: "extreme", bonusDice: 0, penaltyDice: 1, note: "Mistaken ruling" },
    }, commandId(id)), HOST);

    // The host picked the wrong difficulty and withdraws the ruling.
    requestCheck("check-misruled", 81);
    authorizeCheck("check-misruled", 82);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.closed",
      audience: ROOM,
      payload: { requestId: "check-misruled", outcome: "cancelled", note: "Wrong difficulty; resubmit the action" },
    }, commandId(83)), HOST);
    expect(sequencer.world.checkClosures.get("check-misruled")).toMatchObject({
      outcome: "cancelled",
      closedBySeatId: HOST.seatId,
      closedByRole: "host",
    });
    expect(() => sequencer.commitCommand(roomCommandV2Schema.parse({
      protocolVersion: 2,
      roomId: ROOM_ID,
      commandId: commandId(84),
      sender: ALICE,
      sentAt: "2026-08-29T00:00:00.000Z",
      type: "dice.roll",
      audience: ROOM,
      payload: { expression: "1d100", reason: "Spot Hidden", bonusDice: 0, penaltyDice: 1, target: 60, requiredDifficulty: "extreme", checkRequestId: "check-misruled" },
    }), ALICE)).toThrow(/was closed/i);

    // The table is not stuck: the requester may submit a fresh action and may
    // also walk away from an authorized regular check before rolling.
    requestCheck("check-retried", 85);
    authorizeCheck("check-retried", 86);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.closed",
      audience: ROOM,
      payload: { requestId: "check-retried", outcome: "cancelled", note: "I change my mind before rolling" },
    }, commandId(87)), ALICE);
    expect(sequencer.world.checkClosures.get("check-retried")).toMatchObject({
      outcome: "cancelled",
      closedBySeatId: ALICE.seatId,
      closedByRole: "player",
    });

    const restored = new HostEventSequencerV2(ROOM_ID, { initialEvents: sequencer.eventsAfter(0) });
    expect(restored.world.checkClosures.get("check-misruled")?.closedByRole).toBe("host");
    expect(restored.world.checkClosures.get("check-retried")?.closedByRole).toBe("player");
  });

  it("keeps a rolled check terminal: nobody may cancel it afterwards", () => {
    const values = [4, 2];
    const sequencer = deterministicSequencer(() => values.shift() ?? 0);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: investigator(ALICE.seatId) },
    }, commandId(90)), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: { requestId: "check-rolled", characterId: "character-alice", characterName: "Alice Investigator", skillName: "Spot Hidden", proposedTarget: 60, reason: "Search" },
    }, commandId(91)), ALICE);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.authorized",
      audience: ROOM,
      payload: { requestId: "check-rolled", target: 60, requiredDifficulty: "regular", bonusDice: 0, penaltyDice: 0, note: "Roll" },
    }, commandId(92)), HOST);
    sequencer.commitCommand(roomCommandV2Schema.parse({
      protocolVersion: 2,
      roomId: ROOM_ID,
      commandId: commandId(93),
      sender: ALICE,
      sentAt: "2026-08-29T00:00:00.000Z",
      type: "dice.roll",
      audience: ROOM,
      payload: { expression: "1d100", reason: "Spot Hidden", bonusDice: 0, penaltyDice: 0, target: 60, requiredDifficulty: "regular", checkRequestId: "check-rolled" },
    }), ALICE);

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "check.closed",
      audience: ROOM,
      payload: { requestId: "check-rolled", outcome: "cancelled", note: "Too late" },
    }, commandId(94)), HOST)).toThrow(/already rolled/i);
    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "check.closed",
      audience: ROOM,
      payload: { requestId: "check-rolled", outcome: "cancelled", note: "Undo my roll" },
    }, commandId(95)), ALICE)).toThrow(/already rolled/i);
  });

  it("persists target audience expansion across every artifact revision", () => {
    const sequencer = deterministicSequencer();
    const aliceOnly: AudienceV2 = { kind: "seats", seatIds: [ALICE.seatId] };
    const artifact = (revision: number, body: string) => ({
      schemaVersion: 2 as const,
      artifactId: "artifact-durable-expansion",
      revision,
      kind: "clue" as const,
      title: "密文",
      description: "",
      body,
      attachments: [],
      audience: aliceOnly,
      locked: false,
      archived: false,
      extensions: {},
    });
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "artifact.upserted",
      audience: aliceOnly,
      payload: { artifact: artifact(1, "第一版") },
    }, commandId(20)), HOST);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "artifact.upserted",
      audience: aliceOnly,
      payload: { artifact: artifact(2, "第二版") },
    }, commandId(21)), HOST);
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "audience.expanded",
      audience: ROOM,
      payload: {
        target: { kind: "artifact", artifactId: "artifact-durable-expansion" },
        audience: ROOM,
      },
    }, commandId(22)), HOST);

    const bobViews = sequencer.viewsAfter(BOB, 0);
    expect(bobViews.map(({ view }) => view)).toEqual(["full", "full", "full"]);
    const replica = new EventViewReplicaV2(ROOM_ID);
    for (const view of bobViews) replica.apply(view);
    expect(replica.deriveWorld().artifacts.get("artifact-durable-expansion")?.revision).toBe(2);
  });
});

describe("chat.message persona (speak-as)", () => {
  it("lets the host speak as an NPC but rejects impersonation by players", () => {
    const sequencer = deterministicSequencer();
    const spoken = sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "chat.message",
      audience: ROOM,
      payload: {
        message: "这么晚了，剧院不接待客人。",
        format: "plain",
        persona: { name: "守门人", entityId: "npc-doorkeeper" },
      },
    }, commandId(10)), HOST).event;
    expect(spoken.type).toBe("chat.message");
    if (spoken.type === "chat.message") {
      expect(spoken.payload.persona).toEqual({ name: "守门人", entityId: "npc-doorkeeper" });
    }

    expect(() => sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
      type: "chat.message",
      audience: ROOM,
      payload: {
        message: "（假装守门人）跟我来。",
        format: "plain",
        persona: { name: "守门人" },
      },
    }, commandId(11)), ALICE)).toThrow(/only the host may speak as an NPC/);
  });
});

describe("EventViewReplicaV2", () => {
  it("keeps a contiguous projection and upgrades a redacted header in place", () => {
    const sequencer = deterministicSequencer();
    const first = sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "chat.message",
      audience: ROOM,
      payload: { message: "first", format: "plain" },
    }, commandId(10)), HOST).event;
    const second = sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "chat.message",
      audience: { kind: "seats", seatIds: [ALICE.seatId] },
      payload: { message: "targeted", format: "plain" },
    }, commandId(11)), HOST).event;

    const replica = new EventViewReplicaV2(ROOM_ID);
    const bobViews = sequencer.viewsAfter(BOB, 0);
    expect(replica.apply(bobViews[1]!)).toBe("applied");
    expect(replica.orderedViews()).toEqual([]);
    expect(replica.apply(bobViews[0]!)).toBe("applied");
    expect(replica.orderedViews()).toHaveLength(2);

    const full = { view: "full" as const, event: second };
    expect(replica.apply(full)).toBe("upgraded");
    expect(replica.deriveWorld().lastSequence).toBe(2);
    expect(first.sequence).toBe(1);
  });
});

function deterministicSequencer(rng?: () => number) {
  let id = 0;
  return new HostEventSequencerV2(ROOM_ID, {
    createEventId: () => `30000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    clock: () => new Date("2026-08-29T00:00:00.000Z"),
    ...(rng ? { rng } : {}),
  });
}

function commandId(value: number): string {
  return `40000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function boardAuthorityFixture(kind: BoardV1["kind"]) {
  const sequencer = deterministicSequencer();
  sequencer.commitCommand(createRoomCommandV2(ROOM_ID, ALICE, {
    type: "character.updated",
    audience: ROOM,
    payload: { character: investigator(ALICE.seatId) },
  }, commandId(800)), ALICE);

  const entities: RoomEntityV2[] = [
    roomEntity("entity-alice-seat", "character", "Alice seat-owned token", { ownerSeatId: ALICE.seatId }),
    roomEntity("entity-alice-character", "character", "Alice character-owned token", { characterId: "character-alice" }),
    // The conflicting legacy fallback deliberately points at Alice. A present
    // `ownerSeatId` is authoritative and must keep this token under Bob's seat.
    roomEntity("entity-bob", "character", "Bob token", { ownerSeatId: BOB.seatId, characterId: "character-alice" }),
    roomEntity("entity-npc", "npc", "Unowned NPC", {}),
  ];
  entities.forEach((entity, index) => {
    sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
      type: "entity.upserted",
      audience: ROOM,
      payload: { entity },
    }, commandId(801 + index)), HOST);
  });

  const boardId = `board-authority-${kind}`;
  const items = [
    boardItem("item-alice-seat", { kind: "entity", entityId: "entity-alice-seat" }, { x: 100, y: 100 }),
    boardItem("item-alice-character", { kind: "entity", entityId: "entity-alice-character" }, { x: 200, y: 200 }),
    boardItem("item-bob", { kind: "entity", entityId: "entity-bob" }, { x: 300, y: 300 }),
    boardItem("item-npc", { kind: "entity", entityId: "entity-npc" }, { x: 400, y: 400 }),
    { ...boardItem("item-locked", { kind: "entity", entityId: "entity-alice-seat" }, { x: 500, y: 500 }), locked: true },
  ];
  const board: BoardV1 = {
    schemaVersion: 1,
    boardId,
    revision: 1,
    kind,
    name: `${kind} authority board`,
    description: "",
    audience: ROOM,
    logicalSize: { width: 1_600, height: 900 },
    archived: false,
    items,
    edges: [boardEdge("edge-existing", "item-alice-seat", "item-bob")],
    extensions: {},
  };
  sequencer.commitCommand(createRoomCommandV2(ROOM_ID, HOST, {
    type: "board.created",
    audience: ROOM,
    payload: { board },
  }, commandId(805)), HOST);

  return {
    sequencer,
    boardId,
    item(itemId: string): BoardItemV1 {
      const item = sequencer.world.boards.get(boardId)?.items.find((candidate) => candidate.itemId === itemId);
      if (!item) throw new Error(`missing fixture item ${itemId}`);
      return item;
    },
  };
}

function roomEntity(
  entityId: string,
  kind: RoomEntityV2["kind"],
  name: string,
  data: Record<string, unknown>,
): RoomEntityV2 {
  return {
    schemaVersion: 2,
    entityId,
    revision: 1,
    kind,
    name,
    description: "",
    artifactIds: [],
    audience: ROOM,
    data,
    extensions: {},
  };
}

function boardItem(
  itemId: string,
  reference: BoardItemV1["reference"],
  position: BoardItemV1["position"],
): BoardItemV1 {
  return {
    schemaVersion: 1,
    itemId,
    reference,
    label: itemId,
    position,
    size: { width: 120, height: 120 },
    rotationDegrees: 0,
    scale: 1,
    zIndex: 0,
    locked: false,
    audience: ROOM,
    extensions: {},
  };
}

function boardEdge(edgeId: string, fromItemId: string, toItemId: string) {
  return {
    schemaVersion: 1 as const,
    edgeId,
    fromItemId,
    toItemId,
    kind: "relationship",
    label: "",
    audience: ROOM,
    extensions: {},
  };
}

function investigator(ownerPeerId: string): Coc7Character {
  return {
    schemaVersion: 1,
    id: "character-alice",
    ownerPeerId,
    name: "Alice Investigator",
    playerName: "Alice",
    occupation: "Reporter",
    age: 28,
    residence: "Arkham",
    birthplace: "Boston",
    characteristics: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 60, pow: 50, edu: 60, luck: 50 },
    derived: { hitPoints: 10, maxHitPoints: 10, magicPoints: 10, maxMagicPoints: 10, sanity: 50, maxSanity: 99, movementRate: 8, build: 0, damageBonus: "0" },
    skills: [],
    status: { temporaryInsanity: false, indefiniteInsanity: false, majorWound: false, dying: false, unconscious: false },
    inventory: [],
    background: { personalDescription: "", ideologyAndBeliefs: "", significantPeople: "", meaningfulLocations: "", treasuredPossessions: "", traits: "", injuriesAndScars: "", phobiasAndManias: "", arcaneTomesSpellsAndArtifacts: "", encountersWithStrangeEntities: "" },
    notes: "",
    updatedAt: "2026-08-29T00:00:00.000Z",
    extensions: {},
  };
}
