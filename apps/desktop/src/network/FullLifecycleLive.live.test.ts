import { readFileSync } from "node:fs";

import {
  exportEventsV2ToMarkdown,
  modulePackageSchema,
  type Coc7Character,
  type ModulePackageV1,
  type ParticipantV1,
  type RoomEventViewV2,
  type RoomInvitationPayloadV2,
} from "@coc-room/protocol";
import { describe, expect, it } from "vitest";

import { MemoryRepository, type RoomRecord } from "../data/repository";
import {
  buildPublishedModuleArtifactV2,
  buildPublishedModuleEntityV2,
} from "../lib/module-room-publishing-v2";
import { saveLocalSeatSecret } from "../lib/seat-credentials";
import { RoomSessionV2 } from "./RoomSessionV2";
import { RoomTransport } from "./RoomTransport";

const relayOrigin = process.env.COC_ROOM_LIVE_RELAY_URL?.replace(/\/$/u, "");
const liveDescribe = relayOrigin ? describe : describe.skip;
const modulePath = process.env.COC_ROOM_LIVE_MODULE_JSON;
const characterPath = process.env.COC_ROOM_LIVE_CHARACTER_JSON;

interface CreatedRelayRoom {
  protocolVersion: 1;
  roomId: string;
  hostPeerId: string;
  hostToken: string;
  joinToken: string;
  websocketUrl: string;
}

/**
 * One continuous table lifecycle over the real relay: switch to a (real, when
 * provided) parsed module, publish its content, seat two players, bring in a
 * (real, when provided) AI-drafted investigator, roleplay, move a token,
 * negotiate a check, reveal and claim a clue, run an NPC panel conversation,
 * close the session, and export both transcripts.
 */
