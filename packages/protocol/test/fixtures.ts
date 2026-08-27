import type { Coc7Character, RoomEventV1 } from "../src";

export const HOST = {
  peerId: "host-1",
  displayName: "守秘人",
  role: "host" as const,
};

export const PLAYER = {
  peerId: "player-1",
  displayName: "调查员",
  role: "player" as const,
};

export const CHARACTER: Coc7Character = {
  schemaVersion: 1,
  id: "investigator-1",
  ownerPeerId: PLAYER.peerId,
  name: "林若岚",
  playerName: PLAYER.displayName,
  occupation: "记者",
  age: 28,
  residence: "上海",
  birthplace: "杭州",
  characteristics: {
    str: 50,
    con: 55,
    siz: 60,
    dex: 65,
    app: 60,
    int: 75,
    pow: 70,
    edu: 80,
    luck: 55,
  },
  derived: {
    hitPoints: 11,
    maxHitPoints: 11,
    magicPoints: 14,
    maxMagicPoints: 14,
    sanity: 70,
    maxSanity: 99,
    movementRate: 8,
    build: 0,
    damageBonus: "0",
  },
  skills: [
    {
      id: "skill-library-use",
      name: "图书馆使用",
      baseValue: 20,
      value: 70,
      checked: false,
    },
  ],
  status: {
    temporaryInsanity: false,
    indefiniteInsanity: false,
    majorWound: false,
    dying: false,
    unconscious: false,
  },
  inventory: [
    {
      id: "item-notebook",
      name: "笔记本",
      quantity: 1,
      description: "一本旧笔记本",
      equipped: true,
    },
  ],
  background: {
    personalDescription: "总是戴着一顶旧呢帽。",
    ideologyAndBeliefs: "真相值得付出代价。",
    significantPeople: "编辑周先生",
    meaningfulLocations: "旧报社",
    treasuredPossessions: "父亲的钢笔",
    traits: "冷静",
    injuriesAndScars: "",
    phobiasAndManias: "",
    arcaneTomesSpellsAndArtifacts: "",
    encountersWithStrangeEntities: "",
  },
  notes: "",
  updatedAt: "2026-08-27T10:00:00.000Z",
  extensions: {},
};

export function chatEvent(sequence: number, message = `消息 ${sequence}`): RoomEventV1 {
  return {
    protocolVersion: 1,
    roomId: "room-1",
    eventId: `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    sequence,
    sender: PLAYER,
    occurredAt: `2026-08-27T10:00:${sequence.toString().padStart(2, "0")}.000Z`,
    type: "chat.message",
    payload: { message, format: "plain" },
  };
}
