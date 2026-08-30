import type {
  Coc7Character,
  ParticipantV1,
  RoomEventViewV2,
  RoomInvitationPayloadV2,
  SeatV2,
} from "@coc-room/protocol";
import { describe, expect, it } from "vitest";

import { MemoryRepository, type RoomRecord } from "../data/repository";
import { saveLocalSeatSecret } from "../lib/seat-credentials";
import { RoomSessionV2 } from "./RoomSessionV2";
import { RoomTransport } from "./RoomTransport";

const relayOrigin = process.env.COC_ROOM_LIVE_RELAY_URL?.replace(/\/$/u, "");
const liveDescribe = relayOrigin ? describe : describe.skip;

interface CreatedRelayRoom {
  protocolVersion: 1;
  roomId: string;
  hostPeerId: string;
  hostToken: string;
  joinToken: string;
  websocketUrl: string;
}

liveDescribe("RoomSessionV2 live forced-relay integration", () => {
  it("authenticates independent seats, redacts secrets, and catches up a reconnecting seat", async () => {
    if (!relayOrigin) throw new Error("COC_ROOM_LIVE_RELAY_URL is required");
    if (typeof WebSocket === "undefined") {
      throw new Error("This smoke requires the WebSocket implementation bundled with Node 22+");
    }

    const hostPeerId = "live-v2-host-123456";
    const alicePeerId = "live-v2-alice-12345";
    const bobPeerId = "live-v2-bob-1234567";
    const created = await createRelayRoom(relayOrigin, hostPeerId);
    const hostRepository = new MemoryRepository();
    const aliceRepository = new MemoryRepository();
    const bobRepository = new MemoryRepository();
    const hostRoom = hostRoomRecord(created, "seat-live-v2-host");
    const host = createSession(hostRoom, "Live Keeper", hostRepository);
    const errors: string[] = [];
    const relayPaths: string[] = [];
    let hostPresence: SeatV2[] = [];
    let aliceForCleanup: RoomSessionV2 | undefined;
    let bob: RoomSessionV2 | undefined;

    host.onError = (message) => errors.push(`host: ${message}`);
    host.onPresence = (seats) => { hostPresence = seats; };
    host.onPathChange = (peerId, path) => relayPaths.push(`${peerId}:${path}`);

    try {
      await host.start();
      const aliceInvitation = await host.issueSeatInvitation("Live Alice", "seat-live-v2-alice");
      const bobInvitation = await host.issueSeatInvitation("Live Bob", "seat-live-v2-bob");
      expect(aliceInvitation.seatId).not.toBe(bobInvitation.seatId);
      expect(aliceInvitation.seatSecret).not.toBe(bobInvitation.seatSecret);
      expect(aliceInvitation.relayToken).toBe(created.joinToken);
      expect(bobInvitation.relayToken).toBe(created.joinToken);

      await saveLocalSeatSecret(created.roomId, aliceInvitation.seatId, aliceInvitation.seatSecret);
      await saveLocalSeatSecret(created.roomId, bobInvitation.seatId, bobInvitation.seatSecret);

      const aliceRoom = playerRoomRecord(aliceInvitation, alicePeerId);
      const alice = createSession(aliceRoom, "Live Alice", aliceRepository);
      aliceForCleanup = alice;
      const aliceAuthStates: string[] = [];
      alice.onAuthenticationState = (state) => aliceAuthStates.push(state);
      alice.onError = (message) => errors.push(`alice: ${message}`);
      alice.onPathChange = (peerId, path) => relayPaths.push(`${peerId}:${path}`);

      const bobRoom = playerRoomRecord(bobInvitation, bobPeerId);
      bob = createSession(bobRoom, "Live Bob", bobRepository);
      const bobAuthStates: string[] = [];
      bob.onAuthenticationState = (state) => bobAuthStates.push(state);
      bob.onError = (message) => errors.push(`bob: ${message}`);
      bob.onPathChange = (peerId, path) => relayPaths.push(`${peerId}:${path}`);

      await alice.start();
      await bob.start();
      await waitUntil(
        () => alice.isAuthenticated && bob?.isAuthenticated === true,
        errors,
        "both player seats did not complete HMAC authentication",
      );
      await waitUntil(
        () => hostPresence.some(({ seatId }) => seatId === aliceInvitation.seatId)
          && hostPresence.some(({ seatId }) => seatId === bobInvitation.seatId),
        errors,
        "host did not observe both authenticated seats",
      );
      expect(aliceAuthStates).toEqual(expect.arrayContaining(["challenged", "authenticated"]));
      expect(bobAuthStates).toEqual(expect.arrayContaining(["challenged", "authenticated"]));

      await alice.submitConfirmed({
        type: "chat.message",
        audience: { kind: "room" },
        payload: { message: "public event from authenticated Alice", format: "plain" },
      });
      await waitForSequence([host, alice, bob], 1, errors);

      const secretBody = "LIVE_V2_SECRET_BODY_ONLY_ALICE_CAN_READ";
      const secretHash = "a".repeat(64);
      const secretAssetId = `sha256:${secretHash}` as const;
      await host.submit({
        type: "artifact.upserted",
        audience: { kind: "seats", seatIds: [aliceInvitation.seatId] },
        payload: {
          artifact: {
            schemaVersion: 2,
            artifactId: "artifact-live-v2-secret",
            revision: 1,
            kind: "handout-image",
            title: "Alice-only handout",
            description: "This title and description must not reach Bob.",
            body: secretBody,
            attachments: [{
              schemaVersion: 1,
              assetId: secretAssetId,
              mediaType: "image/webp",
              byteLength: 1234,
              width: 640,
              height: 480,
            }],
            audience: { kind: "seats", seatIds: [aliceInvitation.seatId] },
            locked: true,
            archived: false,
            extensions: {},
          },
        },
      });
      await waitForSequence([host, alice, bob], 2, errors);

      const aliceBeforeReconnect = await aliceRepository.listEventViewsV2(created.roomId);
      const bobBeforeReconnect = await bobRepository.listEventViewsV2(created.roomId);
      expect(aliceBeforeReconnect[1]).toMatchObject({
        view: "full",
        event: {
          sequence: 2,
          type: "artifact.upserted",
          payload: { artifact: { body: secretBody } },
        },
      });
      expect(bobBeforeReconnect[1]).toMatchObject({
        view: "redacted",
        roomId: created.roomId,
        sequence: 2,
      });
      assertRedactedViewContainsNoSecret(bobBeforeReconnect[1], secretBody, secretHash);

      bob.stop();
      await waitUntil(
        () => relayPaths.includes(`${bobPeerId}:offline`),
        errors,
        "host transport did not observe Bob's old peer going offline",
      );
      await host.submit({
        type: "chat.message",
        audience: { kind: "room" },
        payload: { message: "public event created while Bob is offline", format: "plain" },
      });
      await waitForSequence([host, alice], 3, errors);
      expect(await bobRepository.listEventViewsV2(created.roomId)).toHaveLength(2);

      const reconnectedRoom = playerRoomRecord(bobInvitation, "live-v2-bob-new-peer");
      bob = createSession(reconnectedRoom, "Live Bob", bobRepository);
      const reconnectAuthStates: string[] = [];
      bob.onAuthenticationState = (state) => reconnectAuthStates.push(state);
      bob.onError = (message) => errors.push(`reconnected bob: ${message}`);
      bob.onPathChange = (peerId, path) => relayPaths.push(`${peerId}:${path}`);
      await bob.start();
      await waitUntil(
        () => bob?.isAuthenticated === true,
        errors,
        "Bob's stable seat did not reauthenticate from the new peer",
      );
      await waitForSequence([bob], 3, errors);
      expect(reconnectAuthStates).toEqual(expect.arrayContaining(["challenged", "authenticated"]));

      await bob.submitConfirmed({
        type: "chat.message",
        audience: { kind: "room" },
        payload: { message: "public event from reconnected Bob", format: "plain" },
      });
      await waitForSequence([host, alice, bob], 4, errors);

      const hostViews = await hostRepository.listEventViewsV2(created.roomId);
      const aliceViews = await aliceRepository.listEventViewsV2(created.roomId);
      const bobViews = await bobRepository.listEventViewsV2(created.roomId);
      expect(fullEventsAt(hostViews, [1, 3, 4])).toEqual(fullEventsAt(aliceViews, [1, 3, 4]));
      expect(fullEventsAt(hostViews, [1, 3, 4])).toEqual(fullEventsAt(bobViews, [1, 3, 4]));
      expect(hostViews.map(viewSequence)).toEqual([1, 2, 3, 4]);
      expect(aliceViews.map(viewSequence)).toEqual([1, 2, 3, 4]);
      expect(bobViews.map(viewSequence)).toEqual([1, 2, 3, 4]);
      expect(bobViews[1]?.view).toBe("redacted");
      assertRedactedViewContainsNoSecret(bobViews[1], secretBody, secretHash);
      expect(JSON.stringify(aliceViews)).toContain(secretAssetId);
      expect(relayPaths.some((entry) => entry.endsWith(":relay"))).toBe(true);
      expect(relayPaths.some((entry) => entry.endsWith(":direct"))).toBe(false);
      expect(errors).toEqual([]);

    } finally {
      aliceForCleanup?.stop();
      bob?.stop();
      host.stop();
    }
  }, 45_000);

  it("runs a complete public investigation journey without leaking the keeper-only source", async () => {
    if (!relayOrigin) throw new Error("COC_ROOM_LIVE_RELAY_URL is required");
    if (typeof WebSocket === "undefined") {
      throw new Error("This smoke requires the WebSocket implementation bundled with Node 22+");
    }

    const created = await createRelayRoom(relayOrigin, "journey-v2-host-12345");
    const hostRepository = new MemoryRepository();
    const aliceRepository = new MemoryRepository();
    const bobRepository = new MemoryRepository();
    const hostRoom = hostRoomRecord(created, "seat-journey-host");
    const host = createSession(hostRoom, "Journey Keeper", hostRepository);
    const errors: string[] = [];
    let alice: RoomSessionV2 | undefined;
    let bob: RoomSessionV2 | undefined;

    host.onError = (message) => errors.push(`host: ${message}`);

    try {
      await host.start();
      const aliceInvitation = await host.issueSeatInvitation("Alice Reporter", "seat-journey-alice");
      const bobInvitation = await host.issueSeatInvitation("Bob Doctor", "seat-journey-bob");
      await saveLocalSeatSecret(created.roomId, aliceInvitation.seatId, aliceInvitation.seatSecret);
      await saveLocalSeatSecret(created.roomId, bobInvitation.seatId, bobInvitation.seatSecret);

      const aliceRoom = playerRoomRecord(aliceInvitation, "journey-v2-alice-peer");
      const bobRoom = playerRoomRecord(bobInvitation, "journey-v2-bob-peer");
      alice = createSession(aliceRoom, "Alice Reporter", aliceRepository);
      bob = createSession(bobRoom, "Bob Doctor", bobRepository);
      alice.onError = (message) => errors.push(`alice: ${message}`);
      bob.onError = (message) => errors.push(`bob: ${message}`);
      await alice.start();
      await bob.start();
      await waitUntil(
        () => alice?.isAuthenticated === true && bob?.isAuthenticated === true,
        errors,
        "journey players did not authenticate",
      );

      const roomAudience = { kind: "room" as const };
      const aliceCharacter = liveCharacter(
        aliceInvitation.seatId,
        "character-live-alice",
        "Alice Ward",
        "Alice Reporter",
        "Investigative journalist",
      );
      const bobCharacter = liveCharacter(
        bobInvitation.seatId,
        "character-live-bob",
        "Bob Chen",
        "Bob Doctor",
        "Emergency physician",
      );
      await alice.submitConfirmed({
        type: "character.updated",
        audience: roomAudience,
        payload: { character: aliceCharacter },
      });
      await bob.submitConfirmed({
        type: "character.updated",
        audience: roomAudience,
        payload: { character: bobCharacter },
      });
      await host.submitConfirmed({
        type: "module.switched",
        audience: roomAudience,
        payload: { moduleId: "module-live-relay-journey", revision: 1, title: "The Last Record" },
      });

      const keeperSecretBody = "KEEPER_ONLY: the stagehand serves the thing beneath the gramophone.";
      const keeperSecretHash = "c".repeat(64);
      await host.submitConfirmed({
        type: "artifact.upserted",
        audience: { kind: "host" },
        payload: {
          artifact: {
            schemaVersion: 2,
            artifactId: "artifact-keeper-source",
            revision: 1,
            kind: "note",
            title: "Keeper source note",
            description: "Never reveal this source summary directly.",
            body: keeperSecretBody,
            attachments: [{
              schemaVersion: 1,
              assetId: `sha256:${keeperSecretHash}` as const,
              mediaType: "image/webp",
              byteLength: 2048,
              width: 800,
              height: 600,
            }],
            audience: { kind: "host" },
            locked: true,
            archived: false,
            extensions: {},
          },
        },
      });

      await host.submitConfirmed({
        type: "board.created",
        audience: roomAudience,
        payload: {
          board: {
            schemaVersion: 1,
            boardId: "board-live-stage",
            revision: 1,
            kind: "scene",
            name: "Backstage exploration",
            description: "A shared stage for the current investigation.",
            audience: roomAudience,
            logicalSize: { width: 1600, height: 900 },
            archived: false,
            items: [],
            edges: [],
            extensions: {},
          },
        },
      });
      const scene = {
        schemaVersion: 2 as const,
        entityId: "scene-live-record-room",
        revision: 1,
        kind: "scene" as const,
        name: "The shuttered record room",
        description: "Dust floats through a cone of lamplight while a gramophone turns without music.",
        artifactIds: [],
        audience: roomAudience,
        data: { sourceRef: { moduleId: "module-live-relay-journey", revision: 1, kind: "scene", id: "source-scene-record-room" } },
        extensions: {},
      };
      await host.submitConfirmed({ type: "entity.upserted", audience: roomAudience, payload: { entity: scene } });
      await host.submitConfirmed({
        type: "board.item.upserted",
        audience: roomAudience,
        payload: {
          boardId: "board-live-stage",
          boardRevision: 2,
          item: entityBoardItem("item-live-scene", scene.entityId, scene.name, { x: 760, y: 330 }, true, { width: 420, height: 260 }),
        },
      });
      await host.submitConfirmed({
        type: "scene.focused",
        audience: roomAudience,
        payload: { sceneEntityId: scene.entityId },
      });

      const location = {
        schemaVersion: 2 as const,
        entityId: "location-live-record-room",
        revision: 1,
        kind: "location" as const,
        name: "Gramophone archive",
        description: "Shelves of cracked shellac records surround a brass gramophone with a warm needle.",
        artifactIds: [],
        audience: roomAudience,
        data: {
          sourceRef: { moduleId: "module-live-relay-journey", revision: 1, kind: "location", id: "source-location-archive" },
          presentedInSceneEntityIds: [scene.entityId],
        },
        extensions: {},
      };
      await host.submitConfirmed({ type: "entity.upserted", audience: roomAudience, payload: { entity: location } });

      const npc = {
        schemaVersion: 2 as const,
        entityId: "npc-live-stagehand",
        revision: 1,
        kind: "npc" as const,
        name: "Elias, the elderly stagehand",
        description: "An exhausted stagehand avoids looking directly at the spinning gramophone.",
        artifactIds: [],
        audience: roomAudience,
        data: {
          sourceRef: { moduleId: "module-live-relay-journey", revision: 1, kind: "npc", id: "source-npc-stagehand" },
          presentedInSceneEntityIds: [scene.entityId],
        },
        extensions: {},
      };
      await host.submitConfirmed({ type: "entity.upserted", audience: roomAudience, payload: { entity: npc } });
      await host.submitConfirmed({
        type: "board.item.upserted",
        audience: roomAudience,
        payload: {
          boardId: "board-live-stage",
          boardRevision: 3,
          item: entityBoardItem("item-live-stagehand", npc.entityId, npc.name, { x: 1020, y: 510 }, false, { width: 150, height: 150 }),
        },
      });
      await waitUntil(
        () => alice?.world.activeSceneEntityId === scene.entityId
          && bob?.world.entities.get(location.entityId)?.description === location.description
          && bob?.world.entities.get(npc.entityId)?.description === npc.description,
        errors,
        "published scene, location, and NPC did not reach both players",
      );

      let successfulRoll: Extract<RoomEventViewV2, { view: "full" }>['event'] | undefined;
      for (let attempt = 1; attempt <= 4 && successfulRoll === undefined; attempt += 1) {
        const requestId = `check-live-listen-${attempt}`;
        await alice.submitConfirmed({
          type: "check.requested",
          audience: roomAudience,
          payload: {
            requestId,
            characterId: aliceCharacter.id,
            characterName: aliceCharacter.name,
            skillName: "Listen",
            proposedTarget: 100,
            reason: attempt === 1
              ? "Listen for a second sound beneath the silent record."
              : "Push the investigation after the previous fumble.",
          },
        });
        await host.submitConfirmed({
          type: "check.authorized",
          audience: roomAudience,
          payload: {
            requestId,
            target: 100,
            requiredDifficulty: "regular",
            bonusDice: 2,
            penaltyDice: 0,
            note: "Allowed: roll Listen with two bonus dice.",
          },
        });
        await alice.rollDice({
          expression: "1d100",
          reason: "Listen beneath the gramophone record",
          bonusDice: 2,
          penaltyDice: 0,
          target: 100,
          requiredDifficulty: "regular",
          checkRequestId: requestId,
        });
        await waitUntil(
          () => host.world.checkAuthorizations.get(requestId)?.resolvedByEventId !== undefined,
          errors,
          `secure roll ${attempt} was not sequenced by the host`,
        );
        const roll = (await hostRepository.listEventViewsV2(created.roomId)).find((view) => (
          view.view === "full"
          && view.event.type === "dice.result"
          && view.event.payload.checkRequestId === requestId
        ));
        if (roll?.view === "full" && roll.event.type === "dice.result") {
          const result = roll.event.payload.result;
          if (result.kind === "percentile" && result.check?.success) successfulRoll = roll.event;
        }
      }
      expect(successfulRoll?.type).toBe("dice.result");
      if (successfulRoll?.type !== "dice.result") throw new Error("secure percentile check did not succeed");
      expect(successfulRoll.sender.seatId).toBe(aliceInvitation.seatId);
      expect(successfulRoll.payload.result).toMatchObject({
        kind: "percentile",
        expression: "1d100",
        bonusDice: 2,
        penaltyDice: 0,
        check: { target: 100, requiredDifficulty: "regular", success: true },
      });
      if (successfulRoll.payload.result.kind !== "percentile") throw new Error("expected a percentile result");
      expect(successfulRoll.payload.result.candidates).toHaveLength(3);
      expect(successfulRoll.payload.result.total).toBe(Math.min(...successfulRoll.payload.result.candidates));

      const consequence = "The hidden harmony resolves: the record must be played in reverse order.";
      await host.submitConfirmed({
        type: "chat.message",
        audience: roomAudience,
        payload: { message: consequence, format: "plain" },
      });
      const clue = {
        schemaVersion: 2 as const,
        artifactId: "clue-live-reversed-score",
        revision: 1,
        kind: "clue" as const,
        title: "Reversed score",
        description: "",
        body: "The pencilled sequence begins at the finale and runs backward to the overture.",
        attachments: [],
        audience: roomAudience,
        locked: true,
        archived: false,
        extensions: { sourceRef: { moduleId: "module-live-relay-journey", revision: 1, kind: "clue", id: "source-clue-score" } },
      };
      await host.submitConfirmed({ type: "artifact.upserted", audience: roomAudience, payload: { artifact: clue } });
      await waitUntil(
        () => alice?.world.artifacts.has(clue.artifactId) === true && bob?.world.artifacts.has(clue.artifactId) === true,
        errors,
        "public clue did not reach both players",
      );
      await alice.submitConfirmed({
        type: "clue.claimed",
        audience: roomAudience,
        payload: { artifactId: clue.artifactId, characterId: aliceCharacter.id, characterName: aliceCharacter.name },
      });
      await bob.submitConfirmed({
        type: "clue.claimed",
        audience: roomAudience,
        payload: { artifactId: clue.artifactId, characterId: bobCharacter.id, characterName: bobCharacter.name },
      });

      await host.submitConfirmed({
        type: "board.created",
        audience: roomAudience,
        payload: {
          board: {
            schemaVersion: 1,
            boardId: "board-live-public-clues",
            revision: 1,
            kind: "evidence",
            name: "Shared clue board",
            description: "Everyone can arrange the facts they have discovered.",
            audience: roomAudience,
            logicalSize: { width: 1600, height: 900 },
            archived: false,
            items: [],
            edges: [],
            extensions: {},
          },
        },
      });
      await waitUntil(
        () => alice?.world.boards.has("board-live-public-clues") === true,
        errors,
        "public clue board did not reach Alice",
      );
      await alice.submitConfirmed({
        type: "board.item.upserted",
        audience: roomAudience,
        payload: {
          boardId: "board-live-public-clues",
          boardRevision: 2,
          item: {
            schemaVersion: 1,
            itemId: "item-live-reversed-score",
            reference: { kind: "artifact", artifactId: clue.artifactId },
            label: clue.title,
            position: { x: 420, y: 280 },
            size: { width: 310, height: 180 },
            rotationDegrees: 0,
            scale: 1,
            zIndex: 0,
            locked: false,
            audience: roomAudience,
            extensions: { roomRole: "clue-card" },
          },
        },
      });

      const finalSequence = host.lastContiguousSequence;
      await waitForSequence([host, alice, bob], finalSequence, errors);
      const hostViews = await hostRepository.listEventViewsV2(created.roomId);
      const aliceViews = await aliceRepository.listEventViewsV2(created.roomId);
      const bobViews = await bobRepository.listEventViewsV2(created.roomId);
      const keeperView = hostViews.find((view) => view.view === "full"
        && view.event.type === "artifact.upserted"
        && view.event.payload.artifact.artifactId === "artifact-keeper-source");
      if (keeperView?.view !== "full") throw new Error("keeper-only source event was not persisted by the host");
      const secretSequence = keeperView.event.sequence;
      assertRedactedViewContainsNoSecret(aliceViews.find((view) => viewSequence(view) === secretSequence), keeperSecretBody, keeperSecretHash);
      assertRedactedViewContainsNoSecret(bobViews.find((view) => viewSequence(view) === secretSequence), keeperSecretBody, keeperSecretHash);
      expect(JSON.stringify(aliceViews)).not.toContain(keeperSecretBody);
      expect(JSON.stringify(bobViews)).not.toContain(keeperSecretBody);

      for (const hostView of hostViews) {
        const sequence = viewSequence(hostView);
        if (sequence === secretSequence) continue;
        expect(aliceViews.find((view) => viewSequence(view) === sequence)).toEqual(hostView);
        expect(bobViews.find((view) => viewSequence(view) === sequence)).toEqual(hostView);
      }

      expect(alice.world.activeSceneEntityId).toBe(scene.entityId);
      expect(alice.world.entities.get(location.entityId)?.description).toBe(location.description);
      expect(alice.world.entities.get(npc.entityId)?.description).toBe(npc.description);
      expect(alice.world.boards.get("board-live-stage")?.items.some((item) => (
        item.reference.kind === "entity" && item.reference.entityId === npc.entityId
      ))).toBe(true);
      const expectedClaims = [
        { seatId: aliceInvitation.seatId, characterId: aliceCharacter.id },
        { seatId: bobInvitation.seatId, characterId: bobCharacter.id },
      ];
      for (const session of [host, alice, bob]) {
        expect(session.world.clueClaims.get(clue.artifactId)?.map(({ seatId, characterId }) => ({ seatId, characterId }))).toEqual(expectedClaims);
      }
      const sharedBoard = host.world.boards.get("board-live-public-clues");
      expect(sharedBoard?.items).toHaveLength(1);
      expect(sharedBoard?.items[0]?.reference).toEqual({ kind: "artifact", artifactId: clue.artifactId });
      expect(alice.world.boards.get("board-live-public-clues")).toEqual(sharedBoard);
      expect(bob.world.boards.get("board-live-public-clues")).toEqual(sharedBoard);
      const consequenceView = hostViews.find((view) => view.view === "full"
        && view.event.type === "chat.message"
        && view.event.payload.message === consequence);
      const clueView = hostViews.find((view) => view.view === "full"
        && view.event.type === "artifact.upserted"
        && view.event.payload.artifact.artifactId === clue.artifactId);
      expect(consequenceView && clueView && viewSequence(consequenceView) < viewSequence(clueView)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      bob?.stop();
      alice?.stop();
      host.stop();
    }
  }, 60_000);
});

async function createRelayRoom(origin: string, hostPeerId: string): Promise<CreatedRelayRoom> {
  const response = await fetch(`${origin}/v1/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostPeerId }),
  });
  if (!response.ok) throw new Error(`relay room creation failed with HTTP ${response.status}`);
  return await response.json() as CreatedRelayRoom;
}

function createSession(
  room: RoomRecord,
  displayName: string,
  repository: MemoryRepository,
): RoomSessionV2 {
  const transport = new RoomTransport({
    roomId: room.id,
    token: room.inviteToken,
    relayUrl: room.relayUrl,
    participant: participant(room, displayName),
    hostPeerId: room.hostPeerId,
    forceRelay: true,
  });
  return new RoomSessionV2({ room, displayName, repository, transport });
}

function hostRoomRecord(created: CreatedRelayRoom, seatId: string): RoomRecord {
  const now = "2026-08-30T00:00:00.000Z";
  return {
    id: created.roomId,
    name: "Live V2 Relay Smoke",
    localRole: "host",
    localPeerId: created.hostPeerId,
    hostPeerId: created.hostPeerId,
    inviteToken: created.hostToken,
    joinToken: created.joinToken,
    relayUrl: created.websocketUrl,
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
    protocolVersion: 2,
    localSeatId: seatId,
    hostSeatId: seatId,
    seatCredentialVersion: 1,
  };
}

function playerRoomRecord(invitation: RoomInvitationPayloadV2, peerId: string): RoomRecord {
  const now = "2026-08-30T00:00:00.000Z";
  return {
    id: invitation.roomId,
    name: "Joined Live V2 Room",
    localRole: "player",
    localPeerId: peerId,
    hostPeerId: invitation.hostPeerId,
    inviteToken: invitation.relayToken,
    relayUrl: invitation.relayUrl,
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
    protocolVersion: 2,
    localSeatId: invitation.seatId,
    hostSeatId: invitation.hostSeatId,
    seatCredentialVersion: invitation.credentialVersion,
  };
}

function participant(room: RoomRecord, displayName: string): ParticipantV1 {
  return {
    peerId: room.localPeerId,
    displayName,
    role: room.localRole,
  };
}

async function waitForSequence(
  sessions: readonly RoomSessionV2[],
  sequence: number,
  errors: string[],
): Promise<void> {
  await waitUntil(
    () => sessions.every((session) => session.lastContiguousSequence === sequence),
    errors,
    `sessions did not reach contiguous sequence ${sequence}`,
  );
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  errors: string[],
  timeoutMessage: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (errors.length > 0) throw new Error(errors.join("\n"));
    if (await predicate()) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  }
  throw new Error(`${timeoutMessage}; errors: ${errors.join(" | ") || "none"}`);
}

function viewSequence(view: RoomEventViewV2): number {
  return view.view === "full" ? view.event.sequence : view.sequence;
}

function fullEventsAt(views: readonly RoomEventViewV2[], sequences: readonly number[]) {
  const expected = new Set(sequences);
  return views
    .filter((view) => expected.has(viewSequence(view)))
    .map((view) => {
      if (view.view !== "full") throw new Error(`expected a full public event at sequence ${view.sequence}`);
      return view.event;
    });
}

function entityBoardItem(
  itemId: string,
  entityId: string,
  label: string,
  position: { x: number; y: number },
  locked: boolean,
  size: { width: number; height: number },
) {
  return {
    schemaVersion: 1 as const,
    itemId,
    reference: { kind: "entity" as const, entityId },
    label,
    position,
    size,
    rotationDegrees: 0,
    scale: 1,
    zIndex: 0,
    locked,
    audience: { kind: "room" as const },
    extensions: {},
  };
}

function liveCharacter(
  ownerSeatId: string,
  id: string,
  name: string,
  playerName: string,
  occupation: string,
): Coc7Character {
  return {
    schemaVersion: 1,
    id,
    ownerPeerId: ownerSeatId,
    name,
    playerName,
    occupation,
    age: 32,
    residence: "Arkham",
    birthplace: "Boston",
    characteristics: {
      str: 50,
      con: 55,
      siz: 50,
      dex: 60,
      app: 55,
      int: 70,
      pow: 60,
      edu: 70,
      luck: 55,
    },
    derived: {
      hitPoints: 10,
      maxHitPoints: 10,
      magicPoints: 12,
      maxMagicPoints: 12,
      sanity: 60,
      maxSanity: 99,
      movementRate: 8,
      build: 0,
      damageBonus: "0",
    },
    skills: [{ id: "skill-listen", name: "Listen", baseValue: 20, value: 70, checked: false }],
    status: {
      temporaryInsanity: false,
      indefiniteInsanity: false,
      majorWound: false,
      dying: false,
      unconscious: false,
    },
    inventory: [],
    background: {
      personalDescription: "A careful observer carrying a weathered notebook.",
      ideologyAndBeliefs: "Evidence must survive scrutiny.",
      significantPeople: "A trusted colleague",
      meaningfulLocations: "The city archive",
      treasuredPossessions: "A fountain pen",
      traits: "Patient and methodical",
      injuriesAndScars: "",
      phobiasAndManias: "",
      arcaneTomesSpellsAndArtifacts: "",
      encountersWithStrangeEntities: "",
    },
    notes: "",
    updatedAt: "2026-08-30T00:00:00.000Z",
    extensions: {},
  };
}

function assertRedactedViewContainsNoSecret(
  view: RoomEventViewV2 | undefined,
  secretBody: string,
  secretHash: string,
): void {
  if (view?.view !== "redacted") throw new Error("expected a redacted event view");
  expect(Object.keys(view).sort()).toEqual([
    "eventId",
    "occurredAt",
    "protocolVersion",
    "roomId",
    "sequence",
    "view",
  ].sort());
  const serialized = JSON.stringify(view);
  expect(serialized).not.toContain("artifact.upserted");
  expect(serialized).not.toContain(secretBody);
  expect(serialized).not.toContain(secretHash);
  expect(serialized).not.toContain("sha256:");
  expect(serialized).not.toContain("image/webp");
}