liveDescribe("full table lifecycle over the live relay", () => {
  it("plays a session from module switch to transcript export", async () => {
    if (!relayOrigin) throw new Error("COC_ROOM_LIVE_RELAY_URL is required");
    if (typeof WebSocket === "undefined") {
      throw new Error("This smoke requires the WebSocket implementation bundled with Node 22+");
    }

    const modulePackage = loadModule();
    const created = await createRelayRoom(relayOrigin, "lifecycle-host-123456");
    const hostRepository = new MemoryRepository();
    const aliceRepository = new MemoryRepository();
    const bobRepository = new MemoryRepository();
    const host = createSession(hostRoomRecord(created, "seat-lifecycle-host"), "Lifecycle Keeper", hostRepository);
    const errors: string[] = [];
    let alice: RoomSessionV2 | undefined;
    let bob: RoomSessionV2 | undefined;
    host.onError = (message) => errors.push(`host: ${message}`);

    try {
      await host.start();
      const aliceInvitation = await host.issueSeatInvitation("Lifecycle Alice", "seat-lifecycle-alice");
      const bobInvitation = await host.issueSeatInvitation("Lifecycle Bob", "seat-lifecycle-bob");
      await saveLocalSeatSecret(created.roomId, aliceInvitation.seatId, aliceInvitation.seatSecret);
      await saveLocalSeatSecret(created.roomId, bobInvitation.seatId, bobInvitation.seatSecret);
      alice = createSession(playerRoomRecord(aliceInvitation, "lifecycle-alice-peer1"), "Lifecycle Alice", aliceRepository);
      bob = createSession(playerRoomRecord(bobInvitation, "lifecycle-bob-peer123"), "Lifecycle Bob", bobRepository);
      alice.onError = (message) => errors.push(`alice: ${message}`);
      bob.onError = (message) => errors.push(`bob: ${message}`);
      await alice.start();
      await bob.start();
      await waitUntil(
        () => alice?.isAuthenticated === true && bob?.isAuthenticated === true,
        errors,
        "players did not authenticate",
      );

      const roomAudience = { kind: "room" as const };

      // 1. Module switch announces the campaign source to the whole table.
      await host.submitConfirmed({
        type: "module.switched",
        audience: roomAudience,
        payload: {
          moduleId: modulePackage.moduleId,
          revision: modulePackage.revision,
          title: modulePackage.metadata.title,
        },
      });

      // 2. A keeper-only prep note must never reach player storage or exports.
      const keeperCanary = "KEEPERCANARY the ending is a trap behind the chapel organ";
      await host.submitConfirmed({
        type: "artifact.upserted",
        audience: { kind: "host" },
        payload: {
          artifact: {
            schemaVersion: 2,
            artifactId: "artifact-lifecycle-keeper-note",
            revision: 1,
            kind: "note",
            title: "Keeper prep",
            description: "",
            body: keeperCanary,
            attachments: [],
            audience: { kind: "host" },
            locked: true,
            archived: false,
            extensions: {},
          },
        },
      });

      // 3. Publish player-safe snapshots derived from the module's own entities.
      const moduleScene = modulePackage.scenes[0];
      const moduleLocation = modulePackage.locations[0];
      const moduleNpc = modulePackage.npcs[0];
      const moduleClue = modulePackage.clues[0];
      if (!moduleScene || !moduleLocation || !moduleNpc || !moduleClue) {
        throw new Error("module must provide at least one scene, location, npc and clue");
      }
      let idCounter = 0;
      const createId = () => `lifecycle-${(idCounter += 1).toString().padStart(3, "0")}`;
      const scene = {
        schemaVersion: 2 as const,
        entityId: createId(),
        revision: 1,
        kind: "scene" as const,
        name: moduleScene.name,
        description: moduleScene.synopsis || moduleScene.name,
        artifactIds: [],
        audience: roomAudience,
        data: {
          sourceRef: {
            moduleId: modulePackage.moduleId,
            revision: modulePackage.revision,
            kind: "scene" as const,
            id: moduleScene.id,
          },
        },
        extensions: {},
      };
      await host.submitConfirmed({ type: "entity.upserted", audience: roomAudience, payload: { entity: scene } });
      await host.submitConfirmed({ type: "scene.focused", audience: roomAudience, payload: { sceneEntityId: scene.entityId } });
      const location = buildPublishedModuleEntityV2(host.world.entities, modulePackage, {
        kind: "location",
        sourceId: moduleLocation.id,
        name: moduleLocation.name,
        description: moduleLocation.playerDescription || moduleLocation.name,
        audience: roomAudience,
      }, createId);
      await host.submitConfirmed({ type: "entity.upserted", audience: roomAudience, payload: { entity: location } });
      const npc = buildPublishedModuleEntityV2(host.world.entities, modulePackage, {
        kind: "npc",
        sourceId: moduleNpc.id,
        name: moduleNpc.name,
        description: moduleNpc.playerDescription || moduleNpc.name,
        audience: roomAudience,
      }, createId);
      await host.submitConfirmed({ type: "entity.upserted", audience: roomAudience, payload: { entity: npc } });

      // 4. Players bring in investigators; Alice's can be a real AI draft.
      const aliceCharacter = loadAliceCharacter(aliceInvitation.seatId);
      const bobCharacter = fallbackCharacter(bobInvitation.seatId, "character-lifecycle-bob", "Bob Chen", "Lifecycle Bob", "Emergency physician");
      await alice.submitConfirmed({ type: "character.updated", audience: roomAudience, payload: { character: aliceCharacter } });
      await bob.submitConfirmed({ type: "character.updated", audience: roomAudience, payload: { character: bobCharacter } });

      // 5. Roleplay: narration and in-character voices flow through room chat.
      await host.submitConfirmed({
        type: "chat.message",
        audience: roomAudience,
        payload: { message: `【KP】${scene.name}：${scene.description}`, format: "plain" },
      });
      await alice.submitConfirmed({
        type: "chat.message",
        audience: roomAudience,
        payload: { message: `${aliceCharacter.name}压低帽檐：“这地方比档案里写的还要安静。”`, format: "plain" },
      });
      await bob.submitConfirmed({
        type: "chat.message",
        audience: roomAudience,
        payload: { message: `${bobCharacter.name}检查了随身药箱，点了点头。`, format: "plain" },
      });

      // 6. The keeper stages the scene board; Alice moves her own token.
      await host.submitConfirmed({
        type: "board.created",
        audience: roomAudience,
        payload: {
          board: {
            schemaVersion: 1,
            boardId: "board-lifecycle-stage",
            revision: 1,
            kind: "scene",
            name: `${scene.name} 现场`,
            description: "Lifecycle scene stage",
            audience: roomAudience,
            logicalSize: { width: 1600, height: 900 },
            archived: false,
            items: [],
            edges: [],
            extensions: {},
          },
        },
      });
      await host.submitConfirmed({
        type: "board.item.upserted",
        audience: roomAudience,
        payload: {
          boardId: "board-lifecycle-stage",
          boardRevision: 2,
          item: {
            schemaVersion: 1,
            itemId: "item-lifecycle-npc",
            reference: { kind: "entity", entityId: npc.entityId },
            label: npc.name,
            position: { x: 1100, y: 420 },
            size: { width: 140, height: 140 },
            rotationDegrees: 0,
            scale: 1,
            zIndex: 0,
            locked: false,
            audience: roomAudience,
            extensions: {},
          },
        },
      });
      const aliceTokenEntity = {
        schemaVersion: 2 as const,
        entityId: "entity-lifecycle-alice",
        revision: 1,
        kind: "character" as const,
        name: aliceCharacter.name,
        description: "",
        artifactIds: [],
        audience: roomAudience,
        data: { ownerSeatId: aliceInvitation.seatId, characterId: aliceCharacter.id },
        extensions: {},
      };
      await host.submitConfirmed({ type: "entity.upserted", audience: roomAudience, payload: { entity: aliceTokenEntity } });
      await host.submitConfirmed({
        type: "board.item.upserted",
        audience: roomAudience,
        payload: {
          boardId: "board-lifecycle-stage",
          boardRevision: 3,
          item: tokenItem("item-lifecycle-alice", aliceTokenEntity.entityId, aliceCharacter.name, { x: 220, y: 700 }),
        },
      });
      await waitUntil(
        () => alice?.world.boards.get("board-lifecycle-stage")?.items.length === 2,
        errors,
        "stage board did not reach Alice",
      );
      const boardRevision = alice.world.boards.get("board-lifecycle-stage")?.revision;
      if (boardRevision === undefined) throw new Error("missing board revision");
      await alice.submitConfirmed({
        type: "board.item.upserted",
        audience: roomAudience,
        payload: {
          boardId: "board-lifecycle-stage",
          boardRevision: boardRevision + 1,
          item: tokenItem("item-lifecycle-alice", aliceTokenEntity.entityId, aliceCharacter.name, { x: 860, y: 430 }),
        },
      });
      await waitUntil(
        () => {
          const item = host.world.boards.get("board-lifecycle-stage")?.items.find(({ itemId }) => itemId === "item-lifecycle-alice");
          return item?.position.x === 860 && item.position.y === 430;
        },
        errors,
        "Alice's token movement was not sequenced by the host",
      );

      // 7. Intent -> ruling -> secure percentile roll, retried across fumbles.
      const aliceSkill = aliceCharacter.skills[0];
      const skillName = aliceSkill?.name ?? "Listen";
      let successfulRoll = false;
      for (let attempt = 1; attempt <= 4 && !successfulRoll; attempt += 1) {
        const requestId = `check-lifecycle-${attempt}`;
        await alice.submitConfirmed({
          type: "check.requested",
          audience: roomAudience,
          payload: {
            requestId,
            characterId: aliceCharacter.id,
            characterName: aliceCharacter.name,
            skillName,
            proposedTarget: 100,
            reason: "查看讲台后是否藏着什么东西。",
          },
        });
        await host.submitConfirmed({
          type: "check.authorized",
          audience: roomAudience,
          payload: {
            requestId,
            target: 100,
            requiredDifficulty: "regular",
            bonusDice: 1,
            penaltyDice: 0,
            note: `允许：${skillName}，奖励骰一枚。`,
          },
        });
        await alice.rollDice({
          expression: "1d100",
          reason: `${skillName}检定`,
          bonusDice: 1,
          penaltyDice: 0,
          target: 100,
          requiredDifficulty: "regular",
          checkRequestId: requestId,
        });
        await waitUntil(
          () => host.world.checkAuthorizations.get(requestId)?.resolvedByEventId !== undefined,
          errors,
          `check ${attempt} was not resolved`,
        );
        const roll = (await hostRepository.listEventViewsV2(created.roomId)).find((view) => (
          view.view === "full"
          && view.event.type === "dice.result"
          && view.event.payload.checkRequestId === requestId
        ));
        if (roll?.view === "full" && roll.event.type === "dice.result") {
          const result = roll.event.payload.result;
          successfulRoll = result.kind === "percentile" && result.check?.success === true;
        }
      }
      expect(successfulRoll).toBe(true);

      // 8. The clue published from the module reaches everyone and is claimed.
      const clue = buildPublishedModuleArtifactV2(host.world.artifacts, modulePackage, {
        kind: "clue",
        sourceId: moduleClue.id,
        title: moduleClue.name,
        body: moduleClue.revealText || moduleClue.name,
        audience: roomAudience,
      }, createId);
      await host.submitConfirmed({ type: "artifact.upserted", audience: roomAudience, payload: { artifact: clue } });
      await waitUntil(
        () => alice?.world.artifacts.has(clue.artifactId) === true && bob?.world.artifacts.has(clue.artifactId) === true,
        errors,
        "clue did not reach both players",
      );
      await alice.submitConfirmed({
        type: "clue.claimed",
        audience: roomAudience,
        payload: { artifactId: clue.artifactId, characterId: aliceCharacter.id, characterName: aliceCharacter.name },
      });

      // 9. NPC panel conversation: player speaks, keeper answers as the NPC.
      const npcSession = {
        schemaVersion: 1 as const,
        sessionId: "npc-session-lifecycle",
        revision: 1,
        npcEntityId: npc.entityId,
        title: `与${npc.name}交谈`,
        description: "Lifecycle NPC conversation",
        status: "active" as const,
        audience: roomAudience,
        provider: "codex" as const,
        model: "",
        autoReply: false,
        mode: "shadow" as const,
        pinnedContext: [],
        startedAt: new Date().toISOString(),
        extensions: {},
      };
      await host.submitConfirmed({ type: "npc.session.upserted", audience: roomAudience, payload: { session: npcSession } });
      await alice.submitConfirmed({
        type: "npc.session.message",
        audience: roomAudience,
        payload: {
          sessionId: npcSession.sessionId,
          messageId: "10000000-0000-4000-8000-000000000001",
          role: "human",
          speakerSeatId: aliceInvitation.seatId,
          spokenText: "教堂晚上还有人来吗？",
        },
      });
      const npcReplyText = "老人摇头：“天黑之后，只有风琴自己在响。”";
      await host.submitConfirmed({
        type: "npc.session.message",
        audience: roomAudience,
        payload: {
          sessionId: npcSession.sessionId,
          messageId: "10000000-0000-4000-8000-000000000002",
          role: "npc",
          spokenText: npcReplyText,
        },
      });
      await host.submitConfirmed({
        type: "npc.session.upserted",
        audience: roomAudience,
        payload: {
          session: {
            ...npcSession,
            revision: 2,
            status: "closed" as const,
            endedAt: new Date().toISOString(),
          },
        },
      });

      // 10. The keeper closes the session; every seat settles on one sequence.
      await host.submitConfirmed({
        type: "chat.message",
        audience: roomAudience,
        payload: { message: "【KP】本次调查到此结束，感谢各位。", format: "plain" },
      });
      const finalSequence = host.lastContiguousSequence;
      await waitUntil(
        () => [host, alice, bob].every((session) => session?.lastContiguousSequence === finalSequence),
        errors,
        "sessions did not settle on the final sequence",
      );

      // 11. Transcript export: the shared record survives, the secret does not.
      const hostViews = await hostRepository.listEventViewsV2(created.roomId);
      const aliceViews = await aliceRepository.listEventViewsV2(created.roomId);
      const hostTranscript = exportEventsV2ToMarkdown(hostViews, { seatName: "Lifecycle Keeper" });
      const aliceTranscript = exportEventsV2ToMarkdown(aliceViews, { seatName: "Lifecycle Alice" });
      for (const transcript of [hostTranscript, aliceTranscript]) {
        expect(transcript).toContain(modulePackage.metadata.title);
        expect(transcript).toContain(scene.name);
        expect(transcript).toContain(clue.title);
        expect(transcript).toContain(npcReplyText);
        expect(transcript).toContain("本次调查到此结束");
      }
      expect(hostTranscript).toContain(keeperCanary);
      expect(aliceTranscript).not.toContain(keeperCanary);
      expect(JSON.stringify(aliceViews)).not.toContain(keeperCanary);
      expect(aliceViews.some((view) => view.view === "redacted")).toBe(true);

      // 12. Both player histories match the host on every shared event.
      const bobViews = await bobRepository.listEventViewsV2(created.roomId);
      for (const hostView of hostViews) {
        if (hostView.view !== "full") continue;
        if (hostView.event.audience.kind === "host") continue;
        const sequence = hostView.event.sequence;
        expect(aliceViews.find((view) => viewSequence(view) === sequence)).toEqual(hostView);
        expect(bobViews.find((view) => viewSequence(view) === sequence)).toEqual(hostView);
      }
      expect(errors).toEqual([]);
    } finally {
      bob?.stop();
      alice?.stop();
      host.stop();
    }
  }, 120_000);
});

