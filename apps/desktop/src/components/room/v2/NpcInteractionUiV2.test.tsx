// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  type Coc7Character,
  type NpcSessionMessageV2,
  type RoomEntityV2,
  type SeatV2,
} from "@coc-room/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NpcSessionStartDialogV2,
  npcPanelSpeakerLabelV2,
  npcSessionAudienceLabelV2,
} from "./NpcInteractionUiV2";

const HOST: SeatV2 = { seatId: "seat-host", role: "host", displayName: "守秘人", extensions: {} };
const ALICE: SeatV2 = { seatId: "seat-alice", role: "player", displayName: "小林", peerId: "peer-alice", extensions: {} };
const BOB: SeatV2 = { seatId: "seat-bob", role: "player", displayName: "阿岚", extensions: {} };

afterEach(cleanup);

describe("NpcSessionStartDialogV2", () => {
  it("requires an explicit legal recipient choice before creating a targeted panel", () => {
    const onConfirm = vi.fn();
    render(<NpcSessionStartDialogV2
      npc={npc({ kind: "room" })}
      seats={[HOST, ALICE, BOB]}
      onCancel={vi.fn()}
      onConfirm={onConfirm}
    />);

    expect(screen.getByRole("dialog", { name: "开始与 守门人 交谈" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "NPC 交谈可见范围摘要" }).textContent).toContain("房间所有人");

    fireEvent.click(screen.getByRole("radio", { name: /定向交谈/ }));
    const create = screen.getByRole("button", { name: "创建定向交谈" });
    expect((create as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("邀请 小林 加入交谈"));
    expect(screen.getByRole("status", { name: "NPC 交谈可见范围摘要" }).textContent).toContain("仅 KP、小林");
    fireEvent.click(create);

    expect(onConfirm).toHaveBeenCalledWith({ kind: "seats", seatIds: [ALICE.seatId] });
  });

  it("never offers a seat or public mode broader than the NPC audience", () => {
    const onConfirm = vi.fn();
    render(<NpcSessionStartDialogV2
      npc={npc({ kind: "seats", seatIds: [ALICE.seatId] })}
      seats={[HOST, ALICE, BOB]}
      onCancel={vi.fn()}
      onConfirm={onConfirm}
    />);

    expect((screen.getByRole("radio", { name: /房间公开交谈/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByLabelText("邀请 小林 加入交谈")).toBeTruthy();
    expect(screen.queryByLabelText("邀请 阿岚 加入交谈")).toBeNull();
    expect(within(screen.getByRole("dialog")).getByText(/不能从这里建立公开交谈/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "创建定向交谈" }));
    expect(onConfirm).toHaveBeenCalledWith({ kind: "seats", seatIds: [ALICE.seatId] });
  });
});

describe("NPC panel human labels", () => {
  it("uses a unique room character and the captured stable seat name", () => {
    const characters = new Map<string, Coc7Character>([["character-lin", character("character-lin", "林默", ALICE.seatId)]]);
    const message = humanMessage({ speakerDisplayName: "小林" });

    expect(npcPanelSpeakerLabelV2(message, "守门人", [HOST], characters)).toBe("林默（小林）");
    expect(npcSessionAudienceLabelV2({ kind: "seats", seatIds: [ALICE.seatId] }, [HOST, ALICE])).toBe("仅 KP、小林可见");
  });

  it("falls back to the captured seat name when a seat has multiple or no characters", () => {
    const characters = new Map<string, Coc7Character>([
      ["character-one", character("character-one", "角色甲", ALICE.seatId)],
      ["character-two", character("character-two", "角色乙", ALICE.seatId)],
    ]);

    expect(npcPanelSpeakerLabelV2(humanMessage({ speakerDisplayName: "小林" }), "守门人", [], characters)).toBe("小林");
    expect(npcPanelSpeakerLabelV2({ ...humanMessage({ speakerSeatId: BOB.seatId }), speakerDisplayName: "阿岚" }, "守门人", [], new Map())).toBe("阿岚");
  });
});

function npc(audience: RoomEntityV2["audience"]): RoomEntityV2 {
  return {
    schemaVersion: 2,
    entityId: "npc-doorkeeper",
    revision: 1,
    kind: "npc",
    name: "守门人",
    description: "脸色苍白的剧院守门人。",
    audience,
    artifactIds: [],
    data: {},
    extensions: {},
  };
}

function humanMessage(overrides: Partial<NpcSessionMessageV2> = {}): NpcSessionMessageV2 {
  return {
    sessionId: "npc-session-one",
    messageId: "00000000-0000-4000-8000-000000000001",
    role: "human",
    speakerSeatId: ALICE.seatId,
    spokenText: "昨晚是谁关的后门？",
    occurredAt: "2026-08-30T10:00:00.000Z",
    ...overrides,
  };
}

function character(id: string, name: string, ownerPeerId: string): Coc7Character {
  return {
    schemaVersion: 1,
    id,
    ownerPeerId,
    name,
    playerName: "玩家",
    occupation: "记者",
    age: 30,
    residence: "",
    birthplace: "",
    characteristics: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 50 },
    derived: { hitPoints: 10, maxHitPoints: 10, magicPoints: 10, maxMagicPoints: 10, sanity: 50, maxSanity: 99, movementRate: 8, build: 0, damageBonus: "0" },
    skills: [],
    status: { temporaryInsanity: false, indefiniteInsanity: false, majorWound: false, dying: false, unconscious: false },
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
