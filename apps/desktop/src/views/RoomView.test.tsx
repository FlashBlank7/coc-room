// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Coc7Character, ModulePackageV1, RoomEventV1 } from "@coc-room/protocol";
import { getRepository, type RoomRecord } from "../data/repository";
import type { RoomSession } from "../network/RoomSession";
import { useAppStore } from "../store/app-store";
import { RoomView } from "./RoomView";

const room: RoomRecord = {
  id: "room-local",
  name: "见世之蝶",
  localRole: "player",
  localPeerId: "player-local",
  hostPeerId: "host-peer",
  inviteToken: "saved-token",
  relayUrl: "ws://127.0.0.1:8787/v1/rooms/room-local/ws",
  lastSeq: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const host = { peerId: room.hostPeerId, displayName: "守秘人", role: "host" as const };
const player = { peerId: room.localPeerId, displayName: "调查员", role: "player" as const };

const event: RoomEventV1 = {
  protocolVersion: 1,
  roomId: room.id,
  eventId: "00000000-0000-4000-8000-000000000001",
  sequence: 1,
  sender: { peerId: "host-peer", displayName: "守秘人", role: "host" },
  type: "chat.message",
  occurredAt: "2026-01-01T01:02:03.000Z",
  payload: { message: "蝶影掠过庭院。", format: "plain" },
};

beforeEach(() => {
  useAppStore.setState({
    activeView: "room",
    currentRoom: room,
    events: [event],
    participants: [player, host],
    paths: {},
    connectionError: undefined,
  });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().leaveRoom();
});

describe("RoomView", () => {
  it("renders local records as an explicitly read-only, exportable view", () => {
    const onLeave = vi.fn();
    render(<RoomView readOnly onLeave={onLeave} />);

    expect(screen.getByText("蝶影掠过庭院。")).toBeTruthy();
    expect(screen.getAllByText(/本地记录（只读）/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Markdown" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "HTML" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("说点什么……")).toBeNull();
    expect(screen.queryByRole("heading", { name: "骰子与检定" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "在线成员" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "返回大厅" }));
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("submits the selected check difficulty only when a target is present", async () => {
    const submit = vi.fn(async (_type: string, _payload: unknown) => undefined);
    const session = { submit } as unknown as RoomSession;
    render(<RoomView session={session} onLeave={() => undefined} />);

    const difficulty = screen.getByRole("combobox", { name: "成功难度" });
    expect((difficulty as HTMLSelectElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("目标值（可选）"), { target: { value: "60" } });
    fireEvent.change(difficulty, { target: { value: "hard" } });
    fireEvent.click(screen.getByRole("button", { name: "掷骰并记录" }));

    await waitFor(() => expect(submit).toHaveBeenCalledWith("dice.roll", expect.objectContaining({
      target: 60,
      requiredDifficulty: "hard",
    })));

    submit.mockClear();
    fireEvent.change(screen.getByLabelText("目标值（可选）"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "掷骰并记录" }));

    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const payload = submit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("target");
    expect(payload).not.toHaveProperty("requiredDifficulty");
  });

  it("validates dice locally and never sends percentile-only options with a normal dice expression", async () => {
    const submit = vi.fn(async (_type: string, _payload: unknown) => undefined);
    const session = { submit } as unknown as RoomSession;
    render(<RoomView session={session} onLeave={() => undefined} />);

    fireEvent.change(screen.getByLabelText("奖励骰"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("目标值（可选）"), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText("骰式"), { target: { value: "2d6+1" } });

    expect((screen.getByLabelText("奖励骰") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("惩罚骰") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("目标值（可选）") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "掷骰并记录" }));

    await waitFor(() => expect(submit).toHaveBeenCalledWith("dice.roll", {
      expression: "2d6+1",
      reason: "",
      bonusDice: 0,
      penaltyDice: 0,
    }));

    submit.mockClear();
    fireEvent.change(screen.getByLabelText("骰式"), { target: { value: "不是骰式" } });
    fireEvent.click(screen.getByRole("button", { name: "掷骰并记录" }));

    await waitFor(() => expect(screen.getAllByText(/骰式无效/).length).toBeGreaterThan(0));
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not submit chat while a Chinese input method is composing", async () => {
    const submit = vi.fn(async (_type: string, _payload: unknown) => undefined);
    const session = { submit } as unknown as RoomSession;
    render(<RoomView session={session} onLeave={() => undefined} />);

    const input = screen.getByPlaceholderText("说点什么……");
    fireEvent.change(input, { target: { value: "调查" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(submit).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", isComposing: false });
    await waitFor(() => expect(submit).toHaveBeenCalledWith("chat.send", {
      message: "调查",
      format: "plain",
    }));
  });

  it("projects public room-world events and lets a player enter with their own character", async () => {
    const character = createCharacter("character-lin", room.localPeerId, "林若岚");
    useAppStore.setState({
      events: [
        {
          ...event,
          eventId: "00000000-0000-4000-8000-000000000011",
          sequence: 1,
          type: "module.switched",
          payload: { moduleId: "module-butterfly", revision: 3, title: "见世之蝶" },
        },
        {
          ...event,
          eventId: "00000000-0000-4000-8000-000000000012",
          sequence: 2,
          sender: player,
          type: "character.updated",
          payload: { character },
        },
        {
          ...event,
          eventId: "00000000-0000-4000-8000-000000000013",
          sequence: 3,
          type: "location.published",
          payload: {
            moduleId: "module-butterfly",
            revision: 3,
            location: { id: "location-theater", name: "观止剧场", description: "灯光落在空荡的舞台上。" },
          },
        },
        {
          ...event,
          eventId: "00000000-0000-4000-8000-000000000014",
          sequence: 4,
          type: "npc.published",
          payload: {
            moduleId: "module-butterfly",
            revision: 3,
            locationId: "location-theater",
            locationName: "观止剧场",
            npc: { id: "npc-hana", name: "花小路", description: "一位神色谨慎的演员。" },
          },
        },
        {
          ...event,
          eventId: "00000000-0000-4000-8000-000000000015",
          sequence: 5,
          type: "content.revealed",
          payload: {
            moduleId: "module-butterfly",
            revision: 3,
            contentId: "clue-ticket",
            contentType: "clue",
            title: "沾血的票根",
            body: "日期被墨水涂掉了。",
            locationId: "location-theater",
          },
        },
      ],
    });
    const submit = vi.fn(async (_type: string, _payload: unknown) => undefined);
    const session = { submit } as unknown as RoomSession;

    render(<RoomView session={session} onLeave={() => undefined} />);

    expect(screen.getByRole("heading", { name: "观止剧场" })).toBeTruthy();
    expect(screen.getAllByText("灯光落在空荡的舞台上。").length).toBeGreaterThan(0);
    expect(screen.getAllByText("花小路").length).toBeGreaterThan(0);
    expect(screen.getAllByText("沾血的票根").length).toBeGreaterThan(0);
    const enterButton = screen.getByRole("button", { name: "让 林若岚 进入此地" });
    fireEvent.click(enterButton);
    fireEvent.click(enterButton);

    await waitFor(() => expect(submit).toHaveBeenCalledWith("location.enter", {
      moduleId: "module-butterfly",
      revision: 3,
      locationId: "location-theater",
      locationName: "观止剧场",
      characterId: "character-lin",
      characterName: "林若岚",
    }, expect.any(String)));
    expect(submit).toHaveBeenCalledOnce();
    expect((enterButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/正在等待房主确认/).length).toBeGreaterThan(0);
  });

  it("never renders a stale keeper module under a newly active revision", async () => {
    const modulePackage = createKeeperModule();
    const repository = await getRepository();
    if (await repository.getModule(modulePackage.moduleId, modulePackage.revision) === undefined) {
      await repository.saveModule({ package: modulePackage, sourceText: "fixture" });
    }
    const hostRoom: RoomRecord = {
      ...room,
      localRole: "host",
      localPeerId: room.hostPeerId,
      joinToken: "player-join-token",
    };
    const firstSwitch: RoomEventV1 = {
      ...event,
      eventId: "00000000-0000-4000-8000-000000000021",
      sequence: 1,
      type: "module.switched",
      payload: {
        moduleId: modulePackage.moduleId,
        revision: modulePackage.revision,
        title: modulePackage.metadata.title,
      },
    };
    useAppStore.setState({ currentRoom: hostRoom, participants: [host], paths: {}, events: [firstSwitch] });
    const submit = vi.fn(async (_type: string, _payload: unknown) => undefined);
    const session = { participant: host, isHost: true, submit } as unknown as RoomSession;

    render(<RoomView session={session} onLeave={() => undefined} />);

    expect(await screen.findByRole("heading", { name: "精确修订 A" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "向全房间公开地点" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("location.publish", {
      moduleId: "module-exact-a",
      revision: 1,
      location: {
        id: "location-exact-a",
        name: "旧书房",
        description: "玩家看到一间落满灰尘的书房。",
      },
    }, expect.any(String)));
    submit.mockClear();

    await act(async () => {
      useAppStore.setState({
        events: [
          firstSwitch,
          {
            ...event,
            eventId: "00000000-0000-4000-8000-000000000022",
            sequence: 2,
            type: "module.switched",
            payload: { moduleId: "module-exact-b", revision: 2, title: "精确修订 B" },
          },
        ],
      });
    });

    expect(screen.queryByRole("heading", { name: "精确修订 A" })).toBeNull();
    expect(screen.queryByRole("button", { name: "向全房间公开地点" })).toBeNull();
    expect(await screen.findByText(/找不到活动版本 module-exact-b v2/)).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows percentile candidates and translated CoC check results in the room log", () => {
    useAppStore.setState({
      events: [{
        ...event,
        type: "dice.result",
        payload: {
          reason: "侦查庭院",
          result: {
            kind: "percentile",
            expression: "1d100",
            bonusDice: 1,
            penaltyDice: 0,
            unitsDie: 5,
            tensDice: [7, 2],
            candidates: [75, 25],
            total: 25,
            check: {
              roll: 25,
              target: 60,
              requiredDifficulty: "hard",
              outcome: "hard",
              success: true,
              thresholds: { regular: 60, hard: 30, extreme: 12 },
            },
          },
        },
      }],
    });

    render(<RoomView readOnly onLeave={() => undefined} />);

    expect(screen.getByText("1 个奖励骰 · 候选 75、25")).toBeTruthy();
    expect(screen.getByText("困难成功 · 目标 60 · 困难难度成功")).toBeTruthy();
  });

  it("pauses player commands while the host is absent but keeps records exportable", () => {
    useAppStore.setState({ participants: [player, host], paths: { [room.hostPeerId]: "offline" } });
    const submit = vi.fn(async (_type: string, _payload: unknown) => undefined);
    const session = { participant: player, isHost: false, submit } as unknown as RoomSession;
    render(<RoomView session={session} onLeave={() => undefined} />);

    expect(screen.getByRole("status").textContent).toContain("房主已离线，房间暂停");
    expect(screen.getByText(/房主离线 · 房间已暂停/)).toBeTruthy();
    expect((screen.getByPlaceholderText("等待房主回来……") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "发送消息" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "掷骰并记录" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("骰式") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Markdown" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "HTML" })).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not pause the host when its own presence snapshot is empty", () => {
    const hostRoom: RoomRecord = {
      ...room,
      localRole: "host",
      localPeerId: room.hostPeerId,
      joinToken: "player-join-token",
    };
    useAppStore.setState({ currentRoom: hostRoom, participants: [], paths: {} });
    const session = { participant: host, isHost: true, submit: vi.fn() } as unknown as RoomSession;
    render(<RoomView session={session} onLeave={() => undefined} />);

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(/房主权威源/)).toBeTruthy();
    expect((screen.getByPlaceholderText("说点什么……") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "掷骰并记录" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

function createCharacter(id: string, ownerPeerId: string, name: string): Coc7Character {
  return {
    schemaVersion: 1,
    id,
    ownerPeerId,
    name,
    playerName: "调查员",
    occupation: "记者",
    age: 28,
    residence: "东京",
    birthplace: "上海",
    characteristics: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 60, pow: 60, edu: 60, luck: 50 },
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
    updatedAt: "2026-01-01T00:00:00.000Z",
    extensions: {},
  };
}

function createKeeperModule(): ModulePackageV1 {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    moduleId: "module-exact-a",
    revision: 1,
    metadata: {
      title: "精确修订 A",
      authors: [],
      language: "zh-CN",
      summary: "竞态测试模组",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    overview: "",
    sourceDocuments: [],
    chapters: [],
    scenes: [],
    locations: [{
      id: "location-exact-a",
      name: "旧书房",
      description: "KP 知道书架后有暗门。",
      playerDescription: "玩家看到一间落满灰尘的书房。",
      aliases: [],
      sourceRefs: [],
    }],
    npcs: [],
    clues: [],
    handouts: [],
    suggestedChecks: [],
    keeperNotes: [],
    relations: [],
    extensions: {},
  };
}
