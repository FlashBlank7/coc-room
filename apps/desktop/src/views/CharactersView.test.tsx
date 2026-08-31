// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRoomWorldStateV2,
  coc7CharacterSchema,
  type Coc7Character,
  type ParticipantV1,
  type RoomEventV1,
} from "@coc-room/protocol";
import { getRepository, type RoomRecord } from "../data/repository";
import { deriveCoc7Stats } from "../lib/character-derivation";
import { createCoccharPackage, parseCoccharPackage } from "../lib/cocchar-package";
import type { RoomSession } from "../network/RoomSession";
import { RoomSessionV2 } from "../network/RoomSessionV2";
import { useAppStore } from "../store/app-store";
import { CharactersView } from "./CharactersView";

const imageMocks = vi.hoisted(() => ({
  generateDraft: vi.fn(),
}));

vi.mock("../lib/codex-image-executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/codex-image-executor")>();
  return {
    ...actual,
    codexImageExecutor: {
      generateDraft: imageMocks.generateDraft,
      cancel: vi.fn(),
      probeCapabilities: vi.fn(),
    },
  };
});

const playerRoom = createRoom("player", "player-local");
const hostPresence: ParticipantV1 = { peerId: playerRoom.hostPeerId, displayName: "Keeper", role: "host" };

beforeEach(async () => {
  window.sessionStorage.clear();
  await clearPersonalCharacterLibrary();
  useAppStore.setState({
    activeView: "characters",
    currentRoom: playerRoom,
    events: [],
    participants: [hostPresence],
    paths: {},
    connectionError: undefined,
  });
});

afterEach(async () => {
  cleanup();
  window.sessionStorage.clear();
  useAppStore.getState().leaveRoom();
  vi.restoreAllMocks();
  await clearPersonalCharacterLibrary();
});

