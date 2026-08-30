// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Coc7Character, ModulePackageV1, RoomEventV1 } from "@coc-room/protocol";
import { getRepository, type RoomRecord } from "../data/repository";
import type { RoomSession } from "../network/RoomSession";
import { useAppStore } from "../store/app-store";
import { downloadTextInBrowser } from "../lib/browser-download";
import { RoomView } from "./RoomView";

vi.mock("../lib/browser-download", () => ({ downloadTextInBrowser: vi.fn() }));

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
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.mocked(downloadTextInBrowser).mockReset();
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
    expect(screen.getByRole("button", { name: "导出文字记录" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "导出网页记录" })).toBeTruthy();
    expect(screen.getByText(/筛选只改变这里显示的内容；导出始终包含/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/事件 #|已同步副本|中继节点/);
    expect(screen.queryByPlaceholderText("说点什么……")).toBeNull();
    expect(screen.queryByRole("heading", { name: "骰子与检定" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "在线成员" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "返回大厅" }));
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("searches and filters records without silently narrowing the exported backup", async () => {
    const checkEvent: RoomEventV1 = {
      ...event,
      eventId: "00000000-0000-4000-8000-000000000002",
      sequence: 2,
      type: "dice.result",
      payload: {
        reason: "检查庭院窗框",
        result: {
          kind: "standard",
          expression: "1d6",
          count: 1,
          sides: 6,
          rolls: [4],
          modifier: 0,
          total: 4,
        },
      },
    };
    const clueEvent: RoomEventV1 = {
      ...event,
      eventId: "00000000-0000-4000-8000-000000000003",
      sequence: 3,
      type: "content.revealed",
      payload: {
        moduleId: "module-butterfly",
        revision: 1,
        contentId: "clue-ticket",
        contentType: "clue",
        title: "沾血的票根",
        body: "票根背面写着一个日期。",
      },
    };
    useAppStore.setState({ events: [event, checkEvent, clueEvent] });
    render(<RoomView readOnly onLeave={() => undefined} />);

    fireEvent.change(screen.getByLabelText("记录类型"), { target: { value: "checks" } });
    expect(screen.getByText("检查庭院窗框")).toBeTruthy();
    expect(screen.queryByText("蝶影掠过庭院。")).toBeNull();
    expect(screen.queryByText("沾血的票根")).toBeNull();
    expect(screen.getByText("找到 1 条，共 3 条")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "导出文字记录" }));
    await waitFor(() => expect(downloadTextInBrowser).toHaveBeenCalledOnce());
    const exported = vi.mocked(downloadTextInBrowser).mock.calls[0]?.[1] ?? "";
    expect(exported).toContain("蝶影掠过庭院");
    expect(exported).toContain("检查庭院窗框");
    expect(exported).toContain("沾血的票根");
    expect(screen.getByRole("status").textContent).toContain("文字记录已开始下载");

    fireEvent.change(screen.getByLabelText("记录类型"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("搜索记录"), { target: { value: "票根" } });
    expect(screen.getByText("沾血的票根")).toBeTruthy();
    expect(screen.queryByText("检查庭院窗框")).toBeNull();

    fireEvent.change(screen.getByLabelText("搜索记录"), { target: { value: "不存在的内容" } });
    expect(screen.getByText("没有找到符合条件的记录。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByText("蝶影掠过庭院。")).toBeTruthy();
    expect((screen.getByLabelText("搜索记录") as HTMLInputElement).value).toBe("");
  });

  it("keeps a failed export recoverable and never suggests that records were lost", async () => {
    vi.mocked(downloadTextInBrowser).mockImplementationOnce(() => {
      throw new Error("disk writer unavailable");
    });
    render(<RoomView readOnly onLeave={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "导出网页记录" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("导出没有完成，记录仍安全保存在本机");
    expect(alert.textContent).toContain("请重试，或改用另一种格式");
    expect((screen.getByText("查看失败原因").closest("details") as HTMLDetailsElement).open).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "重试导出" }));
    await waitFor(() => expect(downloadTextInBrowser).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("网页记录已开始下载。")).toBeTruthy();
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
    const enterButton = screen.getByRole("button", { name: "林若岚前往观止剧场" });
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
    expect(screen.getAllByText(/正在等待 KP 确认/).length).toBeGreaterThan(0);
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
    fireEvent.click(screen.getByRole("button", { name: "向所有玩家展示这个地点" }));
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
    expect(screen.queryByRole("button", { name: "向所有玩家展示这个地点" })).toBeNull();
    expect(await screen.findByText(/找不到《精确修订 B》正在使用的版本/)).toBeTruthy();
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
    expect(screen.getByText("困难成功 · 目标值 60 · 本次要求：困难（通过）")).toBeTruthy();
  });

  it("pauses player commands while the host is absent but keeps records exportable", () => {
    useAppStore.setState({ participants: [player, host], paths: { [room.hostPeerId]: "offline" } });
    const submit = vi.fn(async (_type: string, _payload: unknown) => undefined);
    const session = { participant: player, isHost: false, submit } as unknown as RoomSession;
    render(<RoomView session={session} onLeave={() => undefined} />);

    expect(screen.getByRole("status").textContent).toContain("KP 暂时离线，本局已暂停");
    expect(screen.getByText(/等待 KP 回来/)).toBeTruthy();
    expect((screen.getByPlaceholderText("等 KP 回来后继续发言……") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "发送消息" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "掷骰并记录" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("骰式") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "导出文字记录" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "导出网页记录" })).toBeTruthy();
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
    expect(screen.getByText(/KP 视角/)).toBeTruthy();
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