function loadModule(): ModulePackageV1 {
  if (modulePath) {
    return modulePackageSchema.parse(JSON.parse(readFileSync(modulePath, "utf8")));
  }
  const now = "2026-08-30T00:00:00.000Z";
  return modulePackageSchema.parse({
    schemaVersion: 1,
    moduleId: "module-lifecycle-fallback",
    revision: 1,
    metadata: {
      title: "教堂里的低语",
      authors: ["Lifecycle"],
      language: "zh-CN",
      summary: "A fallback lifecycle module.",
      createdAt: now,
      updatedAt: now,
    },
    overview: "",
    sourceDocuments: [],
    chapters: [],
    scenes: [{
      id: "scene-chapel",
      name: "空荡的礼拜堂",
      description: "KP only: the organ hides a passage.",
      synopsis: "黄昏的礼拜堂里只有风琴声。",
      locationIds: ["location-chapel"],
      npcIds: ["npc-sexton"],
      clueIds: ["clue-organ-score"],
      handoutIds: [],
      suggestedCheckIds: [],
      keeperNotes: "",
      sourceRefs: [],
    }],
    locations: [{
      id: "location-chapel",
      name: "老礼拜堂",
      description: "KP only location prose.",
      playerDescription: "彩窗把最后的日光染成暗红。",
      aliases: [],
      sourceRefs: [],
    }],
    npcs: [{
      id: "npc-sexton",
      name: "看堂人华伯",
      description: "KP only npc prose.",
      playerDescription: "一位不愿直视风琴的老人。",
      role: "看堂人",
      motivation: "",
      traits: [],
      sourceRefs: [],
    }],
    clues: [{
      id: "clue-organ-score",
      name: "风琴乐谱",
      description: "KP only clue meaning.",
      revealText: "乐谱边缘写着一行小字：倒着演奏。",
      isCore: true,
      sourceRefs: [],
    }],
    handouts: [],
    suggestedChecks: [],
    keeperNotes: [],
    relations: [],
    extensions: {},
  });
}