describe("CharactersView permissions and editing", () => {
  it("shows one human next step instead of presenting the whole sheet as equally urgent", () => {
    const { session } = createSession("player", "player-local", "Alice");
    render(<CharactersView session={session} />);

    fireEvent.click(screen.getByRole("button", { name: "新建我的角色" }));
    const progress = screen.getByLabelText("角色创建进度");
    expect(progress.textContent).toContain("先写姓名与职业");
    expect(screen.getByRole("link", { name: "继续填写" }).getAttribute("href")).toBe("#character-identity");

    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "林蝶" } });
    fireEvent.change(screen.getByLabelText("职业"), { target: { value: "记者" } });
    expect(progress.textContent).toContain("添加常用技能");

    fireEvent.click(screen.getByRole("button", { name: "添加其他技能" }));
    fireEvent.change(screen.getByLabelText("技能名"), { target: { value: "图书馆使用" } });
    fireEvent.change(screen.getByLabelText("当前值"), { target: { value: "60" } });
    expect(progress.textContent).toContain("可以带入房间");
    expect(screen.getByRole("link", { name: "去带入房间" }).getAttribute("href")).toBe("#character-save-actions");
  });

  it("adds a practical investigation skill starter set in one action", () => {
    const { session } = createSession("player", "player-local", "Alice");
    render(<CharactersView session={session} />);

    fireEvent.click(screen.getByRole("button", { name: "新建我的角色" }));
    fireEvent.click(screen.getByRole("button", { name: "加入常见调查技能" }));

    const names = screen.getAllByLabelText("技能名").map((field) => (field as HTMLInputElement).value);
    expect(names).toEqual(["侦查", "聆听", "图书馆使用", "心理学", "说服", "潜行", "闪避", "斗殴", "急救"]);
    expect((screen.getAllByLabelText("当前值")[6] as HTMLInputElement).value).toBe("25");
  });

  it("lets a player build and submit a complete own character with live derived values", async () => {
    const { session, submit } = createSession("player", "player-local", "Alice");
    render(<CharactersView session={session} />);

    fireEvent.click(screen.getByRole("button", { name: "新建我的角色" }));
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "林蝶" } });
    fireEvent.change(screen.getByLabelText("玩家"), { target: { value: "Alice" } });
    fireEvent.change(screen.getByLabelText("职业"), { target: { value: "记者" } });
    fireEvent.change(screen.getByLabelText(/^年龄/), { target: { value: "42" } });
    fireEvent.change(screen.getByLabelText("居住地"), { target: { value: "东京" } });
    fireEvent.change(screen.getByLabelText("出生地"), { target: { value: "横滨" } });

    expect(derivedValue("最大 HP")).toContain("10");
    fireEvent.change(screen.getByLabelText(/^体质 CON/), { target: { value: "80" } });
    expect(derivedValue("最大 HP")).toContain("13");
    fireEvent.change(screen.getByLabelText(/^当前生命 HP/), { target: { value: "12" } });

    fireEvent.click(screen.getByRole("button", { name: "添加其他技能" }));
    fireEvent.change(screen.getByLabelText("技能名"), { target: { value: "克苏鲁神话" } });
    fireEvent.change(screen.getByLabelText("基础值"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("当前值"), { target: { value: "20" } });
    fireEvent.click(screen.getByLabelText("成长标记"));
    expect(derivedValue("最大 SAN")).toContain("79");

    fireEvent.click(screen.getByText("伤势与精神状态"));
    fireEvent.click(screen.getByLabelText("重伤"));
    fireEvent.click(screen.getByText("物品与装备"));
    fireEvent.click(screen.getByRole("button", { name: "添加物品" }));
    fireEvent.change(screen.getByLabelText("物品名"), { target: { value: "折叠相机" } });
    fireEvent.change(screen.getByLabelText("数量"), { target: { value: "2" } });
    fireEvent.click(screen.getByLabelText("已装备"));
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "装有一卷未冲洗的胶片。" } });
    fireEvent.click(screen.getByText("人物背景（可稍后补）"));
    fireEvent.change(screen.getByLabelText("个人描述"), { target: { value: "总穿着深色风衣。" } });
    fireEvent.click(screen.getByText("调查笔记"));
    fireEvent.change(screen.getByLabelText("自由记录"), { target: { value: "在庭院里见过蝶影。" } });

    fireEvent.click(screen.getByRole("button", { name: "带入并回到现场" }));

    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const [commandType, commandPayload] = submit.mock.calls[0]!;
    expect(commandType).toBe("character.update");
    const character = (commandPayload as { character: Coc7Character }).character;
    expect(coc7CharacterSchema.parse(character)).toEqual(character);
    expect(character).toMatchObject({
      ownerPeerId: "player-local",
      name: "林蝶",
      playerName: "Alice",
      occupation: "记者",
      age: 42,
      residence: "东京",
      birthplace: "横滨",
      characteristics: { con: 80 },
      derived: { hitPoints: 12, maxHitPoints: 13, maxSanity: 79, movementRate: 7 },
      status: { majorWound: true },
      background: { personalDescription: "总穿着深色风衣。" },
      notes: "在庭院里见过蝶影。",
    });
    expect(character.skills[0]).toMatchObject({ name: "克苏鲁神话", baseValue: 5, value: 20, checked: true });
    expect(character.inventory[0]).toMatchObject({ name: "折叠相机", quantity: 2, equipped: true });
  });

  it("waits for the room to accept a first character, then returns the player to the scene", async () => {
    const v2Room: RoomRecord = {
      ...createRoom("player", "player-v2"),
      id: "character-room-v2",
      protocolVersion: 2,
      localSeatId: "seat-player-v2",
      hostSeatId: "seat-host-v2",
      seatCredentialVersion: 1,
    };
    useAppStore.setState({ currentRoom: v2Room, activeView: "characters" });
    const session = new RoomSessionV2({
      room: v2Room,
      displayName: "Alice",
      repository: {} as never,
      transport: {} as never,
    });
    const submitConfirmed = vi.spyOn(session, "submitConfirmed").mockResolvedValue("character-command");
    render(<CharactersView session={session} worldV2={createRoomWorldStateV2(v2Room.id)} />);

    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "林蝶" } });
    fireEvent.change(screen.getByLabelText("职业"), { target: { value: "记者" } });
    fireEvent.click(screen.getByRole("button", { name: "加入常见调查技能" }));
    fireEvent.click(screen.getByRole("button", { name: "带入并回到现场" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledOnce());
    await waitFor(() => expect(useAppStore.getState().activeView).toBe("room"));
    expect(submitConfirmed).toHaveBeenCalledWith(expect.objectContaining({ type: "character.updated" }));
  });

  it("selects the most recently used local investigator in a new room and keeps that handoff after remount", async () => {
    const repository = await getRepository();
    const older = createReadyCharacter("personal-older", "seat-from-another-room", "旧日调查员", "Alice");
    const recent = createReadyCharacter("personal-recent", "seat-from-another-room", "林蝶", "Alice");
    await repository.savePersonalCharacterV2({
      characterId: older.id,
      revision: 1,
      character: older,
      privateNotes: "旧角色的笔记",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    await repository.savePersonalCharacterV2({
      characterId: recent.id,
      revision: 1,
      character: recent,
      privateNotes: "庭院里的蝶影只留给自己",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    const { session, submit } = createSession("player", "player-local", "Alice");

    const firstVisit = render(<CharactersView session={session} />);
    await waitFor(() => expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("林蝶"));
    expect(screen.getByLabelText("角色创建进度").textContent).toContain("可以带入房间");
    expect(submit).not.toHaveBeenCalled();

    firstVisit.unmount();
    render(<CharactersView session={session} />);
    await waitFor(() => expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("林蝶"));
    fireEvent.click(screen.getByText("只给自己看的笔记"));
    expect((screen.getByLabelText("仅自己可见") as HTMLTextAreaElement).value).toBe("庭院里的蝶影只留给自己");
    fireEvent.change(screen.getByLabelText("居住地"), { target: { value: "东京" } });
    expect((screen.getByRole("button", { name: "保存到我的角色库" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "带入并回到现场" }));

    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await waitFor(() => expect(useAppStore.getState().activeView).toBe("room"));
    const published = (submit.mock.calls[0]![1] as { character: Coc7Character }).character;
    expect(published.name).toBe("林蝶");
    expect(published.ownerPeerId).toBe("player-local");
    expect(JSON.stringify(published)).not.toContain("庭院里的蝶影只留给自己");
  });

  it("offers an explicit local-only recovery after remount and clears it after the character enters the room", async () => {
    const { session, submit } = createSession("player", "player-local", "Alice");
    const firstVisit = render(<CharactersView session={session} />);

    fireEvent.click(screen.getByRole("button", { name: "新建我的角色" }));
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "未完成的林蝶" } });
    fireEvent.change(screen.getByLabelText("职业"), { target: { value: "记者" } });
    fireEvent.click(screen.getByRole("button", { name: "加入常见调查技能" }));
    fireEvent.click(screen.getByText("只给自己看的笔记"));
    fireEvent.change(screen.getByLabelText("仅自己可见"), { target: { value: "这段恢复内容绝不能进入房间事件" } });

    await waitFor(() => expect(window.sessionStorage.length).toBe(1));
    expect(await (await getRepository()).listPersonalCharactersV2()).toHaveLength(0);
    firstVisit.unmount();

    render(<CharactersView session={session} />);
    expect(screen.getByLabelText("发现未保存的角色草稿").textContent).toContain("未完成的林蝶");
    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("新调查员");
    expect((screen.getByLabelText("姓名") as HTMLInputElement).disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("未完成的林蝶");
    expect((screen.getByLabelText("仅自己可见") as HTMLTextAreaElement).value).toBe("这段恢复内容绝不能进入房间事件");
    expect(await (await getRepository()).listPersonalCharactersV2()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "带入并回到现场" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await waitFor(() => expect(window.sessionStorage.length).toBe(0));
    const published = (submit.mock.calls[0]![1] as { character: Coc7Character }).character;
    expect(published.name).toBe("未完成的林蝶");
    expect(JSON.stringify(published)).not.toContain("这段恢复内容绝不能进入房间事件");
  });

  it("keeps a new personal character editable and recoverable without a current room, then saves only to the personal library", async () => {
    useAppStore.setState({
      currentRoom: undefined,
      events: [],
      participants: [],
      paths: {},
      activeView: "characters",
    });
    const { session, submit } = createSession("player", "detached-player", "Alice");
    const firstVisit = render(<CharactersView session={session} />);

    fireEvent.click(screen.getByRole("button", { name: "新建我的角色" }));
    const name = screen.getByLabelText("姓名") as HTMLInputElement;
    expect(name.disabled).toBe(false);
    fireEvent.change(name, { target: { value: "离线角色草稿" } });
    fireEvent.change(screen.getByLabelText("职业"), { target: { value: "古书店员" } });
    fireEvent.click(screen.getByText("只给自己看的笔记"));
    fireEvent.change(screen.getByLabelText("仅自己可见"), { target: { value: "只保存在本机的秘密" } });

    await waitFor(() => expect(window.sessionStorage.length).toBe(1));
    const recoveryKey = window.sessionStorage.key(0)!;
    expect(readStoredCharacterDraft(recoveryKey)).toMatchObject({
      scope: "personal",
      privateNotes: "只保存在本机的秘密",
      character: { name: "离线角色草稿" },
    });
    firstVisit.unmount();

    render(<CharactersView session={session} />);
    expect(screen.getByLabelText("发现未保存的角色草稿").textContent).toContain("离线角色草稿");
    fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("离线角色草稿");
    expect(screen.queryByRole("button", { name: /带入.*房间|更新当前房间角色卡/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "保存到我的角色库" }));

    const repository = await getRepository();
    await waitFor(async () => expect(await repository.listPersonalCharactersV2()).toHaveLength(1));
    const [saved] = await repository.listPersonalCharactersV2();
    expect(saved).toMatchObject({
      privateNotes: "只保存在本机的秘密",
      character: { name: "离线角色草稿" },
    });
    expect(window.sessionStorage.getItem(recoveryKey)).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it("locks editing, character changes, creation, and navigation while a personal-library save is pending", async () => {
    const own = createCharacter("pending-personal-own", "player-local", "保存前的名字", "Alice");
    const other = createCharacter("pending-personal-other", "other-player", "可切换的角色", "Bob");
    useAppStore.setState({ events: [characterEvent(own, 1), characterEvent(other, 2)] });
    const repository = await getRepository();
    const pendingSave = createDeferred<void>();
    const persistPersonal = repository.savePersonalCharacterV2.bind(repository);
    const savePersonal = vi.spyOn(repository, "savePersonalCharacterV2").mockImplementationOnce(async (record) => {
      await pendingSave.promise;
      await persistPersonal(record);
    });
    const { session } = createSession("player", "player-local", "Alice");
    render(<CharactersView session={session} />);

    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "等待保存的完整内容" } });
    fireEvent.click(screen.getByRole("button", { name: "保存到我的角色库" }));
    await waitFor(() => expect(savePersonal).toHaveBeenCalledOnce());

    expect((screen.getByLabelText("姓名") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /可切换的角色/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "新建我的角色" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "回到现场" }) as HTMLButtonElement).disabled).toBe(true);
    useAppStore.getState().setActiveView("room");
    expect(useAppStore.getState().activeView).toBe("characters");

    pendingSave.resolve();
    await waitFor(() => expect((screen.getByLabelText("姓名") as HTMLInputElement).disabled).toBe(false));
    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("等待保存的完整内容");
    expect(useAppStore.getState().activeView).toBe("characters");
  });

  it("locks the whole draft while room confirmation is pending and preserves it after confirmation resolves", async () => {
    const other = createCharacter("pending-room-other", "other-player", "旁观调查员", "Bob");
    useAppStore.setState({ events: [characterEvent(other, 1)] });
    const pendingConfirmation = createDeferred<void>();
    const { session, submit } = createSession(
      "player",
      "player-local",
      "Alice",
      () => pendingConfirmation.promise,
    );
    render(<CharactersView session={session} />);

    fireEvent.click(screen.getByRole("button", { name: "新建我的角色" }));
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "等待房间确认的林蝶" } });
    fireEvent.change(screen.getByLabelText("职业"), { target: { value: "记者" } });
    fireEvent.click(screen.getByRole("button", { name: "加入常见调查技能" }));
    fireEvent.click(screen.getByText("只给自己看的笔记"));
    fireEvent.change(screen.getByLabelText("仅自己可见"), { target: { value: "确认期间也不能消失" } });
    fireEvent.click(screen.getByRole("button", { name: "带入并回到现场" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());

    expect((screen.getByLabelText("姓名") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /旁观调查员/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "新建我的角色" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "回到现场" }) as HTMLButtonElement).disabled).toBe(true);
    useAppStore.getState().setActiveView("room");
    expect(useAppStore.getState().activeView).toBe("characters");

    pendingConfirmation.resolve();
    await waitFor(() => expect(useAppStore.getState().activeView).toBe("room"));
    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("等待房间确认的林蝶");
    expect((screen.getByLabelText("仅自己可见") as HTMLTextAreaElement).value).toBe("确认期间也不能消失");
    const [saved] = await (await getRepository()).listPersonalCharactersV2();
    expect(saved).toMatchObject({
      privateNotes: "确认期间也不能消失",
      character: { name: "等待房间确认的林蝶" },
    });
  });

  it("keeps the draft and its recovery checkpoint when room confirmation rejects", async () => {
    const pendingConfirmation = createDeferred<void>();
    const { session, submit } = createSession(
      "player",
      "player-local",
      "Alice",
      () => pendingConfirmation.promise,
    );
    const visit = render(<CharactersView session={session} />);

    fireEvent.click(screen.getByRole("button", { name: "新建我的角色" }));
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "不能因拒绝而丢失" } });
    fireEvent.change(screen.getByLabelText("职业"), { target: { value: "记者" } });
    fireEvent.click(screen.getByRole("button", { name: "加入常见调查技能" }));
    fireEvent.click(screen.getByText("只给自己看的笔记"));
    fireEvent.change(screen.getByLabelText("仅自己可见"), { target: { value: "拒绝后仍可恢复" } });
    fireEvent.click(screen.getByRole("button", { name: "带入并回到现场" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());

    pendingConfirmation.reject(new Error("房间拒绝了这张角色卡"));
    await waitFor(() => expect(screen.getByText("房间拒绝了这张角色卡")).toBeTruthy());
    expect(useAppStore.getState().activeView).toBe("characters");
    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("不能因拒绝而丢失");
    expect((screen.getByLabelText("姓名") as HTMLInputElement).disabled).toBe(false);
    expect(window.sessionStorage.length).toBe(1);
    const recoveryKey = window.sessionStorage.key(0)!;
    expect(readStoredCharacterDraft(recoveryKey)).toMatchObject({
      privateNotes: "拒绝后仍可恢复",
      character: { name: "不能因拒绝而丢失" },
    });

    visit.unmount();
    render(<CharactersView session={session} />);
    expect(screen.getByLabelText("发现未保存的角色草稿").textContent).toContain("不能因拒绝而丢失");
    fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
    expect((screen.getByLabelText("仅自己可见") as HTMLTextAreaElement).value).toBe("拒绝后仍可恢复");
    expect(useAppStore.getState().activeView).toBe("characters");
  });

  it("does not overwrite a formal room character while the recovery decision is pending", async () => {
    const formal = createCharacter("formal-room-character", "player-local", "正式角色名", "Alice");
    useAppStore.setState({ events: [characterEvent(formal, 1)] });
    const { session } = createSession("player", "player-local", "Alice");
    const firstVisit = render(<CharactersView session={session} />);
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "尚未保存的临时名字" } });
    await waitFor(() => expect(window.sessionStorage.length).toBe(1));
    firstVisit.unmount();

    render(<CharactersView session={session} />);
    expect(screen.getByLabelText("发现未保存的角色草稿").textContent).toContain("尚未保存的临时名字");
    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("正式角色名");
    fireEvent.click(screen.getByRole("button", { name: "放弃草稿" }));
    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("正式角色名");
    expect(window.sessionStorage.length).toBe(0);
  });

  it("blocks a recovered room draft whose base version changed and lets the editor use the room latest instead", async () => {
    const original = createCharacter("versioned-room-character", "player-local", "恢复点里的名字", "Alice");
    useAppStore.setState({ events: [characterEvent(original, 1)] });
    const { session } = createSession("player", "player-local", "Alice");
    const firstVisit = render(<CharactersView session={session} />);

    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "尚未同步的旧草稿" } });
    await waitFor(() => expect(window.sessionStorage.length).toBe(1));
    const recoveryKey = window.sessionStorage.key(0)!;
    expect(readStoredCharacterDraft(recoveryKey).baseRoomUpdatedAt).toBe(original.updatedAt);
    firstVisit.unmount();

    const latest = coc7CharacterSchema.parse({
      ...original,
      name: "房间里的最新版",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    useAppStore.setState({ events: [characterEvent(latest, 2)] });
    render(<CharactersView session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));

    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("尚未同步的旧草稿");
    expect(screen.getByLabelText("角色草稿版本冲突").textContent).toContain("已经在草稿保存后更新");
    expect((screen.getByRole("button", { name: "更新并回到现场" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "改用房间最新版" }));
    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("房间里的最新版");
    expect(screen.queryByLabelText("角色草稿版本冲突")).toBeNull();
    fireEvent.change(screen.getByLabelText("居住地"), { target: { value: "最新版上的新修改" } });
    expect((screen.getByRole("button", { name: "更新并回到现场" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("discards invalid and oversized recovery values without touching the formal library", async () => {
    const { session } = createSession("player", "player-local", "Alice");
    const seed = render(<CharactersView session={session} />);
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "用于取得隔离键的草稿" } });
    await waitFor(() => expect(window.sessionStorage.length).toBe(1));
    const key = window.sessionStorage.key(0)!;
    seed.unmount();

    window.sessionStorage.setItem(key, "{not-json");
    const invalidVisit = render(<CharactersView session={session} />);
    expect(screen.queryByLabelText("发现未保存的角色草稿")).toBeNull();
    expect(window.sessionStorage.getItem(key)).toBeNull();
    invalidVisit.unmount();

    window.sessionStorage.setItem(key, "x".repeat(512 * 1024 + 1));
    render(<CharactersView session={session} />);
    expect(screen.queryByLabelText("发现未保存的角色草稿")).toBeNull();
    expect(window.sessionStorage.getItem(key)).toBeNull();
    expect(await (await getRepository()).listPersonalCharactersV2()).toHaveLength(0);
  });

  it("keeps an unfinished room draft isolated from another player seat until the original seat returns", async () => {
    const { session } = createSession("player", "player-local", "Alice");
    const originalVisit = render(<CharactersView session={session} />);
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "只属于 Alice 席位" } });
    await waitFor(() => expect(window.sessionStorage.length).toBe(1));
    const originalKey = window.sessionStorage.key(0)!;
    originalVisit.unmount();

    const otherRoom = { ...playerRoom, localPeerId: "player-bob" };
    useAppStore.setState({ currentRoom: otherRoom, activeView: "characters" });
    const { session: otherSession } = createSession("player", "player-bob", "Bob");
    const otherVisit = render(<CharactersView session={otherSession} />);
    expect(screen.queryByLabelText("发现未保存的角色草稿")).toBeNull();
    expect(window.sessionStorage.getItem(originalKey)).not.toBeNull();
    otherVisit.unmount();

    useAppStore.setState({ currentRoom: playerRoom, activeView: "characters" });
    render(<CharactersView session={session} />);
    expect(screen.getByLabelText("发现未保存的角色草稿").textContent).toContain("只属于 Alice 席位");
    expect(await (await getRepository()).listPersonalCharactersV2()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "放弃草稿" }));
    expect(window.sessionStorage.getItem(originalKey)).toBeNull();
    expect(screen.queryByLabelText("发现未保存的角色草稿")).toBeNull();
  });

  it("keeps recovery scopes isolated when one mounted view moves between rooms and returns", async () => {
    const firstRoom = { ...playerRoom, id: "mounted-room-a", localPeerId: "mounted-alice" };
    const secondRoom = { ...playerRoom, id: "mounted-room-b", localPeerId: "mounted-bob" };
    const { session: firstSession } = createSession("player", "mounted-alice", "Alice");
    const { session: secondSession } = createSession("player", "mounted-bob", "Bob");
    useAppStore.setState({ currentRoom: firstRoom, events: [], activeView: "characters" });
    const view = render(<CharactersView session={firstSession} />);

    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "A 房间尚未保存" } });
    await waitFor(() => expect(findStoredCharacterDraft("room:mounted-room-a:seat:mounted-alice")?.character.name).toBe("A 房间尚未保存"));

    act(() => {
      useAppStore.setState({ currentRoom: secondRoom, events: [], activeView: "characters" });
      view.rerender(<CharactersView session={secondSession} />);
    });
    await waitFor(() => expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("新调查员"));
    expect(findStoredCharacterDraft("room:mounted-room-b:seat:mounted-bob")).toBeUndefined();

    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "B 房间尚未保存" } });
    await waitFor(() => expect(findStoredCharacterDraft("room:mounted-room-b:seat:mounted-bob")?.character.name).toBe("B 房间尚未保存"));

    act(() => {
      useAppStore.setState({ currentRoom: firstRoom, events: [], activeView: "characters" });
      view.rerender(<CharactersView session={firstSession} />);
    });
    await waitFor(() => expect(screen.getByLabelText("发现未保存的角色草稿").textContent).toContain("A 房间尚未保存"));
    fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("A 房间尚未保存");
    expect(findStoredCharacterDraft("room:mounted-room-b:seat:mounted-bob")?.character.name).toBe("B 房间尚未保存");
  });

  it("does not leak a dirty draft into another seat scope when the mounted room id stays the same", async () => {
    const aliceRoom = { ...playerRoom, id: "shared-mounted-room", localPeerId: "seat-alice" };
    const bobRoom = { ...aliceRoom, localPeerId: "seat-bob" };
    const { session: aliceSession } = createSession("player", "seat-alice", "Alice");
    const { session: bobSession } = createSession("player", "seat-bob", "Bob");
    useAppStore.setState({ currentRoom: aliceRoom, events: [], activeView: "characters" });
    const view = render(<CharactersView session={aliceSession} />);

    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "只属于 Alice 的草稿" } });
    await waitFor(() => expect(findStoredCharacterDraft("room:shared-mounted-room:seat:seat-alice")?.character.name).toBe("只属于 Alice 的草稿"));

    act(() => {
      useAppStore.setState({ currentRoom: bobRoom, events: [], activeView: "characters" });
      view.rerender(<CharactersView session={bobSession} />);
    });
    await waitFor(() => expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("新调查员"));
    expect(findStoredCharacterDraft("room:shared-mounted-room:seat:seat-bob")).toBeUndefined();

    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "只属于 Bob 的草稿" } });
    await waitFor(() => expect(findStoredCharacterDraft("room:shared-mounted-room:seat:seat-bob")?.character.name).toBe("只属于 Bob 的草稿"));

    act(() => {
      useAppStore.setState({ currentRoom: aliceRoom, events: [], activeView: "characters" });
      view.rerender(<CharactersView session={aliceSession} />);
    });
    await waitFor(() => expect(screen.getByLabelText("发现未保存的角色草稿").textContent).toContain("只属于 Alice 的草稿"));
    fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("只属于 Alice 的草稿");
    expect(findStoredCharacterDraft("room:shared-mounted-room:seat:seat-bob")?.character.name).toBe("只属于 Bob 的草稿");
  });

  it("tells a returning player that their investigator is already live and offers one clear way back", () => {
    const own = createCharacter("own-live", "player-local", "林蝶", "Alice");
    useAppStore.setState({ events: [characterEvent(own, 1)] });
    const { session } = createSession("player", "player-local", "Alice");

    render(<CharactersView session={session} />);

    const progress = screen.getByLabelText("角色创建进度");
    expect(progress.textContent).toContain("调查员已经在现场");
    expect(progress.textContent).not.toContain("可以带入房间");
    expect(screen.getByRole("button", { name: "回到现场" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "继续跑团" }));
    expect(useAppStore.getState().activeView).toBe("room");
  });

  it("updates an in-room investigator and returns the player to play after the room accepts it", async () => {
    const own = createCharacter("own-update", "player-local", "林蝶", "Alice");
    useAppStore.setState({ events: [characterEvent(own, 1)] });
    const { session, submit } = createSession("player", "player-local", "Alice");

    render(<CharactersView session={session} />);
    fireEvent.change(screen.getByLabelText(/^当前生命 HP/), { target: { value: "8" } });

    expect(screen.getByLabelText("角色创建进度").textContent).toContain("保存这次角色修改");
    fireEvent.click(screen.getByRole("button", { name: "更新并回到现场" }));

    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await waitFor(() => expect(useAppStore.getState().activeView).toBe("room"));
    expect((submit.mock.calls[0]![1] as { character: Coc7Character }).character.derived.hitPoints).toBe(8);
  });

  it("keeps another player's character read-only for a player", () => {
    const own = createCharacter("own", "player-local", "我的调查员", "Alice");
    const other = createCharacter("other", "other-player", "他人调查员", "Bob");
    useAppStore.setState({ events: [characterEvent(own, 1), characterEvent(other, 2)] });
    const { session, submit } = createSession("player", "player-local", "Alice");
    render(<CharactersView session={session} />);

    fireEvent.click(screen.getByRole("button", { name: /他人调查员/ }));

    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("他人调查员");
    expect((screen.getByLabelText("姓名") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "添加其他技能" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "更新当前房间角色卡" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("只有角色所有者与主持人可以修改这张角色卡。")).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it("lets the host correct any player's character without changing ownership", async () => {
    const hostRoom = createRoom("host", "host-local");
    const other = createCharacter("other", "other-player", "待修正调查员", "Bob");
    useAppStore.setState({ currentRoom: hostRoom, events: [characterEvent(other, 1)] });
    const { session, submit } = createSession("host", "host-local", "Keeper");
    render(<CharactersView session={session} />);

    expect(screen.getByRole("region", { name: "我的角色库" })).toBeTruthy();
    const roomRoster = screen.getByRole("region", { name: "本房间调查员" });
    expect(roomRoster.textContent).toContain("待修正调查员");
    expect(roomRoster.textContent).toContain("玩家 Bob");
    fireEvent.click(screen.getByRole("button", { name: /待修正调查员/ }));
    const name = screen.getByLabelText("姓名") as HTMLInputElement;
    expect(name.disabled).toBe(false);
    fireEvent.change(name, { target: { value: "已修正调查员" } });
    fireEvent.click(screen.getByRole("button", { name: "更新当前房间角色卡" }));

    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const character = (submit.mock.calls[0]![1] as { character: Coc7Character }).character;
    expect(character.name).toBe("已修正调查员");
    expect(character.ownerPeerId).toBe("other-player");
  });

  it("recovers an unfinished host edit of another player's character without changing ownership", async () => {
    const hostRoom = createRoom("host", "host-local");
    const other = createCharacter("host-recovery-other", "other-player", "玩家原角色", "Bob");
    useAppStore.setState({ currentRoom: hostRoom, events: [characterEvent(other, 1)] });
    const { session, submit } = createSession("host", "host-local", "Keeper");
    const firstVisit = render(<CharactersView session={session} />);

    fireEvent.click(screen.getByRole("button", { name: /玩家原角色/ }));
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "KP 尚未保存的修正" } });
    await waitFor(() => expect(window.sessionStorage.length).toBe(1));
    expect(readStoredCharacterDraft(window.sessionStorage.key(0)!).character).toMatchObject({
      name: "KP 尚未保存的修正",
      ownerPeerId: "other-player",
    });
    firstVisit.unmount();

    render(<CharactersView session={session} />);
    expect(screen.getByLabelText("发现未保存的角色草稿").textContent).toContain("KP 尚未保存的修正");
    fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
    expect((screen.getByLabelText("姓名") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("KP 尚未保存的修正");

    fireEvent.click(screen.getByRole("button", { name: "更新当前房间角色卡" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const published = (submit.mock.calls[0]![1] as { character: Coc7Character }).character;
    expect(published).toMatchObject({ name: "KP 尚未保存的修正", ownerPeerId: "other-player" });
  });

  it("keeps personal drafting available while an offline room record cannot be updated", () => {
    useAppStore.setState({ participants: [], paths: {} });
    render(<CharactersView />);

    expect((screen.getByRole("button", { name: "新建我的角色" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("姓名") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "保存到我的角色库" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "带入当前房间" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("locks room publishing but not the personal draft while the host is offline", () => {
    useAppStore.setState({ participants: [] });
    const { session, submit } = createSession("player", "player-local", "Alice");
    render(<CharactersView session={session} />);

    expect((screen.getByRole("button", { name: "新建我的角色" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("姓名") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "带入并回到现场" }) as HTMLButtonElement).disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it("asks before switching characters or starting over and preserves the draft when cancelled", () => {
    const own = createCharacter("switch-own", "player-local", "原调查员", "Alice");
    const other = createCharacter("switch-other", "other-player", "另一位调查员", "Bob");
    useAppStore.setState({ events: [characterEvent(own, 1), characterEvent(other, 2)] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { session } = createSession("player", "player-local", "Alice");
    render(<CharactersView session={session} />);

    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "尚未保存的名字" } });
    fireEvent.click(screen.getByRole("button", { name: /另一位调查员/ }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("未保存的修改"));
    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("尚未保存的名字");

    fireEvent.click(screen.getByRole("button", { name: "新建我的角色" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("尚未保存的名字");

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /另一位调查员/ }));
    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("另一位调查员");
  });

  it("blocks in-app navigation and browser close while a character has unsaved changes", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { session } = createSession("player", "player-local", "Alice");
    render(<CharactersView session={session} />);

    fireEvent.click(screen.getByText("只给自己看的笔记"));
    fireEvent.change(screen.getByLabelText("仅自己可见"), { target: { value: "只改了私人笔记，也不能静默丢失" } });
    useAppStore.getState().setActiveView("room");

    expect(confirm).toHaveBeenCalledOnce();
    expect(useAppStore.getState().activeView).toBe("characters");
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    confirm.mockReturnValue(true);
    useAppStore.getState().setActiveView("room");
    expect(useAppStore.getState().activeView).toBe("room");
  });

  it("keeps local saving separate from bringing a character into the room", async () => {
    const { session, submit } = createSession("player", "player-local", "Alice");
    render(<CharactersView session={session} />);

    fireEvent.click(screen.getByRole("button", { name: "新建我的角色" }));
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "只存在本机的调查员" } });
    fireEvent.change(screen.getByLabelText("职业"), { target: { value: "古书店员" } });
    fireEvent.click(screen.getByRole("button", { name: "添加其他技能" }));
    fireEvent.change(screen.getByLabelText("技能名"), { target: { value: "图书馆使用" } });
    fireEvent.change(screen.getByLabelText("当前值"), { target: { value: "60" } });
    fireEvent.click(screen.getByText("只给自己看的笔记"));
    fireEvent.change(screen.getByLabelText("仅自己可见"), { target: { value: "不能公开的秘密" } });
    fireEvent.click(screen.getByRole("button", { name: "保存到我的角色库" }));

    await waitFor(() => expect((screen.getByRole("button", { name: "保存到我的角色库" }) as HTMLButtonElement).disabled).toBe(true));
    expect(window.sessionStorage.length).toBe(0);
    expect(submit).not.toHaveBeenCalled();

    expect((screen.getByRole("button", { name: "带入并回到现场" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "带入并回到现场" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const character = (submit.mock.calls[0]![1] as { character: Coc7Character }).character;
    expect(character.name).toBe("只存在本机的调查员");
    expect(JSON.stringify(character)).not.toContain("不能公开的秘密");
  });

  it("round-trips a cocchar created inside the browser realm", async () => {
    const character = createReadyCharacter("browser-cocchar", "player-local", "网页调查员", "Alice");
    const bytes = await createCoccharPackage({ character, privateNotes: "只留在本机" });

    const imported = await parseCoccharPackage(bytes);

    expect(imported.character).toEqual(character);
    expect(imported.privateNotes).toBe("只留在本机");
  });
});

describe("CharactersView AI draft review", () => {
  it("gives the KP approve and reject actions for a pending AI usage request", () => {
    const hostRoom: RoomRecord = {
      ...createRoom("host", "host-local"),
      id: "character-room-host",
      protocolVersion: 2,
      localSeatId: "seat-host-v2",
      hostSeatId: "seat-host-v2",
      seatCredentialVersion: 1,
    };
    useAppStore.setState({ currentRoom: hostRoom, activeView: "characters" });
    const session = new RoomSessionV2({
      room: hostRoom,
      displayName: "Keeper",
      repository: {} as never,
      transport: {} as never,
    });
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<CharactersView
      session={session}
      worldV2={createRoomWorldStateV2(hostRoom.id)}
      hostCharacterRequests={[{
        jobId: "job-review-0001",
        requesterSeatId: "seat-player-v2",
        requesterName: "Alice",
        playerName: "Alice",
        prompt: "1920 年代的图书馆管理员，擅长图书馆使用与聆听。",
      }]}
      onApproveHostCharacterRequest={onApprove}
      onRejectHostCharacterRequest={onReject}
    />);

    expect(screen.getByText(/结果直接交给玩家/)).toBeTruthy();
    expect(screen.getByText(/想生成：1920 年代的图书馆管理员/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "同意并开始生成" }));
    expect(onApprove).toHaveBeenCalledWith("job-review-0001");
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(onReject).toHaveBeenCalledWith("job-review-0001");
  });

  it("offers portrait generation only to the V2 keeper", () => {
    const hostRoom: RoomRecord = {
      ...createRoom("host", "host-local"),
      id: "character-room-portrait",
      protocolVersion: 2,
      localSeatId: "seat-host-v2",
      hostSeatId: "seat-host-v2",
      seatCredentialVersion: 1,
    };
    useAppStore.setState({ currentRoom: hostRoom, activeView: "characters" });
    const session = new RoomSessionV2({
      room: hostRoom,
      displayName: "Keeper",
      repository: {} as never,
      transport: {} as never,
    });
    render(<CharactersView session={session} worldV2={createRoomWorldStateV2(hostRoom.id)} />);
    fireEvent.click(screen.getByRole("button", { name: "新建我的角色" }));
    expect(screen.getByRole("button", { name: /按人设与当前模组生成人设图/ })).toBeTruthy();
    cleanup();

    const playerRoom2: RoomRecord = {
      ...createRoom("player", "player-v2"),
      id: "character-room-portrait-player",
      protocolVersion: 2,
      localSeatId: "seat-player-v2",
      hostSeatId: "seat-host-v2",
      seatCredentialVersion: 1,
    };
    useAppStore.setState({ currentRoom: playerRoom2, activeView: "characters" });
    const playerSession = new RoomSessionV2({
      room: playerRoom2,
      displayName: "Alice",
      repository: {} as never,
      transport: {} as never,
    });
    render(<CharactersView session={playerSession} worldV2={createRoomWorldStateV2(playerRoom2.id)} />);
    fireEvent.click(screen.getByRole("button", { name: "新建我的角色" }));
    expect(screen.queryByRole("button", { name: /按人设与当前模组生成人设图/ })).toBeNull();
  });

  it("lets the keeper pick a researched art style and sends its concept prompt", async () => {
    imageMocks.generateDraft.mockRejectedValue(new Error("测试到此为止"));
    const hostRoom: RoomRecord = {
      ...createRoom("host", "host-local"),
      id: "character-room-style",
      protocolVersion: 2,
      localSeatId: "seat-host-v2",
      hostSeatId: "seat-host-v2",
      seatCredentialVersion: 1,
    };
    useAppStore.setState({ currentRoom: hostRoom, activeView: "characters" });
    const session = new RoomSessionV2({
      room: hostRoom,
      displayName: "Keeper",
      repository: {} as never,
      transport: {} as never,
    });
    render(<CharactersView session={session} worldV2={createRoomWorldStateV2(hostRoom.id)} />);
    fireEvent.click(screen.getByRole("button", { name: "新建我的角色" }));

    // Every style is offered with its preview image; picking one surfaces its
    // concept set (概念集) and routes its researched prompt into the request.
    expect(screen.getAllByRole("radio")).toHaveLength(6);
    expect((screen.getByAltText("复古胶片画风预览") as HTMLImageElement).src).toContain("/portrait-styles/vintage-photo.webp");
    fireEvent.click(screen.getByRole("radio", { name: /日系动画/ }));
    expect(screen.getByText("赛璐璐平涂 cel shading")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /按人设与当前模组生成人设图/ }));
    await waitFor(() => expect(imageMocks.generateDraft).toHaveBeenCalledOnce());
    const request = imageMocks.generateDraft.mock.calls[0]![0] as { style?: string };
    expect(request.style).toContain("赛璐璐平涂");
    expect(request.style).toContain("硬边阴影");
    expect(await screen.findByText(/人设图生成失败：测试到此为止/)).toBeTruthy();
  });

  it("shows the live draft stage while waiting and surfaces a KP rejection", async () => {
    const v2Room: RoomRecord = {
      ...createRoom("player", "player-v2"),
      id: "character-room-v2",
      protocolVersion: 2,
      localSeatId: "seat-player-v2",
      hostSeatId: "seat-host-v2",
      seatCredentialVersion: 1,
    };
    useAppStore.setState({ currentRoom: v2Room, activeView: "characters" });
    const session = new RoomSessionV2({
      room: v2Room,
      displayName: "Alice",
      repository: {} as never,
      transport: {} as never,
    });
    const generation = createDeferred<Coc7Character>();
    const requestCharacterDraft = vi.fn(() => generation.promise);
    render(<CharactersView
      session={session}
      worldV2={createRoomWorldStateV2(v2Room.id)}
      requestCharacterDraft={requestCharacterDraft}
      aiDraftStage="已发送申请，等待 KP 同意用房主的 AI 生成"
    />);

    fireEvent.change(screen.getByPlaceholderText(/1920 年代东京/), { target: { value: "谨慎的女记者" } });
    fireEvent.click(screen.getByRole("button", { name: "用 AI 生成草稿" }));
    expect(await screen.findByText("已发送申请，等待 KP 同意用房主的 AI 生成")).toBeTruthy();

    await act(async () => { generation.reject(new Error("KP 拒绝了这次 AI 车卡申请：职业与本团年代不符")); });
    expect(await screen.findByText(/KP 拒绝了这次 AI 车卡申请：职业与本团年代不符/)).toBeTruthy();
    expect(screen.queryByText("已发送申请，等待 KP 同意用房主的 AI 生成")).toBeNull();
  });
});

function createRoom(localRole: RoomRecord["localRole"], localPeerId: string): RoomRecord {
  return {
    id: "character-room",
    name: "角色测试房间",
    localRole,
    localPeerId,
    hostPeerId: localRole === "host" ? localPeerId : "host-local",
    inviteToken: "saved-token",
    relayUrl: "ws://127.0.0.1:8787/v1/rooms/character-room/ws",
    lastSeq: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createSession(
  role: ParticipantV1["role"],
  peerId: string,
  displayName: string,
  submitConfirmed: (_type: string, _payload: unknown) => Promise<void> = async () => undefined,
) {
  const submit = vi.fn(submitConfirmed);
  const session = {
    participant: { peerId, displayName, role },
    isHost: role === "host",
    submit: vi.fn(async (_type: string, _payload: unknown) => undefined),
    submitConfirmed: submit,
  } as unknown as RoomSession;
  return { session, submit };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface StoredCharacterDraft {
  version: number;
  scope: string;
  character: Coc7Character;
  privateNotes: string;
  savedAt: string;
  baseRoomUpdatedAt?: string | null | "unknown";
}

function readStoredCharacterDraft(key: string): StoredCharacterDraft {
  return JSON.parse(window.sessionStorage.getItem(key) ?? "null") as StoredCharacterDraft;
}

function findStoredCharacterDraft(scope: string): StoredCharacterDraft | undefined {
  for (let index = 0; index < window.sessionStorage.length; index += 1) {
    const key = window.sessionStorage.key(index);
    if (!key) continue;
    const stored = readStoredCharacterDraft(key);
    if (stored?.scope === scope) return stored;
  }
  return undefined;
}

function createCharacter(
  id: string,
  ownerPeerId: string,
  name: string,
  playerName: string,
): Coc7Character {
  const characteristics: Coc7Character["characteristics"] = {
    str: 50,
    con: 50,
    siz: 50,
    dex: 50,
    app: 50,
    int: 50,
    pow: 50,
    edu: 50,
    luck: 50,
  };
  return coc7CharacterSchema.parse({
    schemaVersion: 1,
    id,
    ownerPeerId,
    name,
    playerName,
    occupation: "记者",
    age: 25,
    residence: "",
    birthplace: "",
    characteristics,
    derived: deriveCoc7Stats({ characteristics, age: 25, skills: [] }),
    skills: [],
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
    updatedAt: "2026-01-01T00:00:00.000Z",
    extensions: {},
  });
}

function characterEvent(character: Coc7Character, sequence: number): RoomEventV1 {
  return {
    protocolVersion: 1,
    roomId: "character-room",
    eventId: `character-event-${sequence}`,
    sequence,
    sender: { peerId: "host-local", displayName: "Keeper", role: "host" },
    type: "character.updated",
    occurredAt: `2026-01-01T00:00:0${sequence}.000Z`,
    payload: { character },
  };
}

function createReadyCharacter(id: string, ownerPeerId: string, name: string, playerName: string): Coc7Character {
  const character = createCharacter(id, ownerPeerId, name, playerName);
  const skills: Coc7Character["skills"] = [{
    id: `${id}-library-use`,
    name: "图书馆使用",
    baseValue: 20,
    value: 60,
    checked: false,
  }];
  return coc7CharacterSchema.parse({
    ...character,
    skills,
    derived: deriveCoc7Stats({
      characteristics: character.characteristics,
      age: character.age,
      skills,
    }),
  });
}

async function clearPersonalCharacterLibrary(): Promise<void> {
  const repository = await getRepository();
  for (const record of await repository.listPersonalCharactersV2()) {
    await repository.deletePersonalCharacterV2(record.characterId);
  }
}

function derivedValue(label: string): string {
  return screen.getByText(label).parentElement?.textContent ?? "";
}
