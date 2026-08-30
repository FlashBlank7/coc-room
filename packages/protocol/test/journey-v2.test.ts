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
  type RoomCommandV2,
  type RoomEventProposalV2,
  type RoomEventV2,
  type SeatV2,
} from "../src";

const ROOM_ID = "room-journey-v2";
const MODULE_ID = "module-curtain-call";
const ROOM: AudienceV2 = { kind: "room" };
const HOST_ONLY: AudienceV2 = { kind: "host" };

const HOST: SeatV2 = {
  seatId: "seat-keeper",
  role: "host",
  displayName: "Keeper",
  peerId: "peer-keeper",
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

describe("V2 complete Keeper/player journey", () => {
  it("publishes a module-led investigation without movement or Keeper notes leaking content", () => {
    const randomValues = [4, 6, 2];
    let eventCounter = 0;
    let commandCounter = 0;
    let clockCounter = 0;
    const sequencer = new HostEventSequencerV2(ROOM_ID, {
      createEventId: () => uuid("7", ++eventCounter),
      clock: () => new Date(`2026-08-30T10:00:${String(++clockCounter).padStart(2, "0")}.000Z`),
      rng: () => randomValues.shift() ?? 0,
    });
    const submit = (sender: SeatV2, proposal: RoomEventProposalV2): RoomEventV2 =>
      sequencer.commitCommand(
        createRoomCommandV2(ROOM_ID, sender, proposal, uuid("8", ++commandCounter)),
        sender,
      ).event;

    // The module switch identifies the structured source version. Room
    // entities remain independent snapshots with explicit source references.
    submit(HOST, {
      type: "module.switched",
      audience: ROOM,
      payload: { moduleId: MODULE_ID, revision: 1, title: "The Final Curtain" },
    });

    const privateText = "KP_ONLY: the curator is the ritual's final witness";
    const privateArtifactEvent = submit(HOST, {
      type: "artifact.upserted",
      audience: HOST_ONLY,
      payload: {
        artifact: {
          schemaVersion: 2,
          artifactId: "artifact-keeper-ritual-truth",
          revision: 1,
          kind: "note",
          title: "Keeper ritual truth",
          description: "Never reveal automatically",
          body: privateText,
          attachments: [],
          audience: HOST_ONLY,
          locked: true,
          archived: false,
          extensions: { sourceRef: sourceRef("keeper-note", "note-ritual-truth") },
        },
      },
    });
    const privateEntityEvent = submit(HOST, {
      type: "entity.upserted",
      audience: HOST_ONLY,
      payload: {
        entity: {
          schemaVersion: 2,
          entityId: "entity-keeper-ritual-truth",
          revision: 1,
          kind: "custom",
          name: "Keeper-only ritual truth",
          description: privateText,
          artifactIds: ["artifact-keeper-ritual-truth"],
          audience: HOST_ONLY,
          data: { sourceRef: sourceRef("keeper-note", "note-ritual-truth") },
          extensions: {},
        },
      },
    });

    for (const scene of [
      {
        entityId: "scene-foyer",
        name: "Museum foyer",
        description: "The investigation begins here.",
        sourceId: "scene-foyer-source",
      },
      {
        entityId: "scene-archive",
        name: "Archive wing",
        description: "An accessible map region; details await the Keeper.",
        sourceId: "scene-archive-source",
      },
    ]) {
      submit(HOST, {
        type: "entity.upserted",
        audience: ROOM,
        payload: {
          entity: {
            schemaVersion: 2,
            entityId: scene.entityId,
            revision: 1,
            kind: "scene",
            name: scene.name,
            description: scene.description,
            artifactIds: [],
            audience: ROOM,
            data: { sourceRef: sourceRef("scene", scene.sourceId) },
            extensions: {},
          },
        },
      });
    }

    const archiveZone = boardItem(
      "zone-archive",
      { kind: "entity", entityId: "scene-archive" },
      { x: 1_000, y: 200 },
      { width: 500, height: 500 },
      true,
    );
    const map: BoardV1 = {
      schemaVersion: 1,
      boardId: "board-museum-map",
      revision: 1,
      kind: "map",
      name: "Museum map",
      description: "Shared movement map",
      audience: ROOM,
      logicalSize: { width: 2_000, height: 1_200 },
      archived: false,
      items: [
        boardItem(
          "zone-foyer",
          { kind: "entity", entityId: "scene-foyer" },
          { x: 100, y: 200 },
          { width: 500, height: 500 },
          true,
        ),
        archiveZone,
      ],
      edges: [],
      extensions: {},
    };
    const sceneBoard: BoardV1 = {
      schemaVersion: 1,
      boardId: "board-archive-scene",
      revision: 1,
      kind: "scene",
      name: "Archive wing",
      description: "Shared immersive scene",
      audience: ROOM,
      logicalSize: { width: 1_600, height: 900 },
      archived: false,
      items: [],
      edges: [],
      extensions: {},
    };
    const evidenceBoard: BoardV1 = {
      schemaVersion: 1,
      boardId: "board-public-evidence",
      revision: 1,
      kind: "evidence",
      name: "Public evidence board",
      description: "Leads visible to the whole table",
      audience: ROOM,
      logicalSize: { width: 1_600, height: 900 },
      archived: false,
      items: [],
      edges: [],
      extensions: {},
    };
    for (const board of [map, sceneBoard, evidenceBoard]) {
      submit(HOST, {
        type: "board.created",
        audience: ROOM,
        payload: { board },
      });
    }
    submit(HOST, {
      type: "board.activated",
      audience: ROOM,
      payload: { boardId: map.boardId },
    });

    const aliceCharacter = character(ALICE, "character-alice", "Evelyn Ward", 65);
    const bobCharacter = character(BOB, "character-bob", "Thomas Reed", 45);
    submit(ALICE, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: aliceCharacter },
    });
    submit(BOB, {
      type: "character.updated",
      audience: ROOM,
      payload: { character: bobCharacter },
    });

    for (const [characterValue, seat] of [
      [aliceCharacter, ALICE],
      [bobCharacter, BOB],
    ] as const) {
      submit(HOST, {
        type: "entity.upserted",
        audience: ROOM,
        payload: {
          entity: {
            schemaVersion: 2,
            entityId: `entity-${characterValue.id}`,
            revision: 1,
            kind: "character",
            name: characterValue.name,
            description: `${seat.displayName}'s investigator token`,
            artifactIds: [],
            audience: ROOM,
            data: { ownerSeatId: seat.seatId, characterId: characterValue.id },
            extensions: {},
          },
        },
      });
    }

    const aliceToken = boardItem(
      "token-character-alice",
      { kind: "entity", entityId: "entity-character-alice" },
      { x: 250, y: 400 },
      { width: 96, height: 96 },
    );
    const bobToken = boardItem(
      "token-character-bob",
      { kind: "entity", entityId: "entity-character-bob" },
      { x: 350, y: 400 },
      { width: 96, height: 96 },
    );
    submit(HOST, {
      type: "board.item.upserted",
      audience: ROOM,
      payload: { boardId: map.boardId, boardRevision: 2, item: aliceToken },
    });
    submit(HOST, {
      type: "board.item.upserted",
      audience: ROOM,
      payload: { boardId: map.boardId, boardRevision: 3, item: bobToken },
    });

    const sequenceBeforeMove = sequencer.lastSequence;
    const movedAliceToken: BoardItemV1 = {
      ...aliceToken,
      position: { x: 1_200, y: 400 },
    };
    const moveEvent = submit(ALICE, {
      type: "board.item.upserted",
      audience: ROOM,
      payload: { boardId: map.boardId, boardRevision: 4, item: movedAliceToken },
    });
    const entryPrompt = submit(HOST, {
      type: "system.notice",
      audience: ROOM,
      payload: {
        message: "Evelyn entered the Archive wing region; awaiting Keeper adjudication.",
        level: "info",
      },
    });

    expect(moveEvent).toMatchObject({
      type: "board.item.upserted",
      sender: { seatId: ALICE.seatId },
      payload: { boardRevision: 4, item: { position: { x: 1_200, y: 400 } } },
    });
    expect(pointInsideItem(movedAliceToken.position, archiveZone)).toBe(true);
    expect(sequencer.eventsAfter(sequenceBeforeMove).map(({ type }) => type)).toEqual([
      "board.item.upserted",
      "system.notice",
    ]);

    // A region entry is only movement plus a prompt. Before the Keeper acts,
    // no location, NPC, clue, scene focus, or Keeper-only payload appears.
    const beforeKeeperPublication = replicaThrough(ALICE, sequencer, entryPrompt.sequence).deriveWorld();
    expect(beforeKeeperPublication.activeSceneEntityId).toBeUndefined();
    expect([...beforeKeeperPublication.entities.values()].some(({ kind }) => kind === "location" || kind === "npc")).toBe(false);
    expect([...beforeKeeperPublication.artifacts.values()].some(({ kind }) => kind === "clue" || kind === "handout")).toBe(false);
    expect(beforeKeeperPublication.entities.has("entity-keeper-ritual-truth")).toBe(false);
    expect(beforeKeeperPublication.artifacts.has("artifact-keeper-ritual-truth")).toBe(false);

    submit(HOST, {
      type: "scene.focused",
      audience: ROOM,
      payload: { sceneEntityId: "scene-archive" },
    });
    submit(HOST, {
      type: "board.activated",
      audience: ROOM,
      payload: { boardId: sceneBoard.boardId },
    });

    submit(HOST, {
      type: "artifact.upserted",
      audience: ROOM,
      payload: {
        artifact: {
          schemaVersion: 2,
          artifactId: "artifact-archive-description",
          revision: 1,
          kind: "handout",
          title: "Archive wing",
          description: "Keeper-published location description",
          body: "Dusty cabinets crowd the room; a phonograph turns without a record.",
          attachments: [],
          audience: ROOM,
          locked: true,
          archived: false,
          extensions: { sourceRef: sourceRef("handout", "handout-archive-description") },
        },
      },
    });
    submit(HOST, {
      type: "entity.upserted",
      audience: ROOM,
      payload: {
        entity: {
          schemaVersion: 2,
          entityId: "location-archive",
          revision: 1,
          kind: "location",
          name: "Archive wing",
          description: "Dusty cabinets and a silent phonograph.",
          artifactIds: ["artifact-archive-description"],
          audience: ROOM,
          data: { sourceRef: sourceRef("location", "location-archive-source") },
          extensions: {},
        },
      },
    });
    submit(HOST, {
      type: "board.item.upserted",
      audience: ROOM,
      payload: {
        boardId: sceneBoard.boardId,
        boardRevision: 2,
        item: boardItem(
          "item-location-archive",
          { kind: "entity", entityId: "location-archive" },
          { x: 250, y: 180 },
          { width: 900, height: 500 },
          true,
        ),
      },
    });

    const npcPublished = submit(HOST, {
      type: "entity.upserted",
      audience: ROOM,
      payload: {
        entity: {
          schemaVersion: 2,
          entityId: "npc-curator",
          revision: 1,
          kind: "npc",
          name: "Curator Hale",
          description: "An exhausted curator who avoids looking at the phonograph.",
          artifactIds: [],
          audience: ROOM,
          data: {
            publicSummary: "An exhausted curator with ink-stained cuffs.",
            sourceRef: sourceRef("npc", "npc-curator-source"),
          },
          extensions: {},
        },
      },
    });
    submit(HOST, {
      type: "board.item.upserted",
      audience: ROOM,
      payload: {
        boardId: sceneBoard.boardId,
        boardRevision: 3,
        item: boardItem(
          "token-npc-curator",
          { kind: "entity", entityId: "npc-curator" },
          { x: 1_100, y: 380 },
          { width: 112, height: 112 },
        ),
      },
    });
    expect(npcPublished).toMatchObject({
      type: "entity.upserted",
      audience: ROOM,
      payload: { entity: { kind: "npc", data: { publicSummary: expect.any(String) } } },
    });

    const checkRequest = submit(ALICE, {
      type: "check.requested",
      audience: ROOM,
      payload: {
        requestId: "check-phonograph",
        characterId: aliceCharacter.id,
        characterName: aliceCharacter.name,
        skillName: "Spot Hidden",
        proposedTarget: 65,
        goal: "Find what is driving the phonograph.",
        approach: "Inspect the cabinet seams and trace the spindle mechanism by hand.",
        suggestedSkillName: "Spot Hidden",
        reason: "Search the phonograph without opening it.",
      },
    });
    const authorization = submit(HOST, {
      type: "check.authorized",
      audience: ROOM,
      payload: {
        requestId: "check-phonograph",
        skillName: "Spot Hidden",
        target: 65,
        requiredDifficulty: "hard",
        bonusDice: 1,
        penaltyDice: 0,
        note: "The focused lighting grants one bonus die.",
      },
    });
    expect(checkRequest).toMatchObject({
      type: "check.requested",
      payload: {
        goal: "Find what is driving the phonograph.",
        approach: expect.stringContaining("trace the spindle"),
      },
    });
    expect(authorization).toMatchObject({
      type: "check.authorized",
      sender: { seatId: HOST.seatId },
      payload: { skillName: "Spot Hidden", requiredDifficulty: "hard", bonusDice: 1 },
    });

    const diceCommand: RoomCommandV2 = roomCommandV2Schema.parse({
      protocolVersion: 2,
      roomId: ROOM_ID,
      commandId: uuid("8", ++commandCounter),
      sender: ALICE,
      sentAt: "2026-08-30T10:01:00.000Z",
      type: "dice.roll",
      audience: ROOM,
      payload: {
        expression: "1d100",
        reason: "Spot Hidden: phonograph mechanism",
        bonusDice: 1,
        penaltyDice: 0,
        target: 65,
        requiredDifficulty: "hard",
        checkRequestId: "check-phonograph",
      },
    });
    const authoritativeRoll = sequencer.commitCommand(diceCommand, ALICE).event;
    expect(authoritativeRoll).toMatchObject({
      type: "dice.result",
      sender: { seatId: ALICE.seatId },
      audience: ROOM,
      causedByCommandId: diceCommand.commandId,
      payload: {
        checkRequestId: "check-phonograph",
        result: {
          kind: "percentile",
          candidates: [64, 24],
          total: 24,
          check: { requiredDifficulty: "hard", outcome: "hard", success: true },
        },
      },
    });
    expect(sequencer.world.checkAuthorizations.get("check-phonograph")).toMatchObject({
      skillName: "Spot Hidden",
      target: 65,
      requiredDifficulty: "hard",
      bonusDice: 1,
      resolvedByEventId: authoritativeRoll.eventId,
      resolvedSuccess: true,
    });

    submit(HOST, {
      type: "check.outcome.described",
      audience: ROOM,
      payload: {
        requestId: "check-phonograph",
        text: "Evelyn finds a wax-paper strip hidden beneath the spindle housing.",
      },
    });
    submit(HOST, {
      type: "artifact.upserted",
      audience: ROOM,
      payload: {
        artifact: {
          schemaVersion: 2,
          artifactId: "clue-wax-strip",
          revision: 1,
          kind: "clue",
          title: "Wax-paper strip",
          description: "Recovered from the phonograph",
          body: "Three names are circled beside tonight's final performance.",
          attachments: [],
          audience: ROOM,
          locked: true,
          archived: false,
          extensions: { sourceRef: sourceRef("clue", "clue-wax-strip-source") },
        },
      },
    });

    submit(ALICE, {
      type: "clue.claimed",
      audience: ROOM,
      payload: {
        artifactId: "clue-wax-strip",
        characterId: aliceCharacter.id,
        characterName: aliceCharacter.name,
      },
    });
    submit(BOB, {
      type: "clue.claimed",
      audience: ROOM,
      payload: {
        artifactId: "clue-wax-strip",
        characterId: bobCharacter.id,
        characterName: bobCharacter.name,
      },
    });
    submit(HOST, {
      type: "board.item.upserted",
      audience: ROOM,
      payload: {
        boardId: evidenceBoard.boardId,
        boardRevision: 2,
        item: boardItem(
          "item-clue-wax-strip",
          { kind: "artifact", artifactId: "clue-wax-strip" },
          { x: 500, y: 260 },
          { width: 360, height: 220 },
        ),
      },
    });

    const allEvents = sequencer.eventsAfter(0);
    expect(allEvents.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: allEvents.length }, (_, index) => index + 1),
    );
    expect(sequencer.world.activeModule).toEqual({
      moduleId: MODULE_ID,
      revision: 1,
      title: "The Final Curtain",
    });
    expect(sequencer.world.entities.get("location-archive")?.data.sourceRef).toEqual(
      sourceRef("location", "location-archive-source"),
    );
    expect(sequencer.world.entities.get("npc-curator")?.data.sourceRef).toEqual(
      sourceRef("npc", "npc-curator-source"),
    );

    const aliceViews = sequencer.viewsAfter(ALICE, 0);
    const bobViews = sequencer.viewsAfter(BOB, 0);
    for (const privateEvent of [privateArtifactEvent, privateEntityEvent]) {
      expect(aliceViews[privateEvent.sequence - 1]).toMatchObject({
        view: "redacted",
        sequence: privateEvent.sequence,
      });
      expect(bobViews[privateEvent.sequence - 1]).toMatchObject({
        view: "redacted",
        sequence: privateEvent.sequence,
      });
    }
    for (const serializedViews of [JSON.stringify(aliceViews), JSON.stringify(bobViews)]) {
      expect(serializedViews).not.toContain(privateText);
      expect(serializedViews).not.toContain("artifact-keeper-ritual-truth");
      expect(serializedViews).not.toContain("entity-keeper-ritual-truth");
    }

    const aliceReplica = new EventViewReplicaV2(ROOM_ID);
    const bobReplica = new EventViewReplicaV2(ROOM_ID);
    aliceViews.forEach((view) => aliceReplica.apply(view));
    bobViews.forEach((view) => bobReplica.apply(view));
    const aliceWorld = aliceReplica.deriveWorld();
    const bobWorld = bobReplica.deriveWorld();

    expect(aliceWorld).toEqual(bobWorld);
    expect(aliceWorld.lastSequence).toBe(sequencer.lastSequence);
    expect(aliceWorld.activeSceneEntityId).toBe("scene-archive");
    expect(aliceWorld.entities.has("entity-keeper-ritual-truth")).toBe(false);
    expect(aliceWorld.artifacts.has("artifact-keeper-ritual-truth")).toBe(false);
    expect(aliceWorld.entities.get("location-archive")).toMatchObject({
      kind: "location",
      artifactIds: ["artifact-archive-description"],
      audience: ROOM,
    });
    expect(aliceWorld.entities.get("npc-curator")).toMatchObject({
      kind: "npc",
      audience: ROOM,
    });
    expect(aliceWorld.boards.get(sceneBoard.boardId)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: "token-npc-curator",
          reference: { kind: "entity", entityId: "npc-curator" },
        }),
      ]),
    );
    expect(aliceWorld.clueClaims.get("clue-wax-strip")).toMatchObject([
      { seatId: ALICE.seatId, characterId: aliceCharacter.id },
      { seatId: BOB.seatId, characterId: bobCharacter.id },
    ]);
    expect(aliceWorld.boards.get(evidenceBoard.boardId)?.items).toEqual([
      expect.objectContaining({
        itemId: "item-clue-wax-strip",
        reference: { kind: "artifact", artifactId: "clue-wax-strip" },
      }),
    ]);
    expect(JSON.stringify(worldPayload(aliceWorld))).not.toContain(privateText);
  });
});