function loadAliceCharacter(ownerSeatId: string): Coc7Character {
  const base = fallbackCharacter(ownerSeatId, "character-lifecycle-alice", "林晚秋", "Lifecycle Alice", "记者");
  if (!characterPath) return base;
  const raw = JSON.parse(readFileSync(characterPath, "utf8")) as Record<string, unknown>;
  const draft = (raw.character ?? raw) as Record<string, unknown>;
  return {
    ...base,
    name: typeof draft.name === "string" && draft.name ? draft.name : base.name,
    occupation: typeof draft.occupation === "string" && draft.occupation ? draft.occupation : base.occupation,
    age: typeof draft.age === "number" ? draft.age : base.age,
    characteristics: isCharacteristics(draft.characteristics) ? draft.characteristics : base.characteristics,
    skills: Array.isArray(draft.skills) && draft.skills.length > 0
      ? draft.skills.filter(isSkill).slice(0, 200)
      : base.skills,
  };
}

function isCharacteristics(value: unknown): value is Coc7Character["characteristics"] {
  if (typeof value !== "object" || value === null) return false;
  return ["str", "con", "siz", "dex", "app", "int", "pow", "edu", "luck"].every((key) => {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0 && candidate <= 100;
  });
}

function isSkill(value: unknown): value is Coc7Character["skills"][number] {
  if (typeof value !== "object" || value === null) return false;
  const skill = value as Record<string, unknown>;
  return typeof skill.id === "string" && typeof skill.name === "string"
    && typeof skill.baseValue === "number" && typeof skill.value === "number"
    && typeof skill.checked === "boolean";
}

