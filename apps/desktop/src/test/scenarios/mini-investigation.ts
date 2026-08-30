import {
  createRoomWorldStateV2,
  reduceRoomWorldStateV2,
  roomEventV2Schema,
  type Coc7Character,
  type ModulePackageV1,
  type RoomEventProposalV2,
  type RoomWorldStateV2,
  type SeatV2,
} from "@coc-room/protocol";

import type { RoomRecord } from "../../data/repository";

export const miniInvestigation = {
  roomId: "room-mini-investigation",
  publicOpening: "雨水敲打剧院后门，门缝里传来断续的唱针摩擦声。",
  intendedAction: "我贴近唱片机，检查底座有没有被拆开过的痕迹。",
  publicClueText: "曲目必须从终幕向序曲倒放。",
  secrets: {
    sceneSynopsis: "KP 秘密：唱片机会在午夜召来幕后幽灵。",
    keeperNotes: "keeperNotes：不要在玩家进入前提到幽灵。",
    clueMeaning: "KP 秘密：倒放曲序其实是封印仪式。",
  },
} as const;

export const miniHostSeat: SeatV2 = {
  seatId: "seat-host",
  role: "host",
  displayName: "KP",
  peerId: "peer-host",
  extensions: {},
};

export const miniPlayerSeat: SeatV2 = {
  seatId: "seat-player",
  role: "player",
  displayName: "玩家",
  peerId: "peer-player",
  extensions: {},
};

export const miniInvestigator: Coc7Character = {
  schemaVersion: 1,
  id: "character-reporter",
  ownerPeerId: miniPlayerSeat.seatId,
  name: "林默",
  playerName: miniPlayerSeat.displayName,
  occupation: "调查记者",
  age: 29,
  residence: "东京",
  birthplace: "横滨",
  characteristics: {
    str: 45,
    con: 55,
    siz: 50,
    dex: 60,
    app: 55,
    int: 70,
    pow: 60,
    edu: 65,
    luck: 50,
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
  skills: [
    { id: "skill-spot", name: "侦查", baseValue: 25, value: 60, checked: false },
    { id: "skill-library", name: "图书馆使用", baseValue: 20, value: 50, checked: false },
  ],
  inventory: [],
  status: {
    temporaryInsanity: false,
    indefiniteInsanity: false,
    majorWound: false,
    dying: false,
    unconscious: false,
  },
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
  updatedAt: "2026-08-29T00:00:00.000Z",
  extensions: {},
};

export const miniModule: ModulePackageV1 = {
  schemaVersion: 1,
  moduleId: "module-terminal-opus",
  revision: 1,
  metadata: {
    title: "通往天国的终幕曲",
    authors: [],
    language: "zh-CN",
    summary: "一段可在无地图模式下完成的微型调查。",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  },
  overview: "",
  sourceDocuments: [],
  chapters: [],
  scenes: [
    {
      id: "scene-record-room",
      name: "后台唱片室",
      description: miniInvestigation.secrets.sceneSynopsis,
      synopsis: miniInvestigation.secrets.sceneSynopsis,
      locationIds: [],
      npcIds: [],
      clueIds: ["clue-reversed-score"],
      handoutIds: [],
      suggestedCheckIds: [],
      keeperNotes: miniInvestigation.secrets.keeperNotes,
      sourceRefs: [],
    },
  ],
  locations: [],
  npcs: [],
  clues: [
    {
      id: "clue-reversed-score",
      name: "倒放的曲序",
      description: miniInvestigation.secrets.clueMeaning,
      revealText: miniInvestigation.publicClueText,
      isCore: true,
      sourceRefs: [],
    },
  ],
  handouts: [],
  suggestedChecks: [],
  keeperNotes: [],
  relations: [],
  extensions: {},
};

export function createMiniInvestigationWorld(): RoomWorldStateV2 {
  return createRoomWorldStateV2(miniInvestigation.roomId);
}

/**
 * Turns the proposal emitted by a rendered UI into the next authoritative
 * projection. This keeps segmented task tests on the real protocol reducer
 * without pretending that jsdom is a two-browser networking E2E harness.
 */
export function commitMiniInvestigationProposal(
  world: RoomWorldStateV2,
  sender: SeatV2,
  proposal: RoomEventProposalV2,
): RoomWorldStateV2 {
  const sequence = world.lastSequence + 1;
  const event = roomEventV2Schema.parse({
    protocolVersion: 2,
    roomId: miniInvestigation.roomId,
    eventId: crypto.randomUUID(),
    sequence,
    sender,
    occurredAt: new Date(Date.UTC(2026, 7, 29, 0, 0, sequence)).toISOString(),
    ...proposal,
  });
  return reduceRoomWorldStateV2(world, event);
}

export function miniRoomRecord(role: "host" | "player"): RoomRecord {
  const localSeat = role === "host" ? miniHostSeat : miniPlayerSeat;
  return {
    id: miniInvestigation.roomId,
    name: "终幕曲调查",
    localRole: role,
    localPeerId: localSeat.peerId!,
    hostPeerId: miniHostSeat.peerId!,
    inviteToken: "development-invite-token",
    relayUrl: "ws://127.0.0.1:8787",
    lastSeq: 0,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    protocolVersion: 2,
    localSeatId: localSeat.seatId,
    hostSeatId: miniHostSeat.seatId,
    seatCredentialVersion: 1,
  };
}