function replicaThrough(
  seat: SeatV2,
  sequencer: HostEventSequencerV2,
  sequence: number,
): EventViewReplicaV2 {
  const replica = new EventViewReplicaV2(ROOM_ID);
  sequencer.viewsAfter(seat, 0)
    .slice(0, sequence)
    .forEach((view) => replica.apply(view));
  return replica;
}

function sourceRef(kind: string, id: string) {
  return { moduleId: MODULE_ID, revision: 1, kind, id };
}

function boardItem(
  itemId: string,
  reference: BoardItemV1["reference"],
  position: BoardItemV1["position"],
  size: NonNullable<BoardItemV1["size"]>,
  locked = false,
): BoardItemV1 {
  return {
    schemaVersion: 1,
    itemId,
    reference,
    label: itemId,
    position,
    size,
    rotationDegrees: 0,
    scale: 1,
    zIndex: 0,
    locked,
    audience: ROOM,
    extensions: {},
  };
}

function pointInsideItem(point: BoardItemV1["position"], item: BoardItemV1): boolean {
  const size = item.size;
  if (!size) return false;
  return point.x >= item.position.x
    && point.x <= item.position.x + size.width
    && point.y >= item.position.y
    && point.y <= item.position.y + size.height;
}

function character(
  owner: SeatV2,
  id: string,
  name: string,
  spotHidden: number,
): Coc7Character {
  return {
    schemaVersion: 1,
    id,
    ownerPeerId: owner.seatId,
    name,
    playerName: owner.displayName,
    occupation: "Investigator",
    age: 31,
    residence: "Arkham",
    birthplace: "Boston",
    characteristics: {
      str: 50,
      con: 55,
      siz: 55,
      dex: 60,
      app: 50,
      int: 65,
      pow: 55,
      edu: 70,
      luck: 50,
    },
    derived: {
      hitPoints: 11,
      maxHitPoints: 11,
      magicPoints: 11,
      maxMagicPoints: 11,
      sanity: 55,
      maxSanity: 99,
      movementRate: 8,
      build: 0,
      damageBonus: "0",
    },
    skills: [{
      id: `skill-spot-hidden-${owner.seatId}`,
      name: "Spot Hidden",
      baseValue: 25,
      value: spotHidden,
      checked: false,
    }],
    status: {
      temporaryInsanity: false,
      indefiniteInsanity: false,
      majorWound: false,
      dying: false,
      unconscious: false,
    },
    inventory: [],
    background: {
      personalDescription: "",
      ideologyAndBeliefs: "",
      significantPeople: "",
      meaningfulLocations: "",
      treasuredPossessions: "",
      traits: "",
      injuriesAndScars: "",
      phobiasAndManias: "",
      arcaneTomesSpellsAndArtifacts: "",
      encountersWithStrangeEntities: "",
    },
    notes: "",
    updatedAt: "2026-08-30T10:00:00.000Z",
    extensions: {},
  };
}

function uuid(prefix: string, value: number): string {
  return `${prefix}0000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function worldPayload(world: ReturnType<EventViewReplicaV2["deriveWorld"]>) {
  return {
    entities: [...world.entities.values()],
    artifacts: [...world.artifacts.values()],
    boards: [...world.boards.values()],
    characters: [...world.latestCharacters.values()],
    checks: [...world.checkOutcomes.values()],
    claims: [...world.clueClaims.values()],
  };
}