function tokenItem(itemId: string, entityId: string, label: string, position: { x: number; y: number }) {
  return {
    schemaVersion: 1 as const,
    itemId,
    reference: { kind: "entity" as const, entityId },
    label,
    position,
    size: { width: 120, height: 120 },
    rotationDegrees: 0,
    scale: 1,
    zIndex: 1,
    locked: false,
    audience: { kind: "room" as const },
    extensions: { roomRole: "investigator-token" },
  };
}

async function createRelayRoom(origin: string, hostPeerId: string): Promise<CreatedRelayRoom> {
  const response = await fetch(`${origin}/v1/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostPeerId }),
  });
  if (!response.ok) throw new Error(`relay room creation failed with HTTP ${response.status}`);
  return await response.json() as CreatedRelayRoom;
}

function createSession(room: RoomRecord, displayName: string, repository: MemoryRepository): RoomSessionV2 {
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
  const now = new Date().toISOString();
  return {
    id: created.roomId,
    name: "Lifecycle Live Room",
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
  const now = new Date().toISOString();
  return {
    id: invitation.roomId,
    name: "Lifecycle Live Room",
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
  return { peerId: room.localPeerId, displayName, role: room.localRole };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  errors: string[],
  timeoutMessage: string,
  timeoutMs = 15_000,
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

function fallbackCharacter(
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
    residence: "上海",
    birthplace: "苏州",
    characteristics: { str: 50, con: 55, siz: 50, dex: 60, app: 55, int: 70, pow: 60, edu: 70, luck: 55 },
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
    skills: [{ id: "skill-listen", name: "聆听", baseValue: 20, value: 70, checked: false }],
    status: { temporaryInsanity: false, indefiniteInsanity: false, majorWound: false, dying: false, unconscious: false },
    inventory: [],
    background: {
      personalDescription: "带着旧笔记本的细心观察者。",
      ideologyAndBeliefs: "证据高于一切。",
      significantPeople: "一位信任的同事",
      meaningfulLocations: "城市档案馆",
      treasuredPossessions: "一支钢笔",
      traits: "耐心而有条理",
      injuriesAndScars: "",
      phobiasAndManias: "",
      arcaneTomesSpellsAndArtifacts: "",
      encountersWithStrangeEntities: "",
    },
    notes: "",
    updatedAt: new Date().toISOString(),
    extensions: {},
  };
}
