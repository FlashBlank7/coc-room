// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRoomWorldStateV2, type BoardV1, type CheckAuthorizationV2, type CheckOutcomeV2, type CheckRequestV2, type Coc7Character, type ModulePackageV1, type RoomArtifactV2, type RoomEntityV2, type RoomEventViewV2, type SeatV2 } from "@coc-room/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getRepository, type RoomRecord } from "../data/repository";
import { downloadTextInBrowser } from "../lib/browser-download";
import type { RoomSessionV2 } from "../network/RoomSessionV2";
import { useAppStore } from "../store/app-store";
import { RoomViewV2 } from "./RoomViewV2";

const { generateNpcStatsDraft, draftSceneNpcReply } = vi.hoisted(() => ({
  generateNpcStatsDraft: vi.fn(),
  draftSceneNpcReply: vi.fn(),
}));

vi.mock("../ai/web-development-ai-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/web-development-ai-bridge")>();
  return { ...actual, runWebDevelopmentAiTask: draftSceneNpcReply };
});

vi.mock("../ai/tauri-npc-stats-draft-executor", () => ({
  tauriNpcStatsDraftExecutor: { generateDraft: generateNpcStatsDraft },
}));
vi.mock("../lib/browser-download", () => ({ downloadTextInBrowser: vi.fn() }));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  generateNpcStatsDraft.mockReset();
  draftSceneNpcReply.mockReset();
  vi.mocked(downloadTextInBrowser).mockReset();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  Reflect.deleteProperty(globalThis, "indexedDB");
  Reflect.deleteProperty(URL, "createObjectURL");
  useAppStore.setState({ activeView: "lobby" });
});

describe("RoomViewV2 board creation", () => {
  it("treats the mobile tools as a dismissible focus-managed dialog", async () => {
    const room = roomRecord("room-v2-mobile-tools", "player");
    const session = {
      isHost: false,
      submit: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
    } as unknown as RoomSessionV2;

    render(<RoomViewV2 room={room} session={session} views={[]} world={createRoomWorldStateV2(room.id)} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    expect(screen.getByText("已进入调查")).toBeTruthy();
    const trigger = screen.getByRole("button", { name: "打开调查员工具" });
    trigger.focus();
    fireEvent.click(trigger);

    expect(screen.getByRole("dialog", { name: "我的工具" })).toBeTruthy();
    const close = screen.getByRole("button", { name: "关闭工具" });
    await waitFor(() => expect(document.activeElement).toBe(close));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "我的工具" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("lets the tools sidebar be resized and reset by its drag separator", () => {
    const room = roomRecord("room-v2-resizable-tools", "player");
    const session = {
      isHost: false,
      submit: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
    } as unknown as RoomSessionV2;

    const { container } = render(<RoomViewV2 room={room} session={session} views={[]} world={createRoomWorldStateV2(room.id)} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    const separator = screen.getByRole("separator", { name: "调整工具栏宽度" });
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.style.getPropertyValue("--room-tools-width")).toBe("360px");

    fireEvent.doubleClick(separator);
    expect(grid.style.getPropertyValue("--room-tools-width")).toBe("360px");
    expect(globalThis.localStorage.getItem("coc-room:tools-width")).toBe("360");
  });

  it("turns a raw connection failure into a recoverable room message", () => {
    const setConnectionError = vi.fn();
    const session = {
      isHost: false,
      submit: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-readable-error", "player");

    render(<RoomViewV2 room={room} session={session} views={[]} world={createRoomWorldStateV2(room.id)} seats={[]} paths={{}} authenticationState="authenticated" connectionError="relay websocket timeout" setConnectionError={setConnectionError} onLeave={vi.fn()} />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("房间连接暂时不稳定，这次操作没有发出");
    expect((screen.getByText("查看失败原因").closest("details") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
    expect(setConnectionError).toHaveBeenCalledWith(undefined);
  });

  it("keeps record export feedback separate from room connectivity and lets people retry", async () => {
    vi.mocked(downloadTextInBrowser).mockImplementationOnce(() => {
      throw new Error("browser download blocked");
    });
    const setConnectionError = vi.fn();
    const room = roomRecord("room-v2-export", "player");
    const session = {
      isHost: false,
      submit: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
    } as unknown as RoomSessionV2;

    render(<RoomViewV2 room={room} session={session} views={[]} world={createRoomWorldStateV2(room.id)} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={setConnectionError} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("房间菜单"));
    fireEvent.click(screen.getByRole("button", { name: "导出网页记录" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("导出没有完成，记录仍安全保存在本机");
    expect((screen.getByText("查看失败原因").closest("details") as HTMLDetailsElement).open).toBe(false);
    expect(setConnectionError).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "重试导出" }));
    await waitFor(() => expect(downloadTextInBrowser).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("网页记录已开始下载。")).toBeTruthy();
  });

  it("filters and searches the readable record with a few table-friendly categories", () => {
    const room = roomRecord("room-v2-record-search", "player");
    const session = {
      isHost: false,
      submit: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "林默" },
    } as unknown as RoomSessionV2;
    const views = recordSearchViews(room.id);

    render(<RoomViewV2 room={room} session={session} views={views} world={createRoomWorldStateV2(room.id)} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "记录" }));

    expect(screen.getByText("我听见门后有唱针声。")).toBeTruthy();
    expect(screen.getByText("侦查：检查唱片机")).toBeTruthy();
    expect(screen.getByText("染血票根")).toBeTruthy();
    expect(screen.getByText("显示 4 / 4 条记录")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(screen.getByText("我听见门后有唱针声。")).toBeTruthy();
    expect(screen.queryByText("染血票根")).toBeNull();
    expect(screen.getByText("显示 1 / 4 条记录")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "检定" }));
    expect(screen.getByText("侦查：检查唱片机")).toBeTruthy();
    expect(screen.queryByText("我听见门后有唱针声。")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "发现" }));
    expect(screen.getByText("染血票根")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "角色与状态" }));
    expect(screen.getByText(/更新角色卡/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索团务记录" }), { target: { value: "林默 侦查" } });
    expect(screen.getByText("侦查：检查唱片机")).toBeTruthy();
    expect(screen.queryByText("我听见门后有唱针声。")).toBeNull();
    expect(screen.getByText("显示 1 / 4 条记录")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索团务记录" }), { target: { value: "染血票根" } });
    expect(screen.getByText("染血票根")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect((screen.getByRole("textbox", { name: "搜索团务记录" }) as HTMLInputElement).value).toBe("");
    expect(screen.getByText("显示 4 / 4 条记录")).toBeTruthy();
  });

  it("exports every visible record even while the on-screen record is filtered", async () => {
    const room = roomRecord("room-v2-record-export-all", "player");
    const session = {
      isHost: false,
      submit: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "林默" },
    } as unknown as RoomSessionV2;
    const views = recordSearchViews(room.id).slice(0, 3);

    render(<RoomViewV2 room={room} session={session} views={views} world={createRoomWorldStateV2(room.id)} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "记录" }));
    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(screen.queryByText("染血票根")).toBeNull();

    fireEvent.click(screen.getByLabelText("房间菜单"));
    fireEvent.click(screen.getByRole("button", { name: "导出文字记录" }));

    await waitFor(() => expect(downloadTextInBrowser).toHaveBeenCalledOnce());
    const exported = String(vi.mocked(downloadTextInBrowser).mock.calls[0]?.[1]);
    expect(exported).toContain("我听见门后有唱针声");
    expect(exported).toContain("染血票根");
    expect(exported).toContain("侦查：检查唱片机");
  });

  it("lets the table write multi-line narration without accidentally sending it", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const room = roomRecord("room-v2-multiline-chat", "player");
    const session = {
      isHost: false,
      submit,
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
    } as unknown as RoomSessionV2;

    render(<RoomViewV2 room={room} session={session} views={[]} world={createRoomWorldStateV2(room.id)} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    const composer = screen.getByRole("textbox", { name: "现场发言" });
    const send = screen.getByRole("button", { name: "发送消息" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.change(composer, { target: { value: "我检查门锁。\n然后听门后的声音。" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(submit).not.toHaveBeenCalled();
    expect(send.disabled).toBe(false);

    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      type: "chat.message",
      payload: { message: "我检查门锁。\n然后听门后的声音。", format: "plain" },
    })));
  });

  it("does not claim a missing keeper module is ready and offers a repair path", async () => {
    useAppStore.setState({ activeView: "room" });
    const room = roomRecord("room-v2-missing-module", "host");
    const session = {
      isHost: true,
      submit: vi.fn(),
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;
    const world = {
      ...createRoomWorldStateV2(room.id),
      activeModule: { moduleId: "module-not-on-this-computer", revision: 27, title: "遗失的备团资料" },
    };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("本机暂时打不开对应的备团资料");
    expect(screen.queryByText(/已打开《遗失的备团资料》/)).toBeNull();
    expect(screen.getByRole("button", { name: "重新读取" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "去模组库处理" })).toBeTruthy();

    const situation = screen.getByLabelText("当前情境");
    const continueTemporarily = within(situation).getByRole("button", { name: "先用临时开场继续" });
    const prepare = within(situation).getByRole("button", { name: "去 KP 备团" });
    const presenter = screen.getByLabelText("即兴呈现当前情境");
    const scrollIntoView = vi.fn();
    Object.defineProperty(presenter, "scrollIntoView", { configurable: true, value: scrollIntoView });

    fireEvent.click(prepare);
    expect(useAppStore.getState().activeView).toBe("modules");
    useAppStore.setState({ activeView: "room" });
    fireEvent.click(continueTemporarily);

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    expect(screen.getByRole("dialog", { name: "导演台" })).toBeTruthy();
  });

  it("takes a keeper with a loaded module straight from the empty situation to the private scene workbench", async () => {
    const modulePackage = openingModuleFixture();
    await (await getRepository()).saveModule({ package: modulePackage, sourceText: "本地 KP 原文" });
    const room = roomRecord("room-v2-module-opening", "host");
    const session = {
      isHost: true,
      submit: vi.fn(),
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;
    const world = {
      ...createRoomWorldStateV2(room.id),
      activeModule: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, title: modulePackage.metadata.title },
    };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    const situation = screen.getByLabelText("当前情境");
    const openingAction = await within(situation).findByRole("button", { name: "选择并呈现开场" });
    expect(within(situation).queryByRole("button", { name: "临时开场" })).toBeNull();
    expect(within(situation).queryByRole("button", { name: "返回模组库修复" })).toBeNull();
    expect(within(situation).queryByText("这是 KP 才能看的场景摘要")).toBeNull();
    const workbench = screen.getByLabelText("推进当前场景");
    expect(screen.queryByLabelText("即兴呈现当前情境")).toBeNull();
    const scrollIntoView = vi.fn();
    Object.defineProperty(workbench, "scrollIntoView", { configurable: true, value: scrollIntoView });

    fireEvent.click(openingAction);

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    expect(screen.getByRole("dialog", { name: "导演台" })).toBeTruthy();
    expect(within(workbench).getByText("这是 KP 才能看的场景摘要")).toBeTruthy();
  });

  it("publishes the module's first scene as the opening with one click", async () => {
    const modulePackage = { ...openingModuleFixture(), moduleId: "module-quick-opening" };
    await (await getRepository()).saveModule({ package: modulePackage, sourceText: "本地 KP 原文" });
    const room = roomRecord("room-v2-quick-opening", "host");
    const submitConfirmed = vi.fn().mockResolvedValue(undefined);
    const session = {
      isHost: true,
      submit: vi.fn(),
      submitConfirmed,
      world: { entities: new Map() },
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;
    const world = {
      ...createRoomWorldStateV2(room.id),
      activeModule: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, title: modulePackage.metadata.title },
    };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "一键开场：剧院后门" }));
    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledTimes(2));
    expect(submitConfirmed.mock.calls[0]![0]).toMatchObject({
      type: "entity.upserted",
      payload: { entity: expect.objectContaining({ kind: "scene", name: "剧院后门", description: "这是 KP 才能看的场景摘要" }) },
    });
    expect(submitConfirmed.mock.calls[1]![0]).toMatchObject({ type: "scene.focused" });
  });

  it("lets a keeper recover a loaded zero-scene module with a private manual opening", async () => {
    useAppStore.setState({ activeView: "room" });
    const modulePackage = zeroSceneModuleFixture();
    await (await getRepository()).saveModule({ package: modulePackage, sourceText: "只供 KP 阅读的模组原文" });
    const room = roomRecord("room-v2-zero-scene-opening", "host");
    const submitConfirmed = vi.fn().mockResolvedValue(undefined);
    const session = {
      isHost: true,
      submit: vi.fn(),
      submitConfirmed,
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;
    const world = {
      ...createRoomWorldStateV2(room.id),
      activeModule: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, title: modulePackage.metadata.title },
    };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    const situation = screen.getByLabelText("当前情境");
    const situationRecovery = await within(situation).findByLabelText("零场景模组恢复");
    expect(within(situation).getByRole("heading", { name: "这个模组还没有可用场景" })).toBeTruthy();
    expect(within(situationRecovery).getByRole("button", { name: "临时开场" })).toBeTruthy();
    const repairModule = within(situationRecovery).getByRole("button", { name: "返回模组库修复" });
    expect(repairModule).toBeTruthy();
    expect(within(situation).queryByRole("button", { name: "选择并呈现开场" })).toBeNull();
    expect(screen.queryByLabelText("推进当前场景")).toBeNull();
    expect(screen.queryByText("绝不能公开的模组概览")).toBeNull();
    expect(screen.queryByText("绝不能公开的主持人笔记")).toBeNull();

    const director = screen.getByLabelText("KP 导演台");
    const toolsRecovery = within(director).getByLabelText("零场景模组恢复");
    expect(within(toolsRecovery).getByRole("button", { name: "临时开场" })).toBeTruthy();
    expect(within(toolsRecovery).getByRole("button", { name: "返回模组库修复" })).toBeTruthy();

    const presenter = screen.getByLabelText("即兴呈现当前情境");
    const scrollIntoView = vi.fn();
    Object.defineProperty(presenter, "scrollIntoView", { configurable: true, value: scrollIntoView });
    fireEvent.click(within(situationRecovery).getByRole("button", { name: "临时开场" }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));

    fireEvent.change(screen.getByRole("textbox", { name: "当前情境名称" }), { target: { value: "雨夜的车站" } });
    fireEvent.change(screen.getByRole("textbox", { name: "当前情境公开描述" }), { target: { value: "末班车已经离开，站台只剩一盏忽明忽暗的灯。" } });
    fireEvent.click(screen.getByRole("button", { name: "把开场公开给所有玩家" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledTimes(2));
    const publishedEntity = submitConfirmed.mock.calls[0]?.[0]?.payload.entity;
    expect(submitConfirmed.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      type: "entity.upserted",
      audience: { kind: "room" },
      payload: { entity: expect.objectContaining({
        kind: "scene",
        name: "雨夜的车站",
        description: "末班车已经离开，站台只剩一盏忽明忽暗的灯。",
        data: { roomRole: "manual-current-scene" },
      }) },
    }));
    expect(submitConfirmed.mock.calls[1]?.[0]).toEqual({
      type: "scene.focused",
      audience: { kind: "room" },
      payload: { sceneEntityId: publishedEntity.entityId },
    });

    fireEvent.click(repairModule);
    expect(useAppStore.getState().activeView).toBe("modules");
  });

  it("gives a keeper without a module direct temporary-opening and preparation choices", async () => {
    useAppStore.setState({ activeView: "room" });
    const room = roomRecord("room-v2-manual-opening", "host");
    const session = {
      isHost: true,
      submit: vi.fn(),
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;

    render(<RoomViewV2 room={room} session={session} views={[]} world={createRoomWorldStateV2(room.id)} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    const situation = screen.getByLabelText("当前情境");
    const temporaryOpening = within(situation).getByRole("button", { name: "临时开场（不使用模组）" });
    const prepare = within(situation).getByRole("button", { name: "去 KP 备团" });
    const presenter = screen.getByLabelText("即兴呈现当前情境");
    const scrollIntoView = vi.fn();
    Object.defineProperty(presenter, "scrollIntoView", { configurable: true, value: scrollIntoView });

    fireEvent.click(prepare);
    expect(useAppStore.getState().activeView).toBe("modules");
    useAppStore.setState({ activeView: "room" });
    fireEvent.click(temporaryOpening);

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    expect(screen.getByRole("dialog", { name: "导演台" })).toBeTruthy();
  });

  it("shows a waiting state to players without mounting any keeper opening controls or private module content", () => {
    const room = roomRecord("room-v2-player-waits-opening", "player");
    const session = {
      isHost: false,
      submit: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
    } as unknown as RoomSessionV2;
    const world = {
      ...createRoomWorldStateV2(room.id),
      activeModule: { moduleId: "module-private-opening", revision: 1, title: "私密模组" },
    };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    const situation = screen.getByLabelText("当前情境");
    expect(within(situation).getByRole("heading", { name: "等待 KP 呈现开场" })).toBeTruthy();
    expect(within(situation).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "选择并呈现开场" })).toBeNull();
    expect(screen.queryByRole("button", { name: "临时开场（不使用模组）" })).toBeNull();
    expect(screen.queryByLabelText("推进当前场景")).toBeNull();
    expect(screen.queryByText("这是 KP 才能看的场景摘要")).toBeNull();
  });

  it("does not expose the temporary fallback while a host record is read only", () => {
    const room = roomRecord("room-v2-read-only-module-opening", "host");
    const session = {
      isHost: true,
      submit: vi.fn(),
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;
    const world = {
      ...createRoomWorldStateV2(room.id),
      activeModule: { moduleId: "module-missing-read-only", revision: 1, title: "本机缺失的模组" },
    };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" readOnly setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    const situation = screen.getByLabelText("当前情境");
    expect(within(situation).getByRole("heading", { name: "记录中没有公开开场" })).toBeTruthy();
    expect(within(situation).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "先用临时开场继续" })).toBeNull();
    expect(screen.queryByLabelText("即兴呈现当前情境")).toBeNull();
  });

  it("puts the first player invitation in the live scene and keeps it there until copied", async () => {
    const issueSeatInvitation = vi.fn().mockResolvedValue({
      protocolVersion: 2,
      roomId: "room-v2-invite-copy",
      seatId: "seat-alice",
      role: "player",
      relayToken: "relay-token-12345678901234567890",
      seatSecret: "seat-secret-123456789012345678901234567890",
      credentialVersion: 1,
      hostSeatId: "seat-host",
      hostPeerId: "peer-host",
      relayUrl: "ws://127.0.0.1:8787/v1/rooms/room-v2-invite-copy/ws",
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const session = {
      isHost: true,
      submit: vi.fn(),
      issueSeatInvitation,
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-invite-copy", "host");

    render(<RoomViewV2 room={room} session={session} views={[]} world={createRoomWorldStateV2(room.id)} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    const situation = screen.getByLabelText("当前情境");
    const invitationCard = screen.getByLabelText("发送第一份玩家邀请");
    expect(situation.compareDocumentPosition(invitationCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("玩家与邀请")).toBeNull();
    const generate = screen.getByRole("button", { name: "生成专属邀请" }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("第一位玩家称呼"), { target: { value: "Alice" } });
    expect(generate.disabled).toBe(false);
    fireEvent.click(generate);
    const copy = await screen.findByRole("button", { name: "复制并发给这位玩家" });
    expect(screen.getByLabelText("发送第一份玩家邀请")).toBeTruthy();
    expect(screen.getByLabelText("第一份玩家邀请内容").textContent).toMatch(/^coc-room:v2:/);
    fireEvent.click(copy);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^coc-room:v2:/)));
    await waitFor(() => expect(screen.queryByLabelText("发送第一份玩家邀请")).toBeNull());
    expect(screen.getByText("玩家与邀请")).toBeTruthy();
    expect(screen.getByRole("button", { name: "已复制，可以发给这位玩家" })).toBeTruthy();
  });

  it("separates invited seats from who is online and lets the keeper rotate an offline invitation", async () => {
    const rotateSeatInvitation = vi.fn().mockResolvedValue({
      protocolVersion: 2,
      roomId: "room-v2-seat-roster",
      seatId: "seat-alice",
      role: "player",
      relayToken: "relay-token-12345678901234567890",
      seatSecret: "rotated-secret-123456789012345678901234567890",
      credentialVersion: 2,
      hostSeatId: "seat-host",
      hostPeerId: "peer-host",
      relayUrl: "ws://127.0.0.1:8787/v1/rooms/room-v2-seat-roster/ws",
    });
    const session = {
      isHost: true,
      submit: vi.fn(),
      rotateSeatInvitation,
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP", peerId: "peer-host", extensions: {} },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-seat-roster", "host");
    const seats: SeatV2[] = [
      { seatId: "seat-host", role: "host", displayName: "KP", peerId: "peer-host", extensions: {} },
      { seatId: "seat-alice", role: "player", displayName: "尚未加入的 Alice", extensions: {} },
      { seatId: "seat-bob", role: "player", displayName: "已经在线的 Bob", peerId: "peer-bob", extensions: {} },
    ];

    render(<RoomViewV2 room={room} session={session} views={[]} world={createRoomWorldStateV2(room.id)} seats={seats} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    expect(screen.getByText("1 位调查员在线")).toBeTruthy();
    fireEvent.click(screen.getByText("玩家与邀请"));
    expect(screen.getByText("已邀请 2 位调查员")).toBeTruthy();
    expect(screen.getAllByText("在线（连接方式确认中）")).toHaveLength(2);
    const aliceName = screen.getByText("尚未加入的 Alice");
    const aliceRow = aliceName.parentElement as HTMLElement;
    expect(within(aliceRow).getByText("离线")).toBeTruthy();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(within(aliceRow).getByRole("button", { name: "为 尚未加入的 Alice 换新邀请" }));

    await waitFor(() => expect(rotateSeatInvitation).toHaveBeenCalledWith("seat-alice"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("旧邀请会立即失效"));
    confirm.mockRestore();
  });

  it("lets the keeper create a map instead of hard-coding a scene", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const session = { isHost: true, submit, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" } } as unknown as RoomSessionV2;
    const room = {
      id: "room-v2-board",
      name: "Board room",
      localPeerId: "peer-host",
      hostPeerId: "peer-host",
      localRole: "host",
      localSeatId: "seat-host",
      protocolVersion: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as RoomRecord;

    render(<RoomViewV2 room={room} session={session} views={[]} world={createRoomWorldStateV2(room.id)} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("画面类型"), { target: { value: "map" } });
    fireEvent.click(screen.getByRole("button", { name: "创建可选画面" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[0]![0].payload.board).toMatchObject({ kind: "map", name: "新的调查地图" });
    expect(submit.mock.calls[1]![0]).toMatchObject({ type: "board.activated" });
  });

  it("lets the keeper create and activate a second, explicitly named map", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const session = { isHost: true, submit, submitConfirmed: submit, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, sendPreview: vi.fn() } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-second-board", "host");
    const base = createRoomWorldStateV2(room.id);
    const firstBoard = { schemaVersion: 1 as const, boardId: "board-first-scene", revision: 1, kind: "scene" as const, name: "剧院后台", description: "", audience: { kind: "room" as const }, logicalSize: { width: 1600, height: 900 }, archived: false, items: [], edges: [], extensions: {} };
    const world = { ...base, boards: new Map([[firstBoard.boardId, firstBoard]]), activeBoardId: firstBoard.boardId };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    expect(screen.queryByLabelText("新建现场画面")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开画面：剧院后台" }));
    fireEvent.click(screen.getByText("新建另一张画面"));
    fireEvent.change(screen.getByLabelText("新画面名称"), { target: { value: "  港区追逐路线  " } });
    fireEvent.change(screen.getByLabelText("画面类型"), { target: { value: "map" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并切换" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    const created = submit.mock.calls[0]![0];
    expect(created).toMatchObject({
      type: "board.created",
      audience: { kind: "room" },
      payload: { board: { kind: "map", name: "港区追逐路线", archived: false } },
    });
    expect(created.payload.board.boardId).not.toBe(firstBoard.boardId);
    expect(submit.mock.calls[1]![0]).toMatchObject({
      type: "board.activated",
      audience: { kind: "room" },
      payload: { boardId: created.payload.board.boardId },
    });
    expect(submit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "board.updated" }));
  });

  it("lists boards and lets only the keeper archive through a revisioned event", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const session = { isHost: true, submit, submitConfirmed: submit, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, sendPreview: vi.fn() } as unknown as RoomSessionV2;
    const room = { id: "room-v2-board", name: "Board room", localPeerId: "peer-host", hostPeerId: "peer-host", localRole: "host", localSeatId: "seat-host", protocolVersion: 2, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } as RoomRecord;
    const base = createRoomWorldStateV2(room.id);
    const board = { schemaVersion: 1 as const, boardId: "board-map", revision: 3, kind: "map" as const, name: "旧宅地图", description: "", audience: { kind: "room" as const }, logicalSize: { width: 1600, height: 900 }, archived: false, items: [], edges: [], extensions: {} };
    const world = { ...base, boards: new Map([[board.boardId, board]]), activeBoardId: board.boardId };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "展开画面：旧宅地图" }));
    fireEvent.click(screen.getByRole("button", { name: "归档画面 旧宅地图" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0]![0]).toMatchObject({ type: "board.updated", payload: { board: { boardId: "board-map", revision: 4, archived: true } } });
  });

  it("lets the keeper select and lock a board item from the human inspector", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const session = { isHost: true, submit, submitConfirmed: submit, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, sendPreview: vi.fn() } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-board-inspector", "host");
    const base = createRoomWorldStateV2(room.id);
    const item = { schemaVersion: 1 as const, itemId: "item-actor", reference: { kind: "text" as const, text: "沉默的演员" }, label: "沉默的演员", position: { x: 400, y: 300 }, size: { width: 180, height: 100 }, rotationDegrees: 0, scale: 1, zIndex: 1, locked: false, audience: { kind: "room" as const }, extensions: {} };
    const board = { schemaVersion: 1 as const, boardId: "board-stage", revision: 2, kind: "scene" as const, name: "剧院后台", description: "", audience: { kind: "room" as const }, logicalSize: { width: 1600, height: 900 }, archived: false, items: [item], edges: [], extensions: {} };
    const world = { ...base, boards: new Map([[board.boardId, board]]), activeBoardId: board.boardId };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "展开画面：剧院后台" }));
    fireEvent.click(screen.getByTestId("board-item-item-actor"));
    fireEvent.click(screen.getByRole("button", { name: "锁定项目" }));

    await waitFor(() => expect(submit).toHaveBeenCalledWith({
      type: "board.item.upserted",
      audience: { kind: "room" },
      payload: { boardId: board.boardId, boardRevision: 3, item: { ...item, locked: true } },
    }));
  });

  it("keeps scene and map composition in the keeper's hands", () => {
    const session = { isHost: false, submit: vi.fn(), localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" }, sendPreview: vi.fn() } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-player-map-composition", "player");
    const base = createRoomWorldStateV2(room.id);
    const clue = roomEntity("clue-map-secret", "clue", "潮湿火柴盒", "从剧院后门捡到。", {});
    const first = { schemaVersion: 1 as const, itemId: "map-item-a", reference: { kind: "text" as const, text: "门厅" }, label: "门厅", position: { x: 200, y: 200 }, rotationDegrees: 0, scale: 1, zIndex: 0, locked: false, audience: { kind: "room" as const }, extensions: {} };
    const second = { ...first, itemId: "map-item-b", reference: { kind: "text" as const, text: "后台" }, label: "后台", position: { x: 600, y: 300 }, zIndex: 1 };
    const board = { schemaVersion: 1 as const, boardId: "board-player-map-composition", revision: 1, kind: "map" as const, name: "剧院地图", description: "", audience: { kind: "room" as const }, logicalSize: { width: 1600, height: 900 }, archived: false, items: [first, second], edges: [], extensions: {} };
    const world = { ...base, entities: new Map([[clue.entityId, clue]]), boards: new Map([[board.boardId, board]]), activeBoardId: board.boardId };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "展开画面：剧院地图" }));

    expect(screen.queryByLabelText("新建现场画面")).toBeNull();
    expect(screen.queryByText("新建另一张画面")).toBeNull();
    expect(screen.queryByRole("button", { name: "放到当前画面" })).toBeNull();
    expect(screen.queryByRole("button", { name: "画关系线" })).toBeNull();
  });

  it("keeps an evidence-only room out of the live scene while leaving its board usable in the case file", async () => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {} });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn() });
    const submitConfirmed = vi.fn().mockResolvedValue("confirmed");
    const room = roomRecord("room-v2-player-evidence-composition", "player");
    const base = createRoomWorldStateV2(room.id);
    const clue = roomArtifact("clue-evidence-public", "clue", "潮湿火柴盒", { kind: "room" });
    const first = { schemaVersion: 1 as const, itemId: "evidence-item-a", reference: { kind: "text" as const, text: "旧剧院" }, label: "旧剧院", position: { x: 200, y: 200 }, rotationDegrees: 0, scale: 1, zIndex: 0, locked: false, audience: { kind: "room" as const }, extensions: {} };
    const second = { ...first, itemId: "evidence-item-b", reference: { kind: "text" as const, text: "失踪案" }, label: "失踪案", position: { x: 600, y: 300 }, zIndex: 1 };
    const board = { schemaVersion: 1 as const, boardId: "board-player-evidence-composition", revision: 1, kind: "evidence" as const, name: "共享推理板", description: "", audience: { kind: "room" as const }, logicalSize: { width: 1600, height: 900 }, archived: false, items: [first, second], edges: [], extensions: {} };
    const world = { ...base, artifacts: new Map([[clue.artifactId, clue]]), boards: new Map([[board.boardId, board]]), activeBoardId: board.boardId };
    const session = {
      isHost: false,
      submit: vi.fn(),
      submitConfirmed,
      world,
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
      sendPreview: vi.fn(),
    } as unknown as RoomSessionV2;

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    expect(screen.getByText("本场暂不使用画面")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "展开画面：共享推理板" })).toBeNull();
    expect(screen.queryByLabelText("协作画面：共享推理板")).toBeNull();
    expect(screen.queryByRole("button", { name: "上传背景图" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "调查案卷" }));
    expect(screen.getByLabelText("协作画面：共享推理板")).toBeTruthy();
    expect(screen.getByRole("button", { name: "画关系线" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "放到大家的推理板" }));
    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      type: "board.item.upserted",
      payload: expect.objectContaining({
        boardId: board.boardId,
        boardRevision: 2,
        item: expect.objectContaining({ reference: { kind: "artifact", artifactId: clue.artifactId } }),
      }),
    })));
  });

  it("does not fall back to an evidence board when no live board was explicitly activated", () => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {} });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn() });
    const room = roomRecord("room-v2-no-live-board-fallback", "host");
    const evidenceBoard = { schemaVersion: 1 as const, boardId: "board-case-file-only", revision: 1, kind: "evidence" as const, name: "案件关系板", description: "", audience: { kind: "room" as const }, logicalSize: { width: 1600, height: 900 }, archived: false, items: [], edges: [], extensions: {} };
    const location = roomEntity("location-lobby", "location", "剧院大厅", "铺着褪色红毯。", {});
    const world = {
      ...createRoomWorldStateV2(room.id),
      entities: new Map([[location.entityId, location]]),
      boards: new Map([[evidenceBoard.boardId, evidenceBoard]]),
      activeBoardId: undefined,
    };
    const session = { isHost: true, submit: vi.fn(), world, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" } } as unknown as RoomSessionV2;

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    expect(screen.getByText("本场暂不使用画面")).toBeTruthy();
    expect(screen.queryByLabelText("协作画面：案件关系板")).toBeNull();
    expect(screen.queryByRole("button", { name: "放到当前画面" })).toBeNull();
    expect(screen.queryByRole("button", { name: "上传背景图" })).toBeNull();
    const kindSelect = screen.getByLabelText("画面类型") as HTMLSelectElement;
    expect([...kindSelect.options].map(({ value }) => value)).toEqual(["scene", "map"]);

    fireEvent.click(screen.getByRole("button", { name: "调查案卷" }));
    expect(screen.getByLabelText("协作画面：案件关系板")).toBeTruthy();
  });

  it("keeps the collapsed board with the current situation, above the live record", () => {
    const session = { isHost: false, submit: vi.fn(), localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" } } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-optional-board", "player");
    const base = createRoomWorldStateV2(room.id);
    const scene = roomEntity("scene-current", "scene", "旧宅门厅", "雨水从破裂的彩窗渗进来。", {});
    const board = { schemaVersion: 1 as const, boardId: "board-map", revision: 1, kind: "map" as const, name: "旧宅地图", description: "", audience: { kind: "room" as const }, logicalSize: { width: 1600, height: 900 }, archived: false, items: [], edges: [], extensions: {} };
    const world = { ...base, entities: new Map([[scene.entityId, scene]]), activeSceneEntityId: scene.entityId, boards: new Map([[board.boardId, board]]), activeBoardId: board.boardId };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    const situation = screen.getByLabelText("当前情境");
    const liveRecord = screen.getByRole("heading", { name: "正在发生" }).closest("section") as HTMLElement;
    const optionalVisual = screen.getByLabelText("可选现场画面");
    const toggle = screen.getByRole("button", { name: "展开画面：旧宅地图" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "旧宅地图 画面内容" })).toBeNull();
    // 情境 → 画面 → 故事流：地图跟着当前情境走，最新对话不再被顶到屏幕外。
    expect(Boolean(situation.compareDocumentPosition(optionalVisual) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(optionalVisual.compareDocumentPosition(liveRecord) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    fireEvent.click(toggle);
    expect(screen.getByRole("group", { name: "旧宅地图 画面内容" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "收起画面：旧宅地图" }));
    expect(screen.queryByRole("group", { name: "旧宅地图 画面内容" })).toBeNull();
  });

  it("puts an actionable map prompt in the player flow when their token can move", () => {
    const session = { isHost: false, submit: vi.fn(), localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" }, sendPreview: vi.fn() } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-player-map-action", "player");
    const base = createRoomWorldStateV2(room.id);
    const actor = roomEntity("character-entity-player", "character", "林默", "调查记者", {
      ownerSeatId: "seat-player",
      characterId: "character-player",
    });
    const item = {
      schemaVersion: 1 as const,
      itemId: "item-player-token",
      reference: { kind: "entity" as const, entityId: actor.entityId },
      label: "林默",
      position: { x: 300, y: 240 },
      size: { width: 120, height: 120 },
      rotationDegrees: 0,
      scale: 1,
      zIndex: 1,
      locked: false,
      audience: { kind: "room" as const },
      extensions: {},
    };
    const board = { schemaVersion: 1 as const, boardId: "board-active-map", revision: 1, kind: "map" as const, name: "旧宅一层", description: "", audience: { kind: "room" as const }, logicalSize: { width: 1600, height: 900 }, archived: false, items: [item], edges: [], extensions: {} };
    const world = { ...base, entities: new Map([[actor.entityId, actor]]), boards: new Map([[board.boardId, board]]), activeBoardId: board.boardId };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    const prompt = screen.getByLabelText("地图行动提示");
    expect(within(prompt).getByText(/移动表达你准备前往的位置/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "旧宅一层 画面内容" })).toBeNull();

    fireEvent.click(within(prompt).getByRole("button", { name: "打开地图：旧宅一层" }));

    expect(screen.getByRole("group", { name: "旧宅一层 画面内容" })).toBeTruthy();
    expect(within(prompt).getByRole("button", { name: "回到地图：旧宅一层" })).toBeTruthy();
  });

  it("surfaces module-scene entry movement in the keeper's main flow and tab badge", async () => {
    const baseModule = openingModuleFixture();
    const modulePackage: ModulePackageV1 = {
      ...baseModule,
      moduleId: "module-map-entry-banner",
      scenes: [
        { ...baseModule.scenes[0]!, id: "scene-foyer", name: "剧院门厅" },
        { ...baseModule.scenes[0]!, id: "scene-records", name: "后台唱片室", synopsis: "不可出现在移动提醒中的 KP 摘要" },
      ],
    };
    await (await getRepository()).saveModule({ package: modulePackage, sourceText: "本地 KP 原文" });
    const room = roomRecord("room-v2-keeper-map-entry", "host");
    const base = createRoomWorldStateV2(room.id);
    const foyer = roomEntity("entity-scene-foyer", "scene", "剧院门厅", "玩家已经看见的门厅。", {
      sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-foyer" },
    });
    const records = roomEntity("entity-scene-records", "scene", "后台唱片室", "", {
      sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-records" },
    });
    const actor = roomEntity("entity-character-map-entry", "character", "林默", "调查记者", {
      ownerSeatId: "seat-player",
      characterId: "character-player",
    });
    const sceneItem = { schemaVersion: 1 as const, itemId: "item-scene-records", reference: { kind: "entity" as const, entityId: records.entityId }, label: records.name, position: { x: 800, y: 450 }, size: { width: 420, height: 260 }, rotationDegrees: 0, scale: 1, zIndex: 1, locked: true, audience: { kind: "room" as const }, extensions: {} };
    const actorItem = { schemaVersion: 1 as const, itemId: "item-character-map-entry", reference: { kind: "entity" as const, entityId: actor.entityId }, label: actor.name, position: { x: 800, y: 450 }, size: { width: 120, height: 120 }, rotationDegrees: 0, scale: 1, zIndex: 2, locked: false, audience: { kind: "room" as const }, extensions: {} };
    const board = { schemaVersion: 1 as const, boardId: "board-map-entry", revision: 1, kind: "map" as const, name: "剧院平面图", description: "", audience: { kind: "room" as const }, logicalSize: { width: 1600, height: 900 }, archived: false, items: [sceneItem, actorItem], edges: [], extensions: {} };
    const world = {
      ...base,
      activeModule: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, title: modulePackage.metadata.title },
      activeSceneEntityId: foyer.entityId,
      activeBoardId: board.boardId,
      entities: new Map([[foyer.entityId, foyer], [records.entityId, records], [actor.entityId, actor]]),
      boards: new Map([[board.boardId, board]]),
    };
    const session = { isHost: true, submit: vi.fn(), localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world } as unknown as RoomSessionV2;

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    const notice = await screen.findByLabelText("地图移动等待 KP 回应");
    expect(notice.textContent).toContain("林默 → 后台唱片室");
    expect(notice.textContent).not.toContain("不可出现在移动提醒中的 KP 摘要");
    expect(screen.getByRole("button", { name: "现场" }).textContent).toContain("1");
    const workbench = screen.getByLabelText("推进当前场景");
    const scrollIntoView = vi.fn();
    Object.defineProperty(workbench, "scrollIntoView", { configurable: true, value: scrollIntoView });

    fireEvent.click(within(notice).getByRole("button", { name: "准备呈现场景" }));

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    expect(screen.getByRole("dialog", { name: "导演台" })).toBeTruthy();
  });

  it("does not let a legacy character reference override an explicit different seat owner", () => {
    const session = { isHost: false, submit: vi.fn(), localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" }, sendPreview: vi.fn() } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-conflicting-token-owner", "player");
    const base = createRoomWorldStateV2(room.id);
    const character = roomInvestigator();
    const actor = roomEntity("character-entity-conflict", "character", character.name, "调查记者", {
      ownerSeatId: "seat-someone-else",
      characterId: character.id,
    });
    const item = { schemaVersion: 1 as const, itemId: "item-conflicting-token", reference: { kind: "entity" as const, entityId: actor.entityId }, label: character.name, position: { x: 300, y: 240 }, size: { width: 120, height: 120 }, rotationDegrees: 0, scale: 1, zIndex: 1, locked: false, audience: { kind: "room" as const }, extensions: {} };
    const board = { schemaVersion: 1 as const, boardId: "board-conflicting-token", revision: 1, kind: "map" as const, name: "旧宅一层", description: "", audience: { kind: "room" as const }, logicalSize: { width: 1600, height: 900 }, archived: false, items: [item], edges: [], extensions: {} };
    const world = { ...base, latestCharacters: new Map([[character.id, character]]), entities: new Map([[actor.entityId, actor]]), boards: new Map([[board.boardId, board]]), activeBoardId: board.boardId };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    expect(screen.queryByLabelText("地图行动提示")).toBeNull();
  });

  it("makes the board background a local-preview-first keeper action", () => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {} });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn() });
    const session = { isHost: true, submit: vi.fn(), localSeat: { seatId: "seat-host", role: "host", displayName: "KP" } } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-background-language", "host");
    const base = createRoomWorldStateV2(room.id);
    const board = { schemaVersion: 1 as const, boardId: "board-map", revision: 1, kind: "map" as const, name: "镇区地图", description: "", audience: { kind: "room" as const }, logicalSize: { width: 1600, height: 900 }, archived: false, items: [], edges: [], extensions: {} };
    const world = { ...base, boards: new Map([[board.boardId, board]]), activeBoardId: board.boardId };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "展开画面：镇区地图" }));
    expect(screen.getByRole("button", { name: "选择背景图" })).toBeTruthy();
    expect(screen.getByText(/点击“确认公开背景”前，玩家不会收到这张图/)).toBeTruthy();
  });

  it("shows a usable fallback instead of silently hiding a background transfer failure", async () => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {} });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn() });
    const session = { isHost: false, submit: vi.fn(), localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" } } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-background-failure", "player");
    const base = createRoomWorldStateV2(room.id);
    const asset = {
      schemaVersion: 1 as const,
      assetId: `sha256:${"a".repeat(64)}`,
      mediaType: "image/webp",
      byteLength: 1024,
      width: 1600,
      height: 900,
    };
    const background = { ...roomArtifact("artifact-map-background", "map-background", "旧宅地图背景", { kind: "room" as const }), asset };
    const board = { schemaVersion: 1 as const, boardId: "board-map-failed-background", revision: 1, kind: "map" as const, name: "旧宅地图", description: "", audience: { kind: "room" as const }, logicalSize: { width: 1600, height: 900 }, backgroundArtifactId: background.artifactId, archived: false, items: [], edges: [], extensions: {} };
    const world = { ...base, artifacts: new Map([[background.artifactId, background]]), boards: new Map([[board.boardId, board]]), activeBoardId: board.boardId };
    const resolveAsset = vi.fn().mockRejectedValue(new Error("transfer unavailable"));

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} resolveAsset={resolveAsset} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "展开画面：旧宅地图" }));

    await waitFor(() => expect(screen.getByLabelText("画面背景状态").textContent).toContain("背景未能载入"));
    expect(screen.getByTestId("board-fallback-background")).toBeTruthy();
    expect(screen.getByRole("group", { name: "旧宅地图 画面内容" })).toBeTruthy();
  });

  it("keeps an NPC stats result local until the keeper explicitly confirms it", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const session = { isHost: true, submit, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" } } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-npc-stats", "host");
    const world = createRoomWorldStateV2(room.id);
    const npc: RoomEntityV2 = {
      schemaVersion: 2,
      entityId: "npc:watchman",
      revision: 3,
      kind: "npc",
      name: "守夜人",
      description: "博物馆的年迈守卫。",
      artifactIds: [],
      audience: { kind: "room" },
      data: {},
      extensions: {},
    };
    (world.entities as Map<string, RoomEntityV2>).set(npc.entityId, npc);
    generateNpcStatsDraft.mockResolvedValue({
      npcId: npc.entityId,
      provider: "codex",
      model: "",
      character: {
        characteristics: { str: 45, con: 50, siz: 55, dex: 40, int: 65, pow: 50 },
        skills: { "Spot Hidden": 70 },
        hitPoints: 10,
        sanity: 50,
      },
    });

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("NPC 属性草稿目标"), { target: { value: npc.entityId } });
    fireEvent.change(screen.getByLabelText("NPC 属性补充要求"), { target: { value: "观察敏锐，不擅长战斗" } });
    fireEvent.click(screen.getByRole("button", { name: "生成属性草稿" }));

    expect(await screen.findByText(/只有你能看到 · 确认后才会更新「/)).toBeTruthy();
    expect(generateNpcStatsDraft).toHaveBeenCalledWith(expect.objectContaining({
      npcId: npc.entityId,
      name: npc.name,
      description: npc.description,
      guidance: "观察敏锐，不擅长战斗",
    }), expect.any(AbortSignal));
    expect(submit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认并更新人物" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0]![0]).toMatchObject({
      type: "entity.upserted",
      payload: {
        entity: {
          entityId: npc.entityId,
          revision: 4,
          data: { character: { hitPoints: 10, sanity: 50 } },
        },
      },
    });
  });

  it("shows players only the clue entity type", () => {
    const session = {
      isHost: false,
      submit: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-player-entity", "player");

    render(<RoomViewV2 room={room} session={session} views={[]} world={createRoomWorldStateV2(room.id)} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    const entityType = screen.getByLabelText("内容类型") as HTMLSelectElement;
    expect(entityType.value).toBe("clue");
    expect(within(entityType).queryByRole("option", { name: "地点" })).toBeNull();
    expect(within(entityType).queryByRole("option", { name: "人物" })).toBeNull();
    expect(within(entityType).getByRole("option", { name: "线索" })).toBeTruthy();
  });

  it("creates a manual clue as an artifact and opens it in the shared case file", async () => {
    const submitConfirmed = vi.fn().mockResolvedValue(undefined);
    const session = {
      isHost: false,
      submitConfirmed,
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-manual-clue", "player");
    const world = createRoomWorldStateV2(room.id);
    const props = { room, session, views: [] as RoomEventViewV2[], seats: [] as SeatV2[], paths: {}, authenticationState: "authenticated" as const, setConnectionError: vi.fn(), onLeave: vi.fn() };
    const view = render(<RoomViewV2 {...props} world={world} />);
    const supplement = screen.getByText("临时补充内容").closest("details") as HTMLDetailsElement;
    const form = within(supplement);

    fireEvent.change(form.getByLabelText("名称"), { target: { value: "沾血的戏票" } });
    fireEvent.change(form.getByLabelText("线索正文"), { target: { value: "背面写着午夜十二点与后台入口。" } });
    fireEvent.click(form.getByRole("button", { name: "公开到调查案卷" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledOnce());
    const proposal = submitConfirmed.mock.calls[0]![0];
    expect(proposal).toMatchObject({
      type: "artifact.upserted",
      audience: { kind: "room" },
      payload: {
        artifact: {
          schemaVersion: 2,
          revision: 1,
          kind: "clue",
          title: "沾血的戏票",
          description: "",
          body: "背面写着午夜十二点与后台入口。",
          attachments: [],
          locked: false,
          archived: false,
          audience: { kind: "room" },
        },
      },
    });
    expect(proposal.type).not.toBe("entity.upserted");

    const artifact = proposal.payload.artifact as RoomArtifactV2;
    view.rerender(<RoomViewV2 {...props} world={{ ...world, artifacts: new Map([[artifact.artifactId, artifact]]) }} />);
    const caseFile = screen.getByText(/这里是所有人都能看到的事实与线索/).closest('[aria-label="调查案卷"]') as HTMLElement;
    expect(within(caseFile).getByText("沾血的戏票")).toBeTruthy();
    expect(within(caseFile).getByText("背面写着午夜十二点与后台入口。")).toBeTruthy();
  });

  it("creates a manual location already presented in the current situation", async () => {
    const submitConfirmed = vi.fn().mockResolvedValue(undefined);
    const room = roomRecord("room-v2-manual-location", "host");
    const base = createRoomWorldStateV2(room.id);
    const scene = roomEntity("scene-current", "scene", "后台唱片室", "雨水拍打着剧院后门。", {});
    const world = {
      ...base,
      entities: new Map([[scene.entityId, scene]]),
      activeSceneEntityId: scene.entityId,
    };
    const session = {
      isHost: true,
      submitConfirmed,
      world,
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;
    const props = { room, session, views: [] as RoomEventViewV2[], seats: [] as SeatV2[], paths: {}, authenticationState: "authenticated" as const, setConnectionError: vi.fn(), onLeave: vi.fn() };
    const view = render(<RoomViewV2 {...props} world={world} />);
    const supplement = screen.getByText("临时补充内容").closest("details") as HTMLDetailsElement;
    const form = within(supplement);

    fireEvent.change(form.getByLabelText("内容类型"), { target: { value: "location" } });
    fireEvent.change(form.getByLabelText("名称"), { target: { value: "暗门后的楼梯" } });
    fireEvent.change(form.getByLabelText("玩家会看到的描述"), { target: { value: "狭窄台阶向地下延伸。" } });
    expect(form.getByLabelText(`创建后立即在当前情境“${scene.name}”登场`)).toHaveProperty("checked", true);
    fireEvent.click(form.getByRole("button", { name: "创建并在当前情境登场" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledOnce());
    const proposal = submitConfirmed.mock.calls[0]![0];
    expect(proposal).toMatchObject({
      type: "entity.upserted",
      audience: { kind: "room" },
      payload: {
        entity: {
          revision: 1,
          kind: "location",
          name: "暗门后的楼梯",
          description: "狭窄台阶向地下延伸。",
          data: { presentedInSceneEntityIds: [scene.entityId] },
        },
      },
    });

    const entity = proposal.payload.entity as RoomEntityV2;
    view.rerender(<RoomViewV2 {...props} world={{ ...world, entities: new Map([[scene.entityId, scene], [entity.entityId, entity]]) }} />);
    expect(within(screen.getByLabelText("当前情境中的地点")).getByText("暗门后的楼梯")).toBeTruthy();
  });

  it("lets the keeper present an existing loose NPC in the current situation", async () => {
    const submitConfirmed = vi.fn().mockResolvedValue(undefined);
    const room = roomRecord("room-v2-present-loose-npc", "host");
    const base = createRoomWorldStateV2(room.id);
    const scene = roomEntity("scene-current", "scene", "后台唱片室", "雨水拍打着剧院后门。", {});
    const npc = roomEntity("npc-loose", "npc", "陌生售票员", "他一直避开众人的目光。", {});
    const world = {
      ...base,
      entities: new Map([[scene.entityId, scene], [npc.entityId, npc]]),
      activeSceneEntityId: scene.entityId,
    };
    const session = {
      isHost: true,
      submitConfirmed,
      world,
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    const supplement = screen.getByText("临时补充内容").closest("details") as HTMLDetailsElement;
    fireEvent.click(within(supplement).getByRole("button", { name: "让它在当前情境登场" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledOnce());
    expect(submitConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      type: "entity.upserted",
      payload: {
        entity: expect.objectContaining({
          entityId: npc.entityId,
          revision: 2,
          data: { presentedInSceneEntityIds: [scene.entityId] },
        }),
      },
    }));
  });

  it("keeps the mobile scene full-height and opens tools as a dismissible drawer", () => {
    const session = {
      isHost: true,
      submit: vi.fn(),
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-mobile-tools", "host");

    render(<RoomViewV2 room={room} session={session} views={[]} world={createRoomWorldStateV2(room.id)} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    const director = screen.getByLabelText("KP 导演台");
    expect(director.className).toContain("hidden");
    fireEvent.click(screen.getByRole("button", { name: "打开 KP 导演台" }));
    expect(director.className).toContain("fixed");
    fireEvent.click(screen.getByRole("button", { name: "关闭工具" }));
    expect(director.className).toContain("hidden");
  });

  it("keeps public locations and NPC appearances attached to the durable current situation", () => {
    const session = {
      isHost: false,
      submit: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-current-situation", "player");
    const base = createRoomWorldStateV2(room.id);
    const scene = roomEntity("scene-current", "scene", "后台唱片室", "雨水拍打着剧院后门。", {});
    const location = roomEntity("location-door", "location", "剧院后门", "锈蚀铁门上挂着一道崭新的锁。", { presentedInSceneEntityIds: [scene.entityId] });
    const npc = roomEntity("npc-actor", "npc", "沉默的演员", "浑身湿透、神情紧张。", { presentedInSceneEntityIds: [scene.entityId] });
    const world = {
      ...base,
      entities: new Map([[scene.entityId, scene], [location.entityId, location], [npc.entityId, npc]]),
      activeSceneEntityId: scene.entityId,
    };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    const current = screen.getByLabelText("当前情境");
    expect(within(current).getByText("后台唱片室")).toBeTruthy();
    expect(within(screen.getByLabelText("当前情境中的地点")).getByText("剧院后门")).toBeTruthy();
    expect(within(screen.getByLabelText("当前情境中的人物")).getByText("沉默的演员")).toBeTruthy();
  });

  it("keeps a successful player check waiting through unrelated room events until its own KP outcome arrives", () => {
    const room = roomRecord("room-v2-player-waits-for-outcome", "player");
    const { world, request } = playerCheckWorldFixture(room.id, { authorization: "resolved-success" });
    const session = {
      isHost: false,
      submitConfirmed: vi.fn(),
      rollDice: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "林默" },
    } as unknown as RoomSessionV2;
    const rollView = fullView({
      roomId: room.id,
      eventId: "event-player-roll",
      sequence: 1,
      sender: { seatId: "seat-player", role: "player", displayName: "林默", extensions: {} },
      type: "dice.result",
      payload: {
        result: {
          kind: "percentile",
          expression: "1d100",
          rolls: [24],
          total: 24,
          check: { target: 60, requiredDifficulty: "regular", outcome: "hard", success: true },
        },
        reason: `侦查：${request.reason}`,
        checkRequestId: request.requestId,
      },
    });
    const props = { room, session, seats: [] as SeatV2[], paths: {}, authenticationState: "authenticated" as const, setConnectionError: vi.fn(), onLeave: vi.fn() };
    const view = render(<RoomViewV2 {...props} views={[rollView]} world={world} />);

    expect(screen.getByRole("heading", { name: "检定已完成，等待 KP 描述结果" })).toBeTruthy();
    expect(screen.queryByLabelText("你想怎么做")).toBeNull();

    const narrationView = fullView({
      roomId: room.id,
      eventId: "event-keeper-outcome",
      sequence: 2,
      sender: { seatId: "seat-host", role: "host", displayName: "KP", extensions: {} },
      type: "chat.message",
      payload: { message: "你在夹层里找到一张被折起的曲目单。", format: "plain" },
    });
    view.rerender(<RoomViewV2 {...props} views={[rollView, narrationView]} world={world} />);

    expect(screen.getByRole("heading", { name: "检定已完成，等待 KP 描述结果" })).toBeTruthy();

    const sceneView = fullView({
      roomId: room.id,
      eventId: "event-keeper-scene-outcome",
      sequence: 2,
      sender: { seatId: "seat-host", role: "host", displayName: "KP", extensions: {} },
      type: "scene.focused",
      payload: { sceneEntityId: "scene-next" },
    });
    view.rerender(<RoomViewV2 {...props} views={[rollView, sceneView]} world={world} />);
    expect(screen.getByRole("heading", { name: "检定已完成，等待 KP 描述结果" })).toBeTruthy();

    const publicClue = roomArtifact("artifact-check-result", "clue", "夹层里的曲目单", { kind: "room" });
    const publicArtifactView = fullView({
      roomId: room.id,
      eventId: "event-keeper-artifact-outcome",
      sequence: 2,
      sender: { seatId: "seat-host", role: "host", displayName: "KP", extensions: {} },
      type: "artifact.upserted",
      payload: { artifact: publicClue },
    });
    view.rerender(<RoomViewV2 {...props} views={[rollView, publicArtifactView]} world={world} />);
    expect(screen.getByRole("heading", { name: "检定已完成，等待 KP 描述结果" })).toBeTruthy();

    const privateNote = roomArtifact("artifact-private-follow-up", "note", "我的私人推测", { kind: "seats", seatIds: ["seat-player"] });
    const privateArtifactView = fullView({
      roomId: room.id,
      eventId: "event-private-artifact-after-roll",
      sequence: 2,
      audience: { kind: "seats", seatIds: ["seat-player"] },
      sender: { seatId: "seat-host", role: "host", displayName: "KP", extensions: {} },
      type: "artifact.upserted",
      payload: { artifact: privateNote },
    });
    view.rerender(<RoomViewV2 {...props} views={[rollView, privateArtifactView]} world={world} />);
    expect(screen.getByRole("heading", { name: "检定已完成，等待 KP 描述结果" })).toBeTruthy();

    (world.checkOutcomes as Map<string, CheckOutcomeV2>).set(request.requestId, {
      requestId: request.requestId,
      text: "你在夹层里找到一张被折起的曲目单。",
      describedBySeatId: "seat-host",
      describedAt: "2026-01-01T00:00:03.000Z",
      audience: { kind: "room" },
    });
    const outcomeView = fullView({
      roomId: room.id,
      eventId: "event-explicit-check-outcome",
      sequence: 3,
      sender: { seatId: "seat-host", role: "host", displayName: "KP", extensions: {} },
      type: "check.outcome.described",
      payload: { requestId: request.requestId, text: "你在夹层里找到一张被折起的曲目单。" },
    });
    view.rerender(<RoomViewV2 {...props} views={[rollView, narrationView, outcomeView]} world={world} />);
    expect(screen.queryByRole("heading", { name: "检定已完成，等待 KP 描述结果" })).toBeNull();
    expect(screen.getByRole("heading", { name: "你想怎么做？" })).toBeTruthy();
  });

  it.each([
    { pushed: false, expectedHeading: "第一次检定失败了" },
    { pushed: true, expectedHeading: "检定已完成，等待 KP 描述结果" },
  ])("waits after a pushed failure=$pushed but keeps an ordinary failure actionable", ({ pushed, expectedHeading }) => {
    const room = roomRecord(`room-v2-player-failed-${pushed ? "push" : "ordinary"}`, "player");
    const { world, request } = playerCheckWorldFixture(room.id, { authorization: "resolved-failure", pushed });
    if (!pushed) {
      (world.checkOutcomes as Map<string, CheckOutcomeV2>).set(request.requestId, {
        requestId: request.requestId,
        text: "锁芯没有转动，门内却响了一声。",
        describedBySeatId: "seat-host",
        describedAt: "2026-01-01T00:00:02.000Z",
        audience: { kind: "room" },
      });
    }
    const session = {
      isHost: false,
      submitConfirmed: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "林默" },
    } as unknown as RoomSessionV2;
    const rollView = fullView({
      roomId: room.id,
      eventId: "event-player-roll",
      sequence: 1,
      sender: { seatId: "seat-player", role: "player", displayName: "林默", extensions: {} },
      type: "dice.result",
      payload: {
        result: { kind: "percentile", expression: "1d100", rolls: [81], total: 81, check: { target: 60, requiredDifficulty: "regular", outcome: "failure", success: false } },
        reason: `侦查：${request.reason}`,
        checkRequestId: request.requestId,
      },
    });

    render(<RoomViewV2 room={room} session={session} views={[rollView]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    expect(screen.getByRole("heading", { name: expectedHeading })).toBeTruthy();
    if (pushed) {
      expect(screen.queryByLabelText("你想怎么做")).toBeNull();
    } else {
      expect(screen.getByRole("button", { name: "换一种做法申请强推" })).toBeTruthy();
    }
  });

  it("surfaces a newly authorized roll inside mobile tools and returns to the live action", () => {
    const room = roomRecord("room-v2-player-ready-handoff", "player");
    const pending = playerCheckWorldFixture(room.id, { authorization: "none" });
    const ready = playerCheckWorldFixture(room.id, { authorization: "ready" });
    const session = {
      isHost: false,
      submitConfirmed: vi.fn(),
      rollDice: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "林默" },
    } as unknown as RoomSessionV2;
    const props = { room, session, views: [] as RoomEventViewV2[], seats: [] as SeatV2[], paths: {}, authenticationState: "authenticated" as const, setConnectionError: vi.fn(), onLeave: vi.fn() };
    const view = render(<RoomViewV2 {...props} world={pending.world} />);

    fireEvent.click(screen.getByRole("button", { name: "调查案卷" }));
    fireEvent.click(screen.getByRole("button", { name: "打开调查员工具" }));
    expect(screen.getByRole("dialog", { name: "我的工具" })).toBeTruthy();

    view.rerender(<RoomViewV2 {...props} world={ready.world} />);
    const tools = screen.getByRole("dialog", { name: "我的工具" });
    const handoff = within(tools).getByRole("status", { name: "工具中的玩家裁定交接" });
    expect(within(handoff).getByText(/侦查 60/)).toBeTruthy();
    fireEvent.click(within(handoff).getByRole("button", { name: "回到现场掷骰" }));

    expect(screen.queryByRole("dialog", { name: "我的工具" })).toBeNull();
    expect(screen.getByRole("button", { name: "现场" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "KP 已允许你掷骰" })).toBeTruthy();
  });

  it("labels an authorized pushed roll as a consequence decision across room tabs", () => {
    const room = roomRecord("room-v2-player-push-handoff", "player");
    const { world } = playerCheckWorldFixture(room.id, { authorization: "ready", pushed: true });
    const session = {
      isHost: false,
      submitConfirmed: vi.fn(),
      rollDice: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "林默" },
    } as unknown as RoomSessionV2;

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "记录" }));

    const handoff = screen.getByRole("status", { name: "玩家裁定交接" });
    expect(within(handoff).getByText("KP 已说明强推代价")).toBeTruthy();
    fireEvent.click(within(handoff).getByRole("button", { name: "查看代价并决定" }));
    expect(screen.getByRole("button", { name: "现场" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByLabelText("决定是否进行强推")).toBeTruthy();
  });

  it.each([
    { outcome: "no-roll" as const, heading: "这项行动无需掷骰", note: "信件就摊在桌面上，你直接看见了落款。" },
    { outcome: "declined" as const, heading: "KP 判断这项做法当前不可行", note: "门从里面焊死了，需要换一种进入方式。" },
  ])("shows and acknowledges a $outcome keeper closure without leaving the current tab", ({ outcome, heading, note }) => {
    const room = roomRecord(`room-v2-player-closure-${outcome}`, "player");
    const fixture = playerCheckWorldFixture(room.id, { authorization: "none" });
    const closure = {
      requestId: fixture.request.requestId,
      outcome,
      note,
      closedBySeatId: "seat-host",
      closedByRole: "host" as const,
      closedAt: "2026-01-01T00:00:02.000Z",
    };
    const closedWorld = { ...fixture.world, checkClosures: new Map([[fixture.request.requestId, closure]]) };
    const session = {
      isHost: false,
      submitConfirmed: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "林默" },
    } as unknown as RoomSessionV2;
    const closureView = fullView({
      roomId: room.id,
      eventId: `event-closure-${outcome}`,
      sequence: 2,
      sender: { seatId: "seat-host", role: "host", displayName: "KP", extensions: {} },
      type: "check.closed",
      payload: { requestId: fixture.request.requestId, outcome, note },
    });
    const props = { room, session, seats: [] as SeatV2[], paths: {}, authenticationState: "authenticated" as const, setConnectionError: vi.fn(), onLeave: vi.fn() };
    const view = render(<RoomViewV2 {...props} views={[]} world={fixture.world} />);
    fireEvent.click(screen.getByRole("button", { name: "记录" }));

    view.rerender(<RoomViewV2 {...props} views={[closureView]} world={closedWorld} />);
    const handoff = screen.getByRole("status", { name: "玩家裁定交接" });
    expect(within(handoff).getByText(heading)).toBeTruthy();
    expect(within(handoff).getByText(note)).toBeTruthy();
    expect(screen.getByRole("button", { name: "现场" }).textContent).toContain("1");

    fireEvent.click(within(handoff).getByRole("button", { name: "知道了，继续" }));
    expect(screen.queryByRole("status", { name: "玩家裁定交接" })).toBeNull();
    expect(screen.getByRole("button", { name: "记录" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "现场" }).textContent).toBe("现场");
  });

  it("keeps the keeper in the human loop after a check result", () => {
    const room = roomRecord("room-v2-after-check", "host");
    const { world, request } = playerCheckWorldFixture(room.id, { authorization: "resolved-success" });
    const submitConfirmed = vi.fn().mockResolvedValue("confirmed");
    const session = {
      isHost: true,
      submitConfirmed,
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;
    const rollView = fullView({
      roomId: room.id,
      eventId: "event-roll",
      sequence: 1,
      sender: { seatId: "seat-player", role: "player", displayName: "林默", extensions: {} },
      type: "dice.result",
      payload: {
        result: {
          kind: "percentile",
          expression: "1d100",
          rolls: [31],
          total: 31,
          check: { target: 60, requiredDifficulty: "regular", outcome: "regular", success: true },
        },
        reason: "侦查：检查唱片机夹层",
        checkRequestId: request.requestId,
      },
    });
    const props = {
      room,
      session,
      world,
      seats: [],
      paths: {},
      authenticationState: "authenticated" as const,
      setConnectionError: vi.fn(),
      onLeave: vi.fn(),
    };

    const view = render(<RoomViewV2 {...props} views={[rollView]} />);
    expect(screen.getByRole("heading", { name: /描述 .* 这次成功带来的变化/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^检定叙述结果：/), {
      target: { value: "你在夹层里摸到一张被折起的曲目单。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发布这次叙述结果" }));
    expect(submitConfirmed).toHaveBeenCalledWith({
      type: "check.outcome.described",
      audience: { kind: "room" },
      payload: { requestId: request.requestId, text: "你在夹层里摸到一张被折起的曲目单。" },
    });

    const outcomeView = fullView({
      roomId: room.id,
      eventId: "event-consequence",
      sequence: 2,
      sender: { seatId: "seat-host", role: "host", displayName: "KP", extensions: {} },
      type: "check.outcome.described",
      payload: { requestId: request.requestId, text: "你在夹层里摸到一张被折起的曲目单。" },
    });
    (world.checkOutcomes as Map<string, CheckOutcomeV2>).set(request.requestId, {
      requestId: request.requestId,
      text: "你在夹层里摸到一张被折起的曲目单。",
      describedBySeatId: "seat-host",
      describedAt: "2026-01-01T00:00:02.000Z",
      audience: { kind: "room" },
    });
    view.rerender(<RoomViewV2 {...props} world={world} views={[rollView, outcomeView]} />);
    expect(screen.getByRole("heading", { name: "这次行动带来了线索吗？" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "这次没有线索，继续" }));
    expect(screen.queryByRole("heading", { name: "这次行动带来了线索吗？" })).toBeNull();
  });

  it("explains an ordinary failure but yields the stage when a push is pending", () => {
    const room = roomRecord("room-v2-after-failed-check", "host");
    const base = createRoomWorldStateV2(room.id);
    const session = {
      isHost: true,
      submit: vi.fn(),
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;
    const originalRequest: CheckRequestV2 = {
      requestId: "check-door",
      characterId: "character-player",
      characterName: "林默",
      skillName: "锁匠",
      proposedTarget: 50,
      reason: "尝试打开地窖门锁",
      requesterSeatId: "seat-player",
      requestedAt: "2026-01-01T00:00:00.000Z",
      audience: { kind: "room" },
    };
    const authorization: CheckAuthorizationV2 = {
      requestId: originalRequest.requestId,
      skillName: originalRequest.skillName,
      target: 50,
      requiredDifficulty: "regular",
      bonusDice: 0,
      penaltyDice: 0,
      note: "可以检定",
      requesterSeatId: "seat-player",
      authorizedAt: "2026-01-01T00:00:01.000Z",
      resolvedByEventId: "event-failed-roll",
      resolvedSuccess: false,
    };
    const failedRoll = fullView({
      roomId: room.id,
      eventId: "event-failed-roll",
      sequence: 1,
      sender: { seatId: "seat-player", role: "player", displayName: "林默", extensions: {} },
      type: "dice.result",
      payload: {
        result: {
          kind: "percentile",
          expression: "1d100",
          rolls: [78],
          total: 78,
          check: { target: 50, requiredDifficulty: "regular", outcome: "failure", success: false },
        },
        reason: "锁匠：尝试打开地窖门锁",
        checkRequestId: originalRequest.requestId,
      },
    });
    const worldAfterFailure = {
      ...base,
      checkRequests: new Map([[originalRequest.requestId, originalRequest]]),
      checkAuthorizations: new Map([[authorization.requestId, authorization]]),
    };
    const props = { room, session, views: [failedRoll], seats: [], paths: {}, authenticationState: "authenticated" as const, setConnectionError: vi.fn(), onLeave: vi.fn() };
    const view = render(<RoomViewV2 {...props} world={worldAfterFailure} />);

    expect(screen.getByRole("heading", { name: /说明 .* 这次失败目前如何表现/ })).toBeTruthy();
    expect(screen.getByText(/换一种有实际区别的做法申请一次强推/)).toBeTruthy();

    const pushedRequest: CheckRequestV2 = {
      ...originalRequest,
      requestId: "check-door-push",
      reason: "改用铁锹作杠杆，从门轴一侧撬开",
      pushOfRequestId: originalRequest.requestId,
      requestedAt: "2026-01-01T00:00:03.000Z",
    };
    const worldWithPendingPush = {
      ...worldAfterFailure,
      checkRequests: new Map([
        [originalRequest.requestId, originalRequest],
        [pushedRequest.requestId, pushedRequest],
      ]),
      checkOutcomes: new Map([[originalRequest.requestId, {
        requestId: originalRequest.requestId,
        text: "锁芯没有转动，门内却传来一声金属碰撞。",
        describedBySeatId: "seat-host",
        describedAt: "2026-01-01T00:00:02.000Z",
        audience: { kind: "room" as const },
      }]]),
    };
    view.rerender(<RoomViewV2 {...props} world={worldWithPendingPush} />);

    expect(screen.queryByRole("heading", { name: /说明 .* 这次失败目前如何表现/ })).toBeNull();
    expect(screen.getByLabelText("当前行动")).toBeTruthy();
  });

  it("shows each public clue once while keeping shared notes in the case-file workspace", () => {
    const session = {
      isHost: false,
      submit: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-case-file", "player");
    const base = createRoomWorldStateV2(room.id);
    const publicClue = roomArtifact("artifact-matchbox", "clue", "潮湿的火柴盒", { kind: "room" });
    const handout = roomArtifact("artifact-diary", "handout", "失踪者日记", { kind: "room" });
    const world = {
      ...base,
      artifacts: new Map([[publicClue.artifactId, publicClue], [handout.artifactId, handout]]),
    };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "调查案卷" }));

    expect(screen.getAllByText("潮湿的火柴盒")).toHaveLength(1);
    expect(screen.getByText("失踪者日记")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "手记与笔记" })).toBeTruthy();
  });

  it("keeps a new-clue handoff visible after later chat until the player opens the case file", async () => {
    const session = {
      isHost: false,
      submit: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-unread-clue", "player");
    const base = createRoomWorldStateV2(room.id);
    const clue = roomArtifact("artifact-wet-ticket", "clue", "被雨打湿的车票", { kind: "room" });
    const world = { ...base, artifacts: new Map([[clue.artifactId, clue]]) };
    const views = [
      fullView({
        roomId: room.id,
        eventId: "00000000-0000-4000-8000-000000000071",
        sequence: 1,
        sender: { seatId: "seat-host", role: "host", displayName: "KP", extensions: {} },
        type: "artifact.upserted",
        payload: { artifact: clue },
      }),
      fullView({
        roomId: room.id,
        eventId: "00000000-0000-4000-8000-000000000072",
        sequence: 2,
        sender: { seatId: "seat-host", role: "host", displayName: "KP", extensions: {} },
        type: "chat.message",
        payload: { message: "远处传来列车驶离站台的声音。", format: "plain" },
      }),
    ];

    const rendered = render(<RoomViewV2 room={room} session={session} views={views} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    const handoff = screen.getByRole("button", { name: "查看 1 条新线索" });
    expect(handoff.textContent).toContain("查看后决定是否加入我的线索栏");
    expect(screen.getByText("远处传来列车驶离站台的声音。")).toBeTruthy();
    fireEvent.click(handoff);
    expect(screen.getByRole("heading", { name: "调查案卷" })).toBeTruthy();
    await waitFor(() => expect(sessionStorage.getItem(`coc-room:v2:seen-public-clue:${room.id}:seat-player`)).toBe("1"));

    fireEvent.click(screen.getByRole("button", { name: "现场" }));
    expect(screen.queryByRole("button", { name: "查看 1 条新线索" })).toBeNull();
    rendered.unmount();
    render(<RoomViewV2 room={room} session={session} views={views} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "查看 1 条新线索" })).toBeNull();
  });

  it("hands public notes and their attachments from the live story into the case file", async () => {
    const session = {
      isHost: false,
      submit: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-unread-handout", "player");
    const image = {
      schemaVersion: 1 as const,
      assetId: `sha256:${"b".repeat(64)}`,
      mediaType: "image/webp",
      byteLength: 1_024,
      width: 640,
      height: 480,
    };
    const handout = {
      ...roomArtifact("artifact-stage-letter", "handout", "剧院经理的信", { kind: "room" }),
      attachments: [image],
    };
    const world = {
      ...createRoomWorldStateV2(room.id),
      artifacts: new Map([[handout.artifactId, handout]]),
    };
    const views = [fullView({
      roomId: room.id,
      eventId: "00000000-0000-4000-8000-000000000073",
      sequence: 1,
      sender: { seatId: "seat-host", role: "host", displayName: "KP", extensions: {} },
      type: "artifact.upserted",
      payload: { artifact: handout },
    })];
    const resolveAsset = vi.fn().mockResolvedValue("blob:stage-letter");

    render(<RoomViewV2 room={room} session={session} views={views} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} resolveAsset={resolveAsset} onLeave={vi.fn()} />);

    const handoff = screen.getByRole("button", { name: "查看 1 项新资料" });
    expect(handoff.textContent).toContain("打开案卷查看正文与附件");
    expect(screen.getByText("剧院经理的信正文")).toBeTruthy();
    expect(await screen.findByRole("img", { name: "剧院经理的信，图片附件 1" })).toBeTruthy();
    expect(resolveAsset).toHaveBeenCalledWith(image);

    fireEvent.click(handoff);
    expect(screen.getByRole("heading", { name: "手记与笔记" })).toBeTruthy();
    expect(screen.getByText("剧院经理的信")).toBeTruthy();
  });

  it("opens an evidence board inside the case file even while a map remains the active scene board", () => {
    const session = {
      isHost: false,
      submit: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-case-file-board", "player");
    const clue = roomArtifact("artifact-station-key", "clue", "刻着站名的钥匙", { kind: "room" });
    const activeMap: BoardV1 = {
      schemaVersion: 1,
      boardId: "board-active-map",
      revision: 1,
      kind: "map",
      name: "当前车站地图",
      description: "",
      audience: { kind: "room" },
      logicalSize: { width: 1600, height: 900 },
      archived: false,
      items: [],
      edges: [],
      extensions: {},
    };
    const evidenceBoard: BoardV1 = {
      ...activeMap,
      boardId: "board-public-evidence",
      kind: "evidence",
      name: "公开关系板",
      items: [{
        schemaVersion: 1,
        itemId: "item-station-key",
        reference: { kind: "artifact", artifactId: clue.artifactId },
        label: clue.title,
        position: { x: 320, y: 220 },
        size: { width: 310, height: 180 },
        rotationDegrees: 0,
        scale: 1,
        zIndex: 0,
        locked: false,
        audience: { kind: "room" },
        extensions: {},
      }],
    };
    const world = {
      ...createRoomWorldStateV2(room.id),
      activeBoardId: activeMap.boardId,
      artifacts: new Map([[clue.artifactId, clue]]),
      boards: new Map([[activeMap.boardId, activeMap], [evidenceBoard.boardId, evidenceBoard]]),
    };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "调查案卷" }));

    expect(screen.getByLabelText("共享推理板")).toBeTruthy();
    expect(screen.getByLabelText("协作画面：公开关系板")).toBeTruthy();
    expect(screen.queryByLabelText("协作画面：当前车站地图")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /刻着站名的钥匙/ }));
    const detail = screen.getByLabelText("选中的公开资料");
    expect(detail.textContent).toContain("刻着站名的钥匙正文");
  });

  it("lets the keeper create a case-file board without replacing the live scene map", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const session = {
      isHost: true,
      submit,
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-create-case-board", "host");
    const map: BoardV1 = {
      schemaVersion: 1,
      boardId: "board-live-map",
      revision: 1,
      kind: "map",
      name: "仍在使用的现场地图",
      description: "",
      audience: { kind: "room" },
      logicalSize: { width: 1600, height: 900 },
      archived: false,
      items: [],
      edges: [],
      extensions: {},
    };
    const world = {
      ...createRoomWorldStateV2(room.id),
      activeBoardId: map.boardId,
      boards: new Map([[map.boardId, map]]),
    };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "调查案卷" }));
    fireEvent.click(screen.getByRole("button", { name: "新建推理板" }));

    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      type: "board.created",
      payload: { board: expect.objectContaining({ kind: "evidence", name: "共同推理板" }) },
    })));
    expect(submit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "board.activated" }));
  });

  it("shows which sound is ready and lets the keeper cancel a pending synchronized play", async () => {
    let releasePlayers!: () => void;
    const waitForAssetReady = vi.fn(() => new Promise<void>((resolve) => { releasePlayers = resolve; }));
    const submit = vi.fn().mockResolvedValue(undefined);
    const session = {
      isHost: true,
      submit,
      waitForAssetReady,
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-audio-wait", "host");
    const asset = {
      schemaVersion: 1 as const,
      assetId: `sha256:${"a".repeat(64)}`,
      mediaType: "audio/ogg",
      byteLength: 2 * 1024 * 1024,
      durationMs: 90_000,
    };
    const ambience = { ...roomArtifact("audio-rain", "ambience-audio", "雨夜环境音", { kind: "room" }), attachments: [asset] };
    const world = { ...createRoomWorldStateV2(room.id), artifacts: new Map([[ambience.artifactId, ambience]]) };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByText("声音", { selector: "span" }));
    expect(screen.getByText("已准备：雨夜环境音")).toBeTruthy();
    expect(screen.getByText("1:30 · 2.0 MiB")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    await waitFor(() => expect(waitForAssetReady).toHaveBeenCalledOnce());
    expect(screen.getByText("正在等待在线玩家接收完成…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "播放" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消这次播放" }));
    releasePlayers();

    await waitFor(() => expect(screen.queryByText("正在等待在线玩家接收完成…")).toBeNull());
    expect(submit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "audio.cued" }));
  });

  it("chooses a legal image destination before spending generation quota", () => {
    const session = {
      isHost: true,
      submit: vi.fn(),
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-image-targets", "host");
    const base = createRoomWorldStateV2(room.id);
    const location = roomEntity("location-yard", "location", "旧宅庭院", "长满潮湿的蕨类。", {});
    const npc = roomEntity("npc-gardener", "npc", "园丁", "沉默寡言。", {});
    const character = roomEntity("character-lin", "character", "林默", "调查记者。", {});
    const mapBoard = { schemaVersion: 1 as const, boardId: "board-town-map", revision: 1, kind: "map" as const, name: "城镇方位图", description: "", audience: { kind: "room" as const }, logicalSize: { width: 1600, height: 900 }, archived: false, items: [], edges: [], extensions: {} };
    const sceneBoard = { ...mapBoard, boardId: "board-mood", kind: "scene" as const, name: "雨夜氛围" };
    const world = {
      ...base,
      entities: new Map([[location.entityId, location], [npc.entityId, npc], [character.entityId, character]]),
      boards: new Map<string, BoardV1>([[mapBoard.boardId, mapBoard], [sceneBoard.boardId, sceneBoard]]),
    };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByText("图片草稿", { selector: "span" }));
    const kind = screen.getByLabelText("图片类型") as HTMLSelectElement;
    const target = screen.getByLabelText("图片使用位置") as HTMLSelectElement;

    expect(within(kind).queryByRole("option", { name: "模组封面" })).toBeNull();
    expect(within(target).getByRole("option", { name: "地点“旧宅庭院”" })).toBeTruthy();
    expect(within(target).queryByRole("option", { name: /园丁/ })).toBeNull();
    fireEvent.change(kind, { target: { value: "npc" } });
    expect(within(target).getByRole("option", { name: "人物“园丁”" })).toBeTruthy();
    expect(within(target).queryByRole("option", { name: /旧宅庭院/ })).toBeNull();
    fireEvent.change(kind, { target: { value: "textlessMap" } });
    expect(within(target).getByRole("option", { name: "地图“城镇方位图”的背景" })).toBeTruthy();
    expect(within(target).queryByRole("option", { name: /雨夜氛围/ })).toBeNull();
  });

  it("offers local preview-first image binding only to the keeper for published entities", () => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {} });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn() });
    const room = roomRecord("room-v2-local-entity-images", "host");
    const base = createRoomWorldStateV2(room.id);
    const location = roomEntity("location-yard-local", "location", "旧宅庭院", "长满潮湿的蕨类。", {});
    const npc = roomEntity("npc-gardener-local", "npc", "园丁", "沉默寡言。", {});
    const character = roomEntity("character-lin-local", "character", "林默", "调查记者。", {});
    const world = {
      ...base,
      entities: new Map([[location.entityId, location], [npc.entityId, npc], [character.entityId, character]]),
    };
    const hostSession = {
      isHost: true,
      submit: vi.fn(),
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;

    const view = render(<RoomViewV2 room={room} session={hostSession} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByText("地点与人物图片", { selector: "span" }));
    const target = screen.getByLabelText("本地图片绑定目标") as HTMLSelectElement;
    expect(within(target).getByRole("option", { name: "地点“旧宅庭院”" })).toBeTruthy();
    expect(within(target).getByRole("option", { name: "人物“园丁”" })).toBeTruthy();
    expect(within(target).getByRole("option", { name: "调查员“林默”" })).toBeTruthy();
    fireEvent.change(target, { target: { value: npc.entityId } });
    expect(screen.getByRole("button", { name: "选择实体图片" })).toBeTruthy();
    expect(screen.getByText(/确认绑定并公开.*玩家不会收到这张图或它的资源描述/)).toBeTruthy();
    expect(hostSession.submit).not.toHaveBeenCalled();

    const playerSession = {
      isHost: false,
      submit: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
    } as unknown as RoomSessionV2;
    view.rerender(<RoomViewV2 room={roomRecord(room.id, "player")} session={playerSession} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);
    expect(screen.queryByText("地点与人物图片", { selector: "span" })).toBeNull();
  });

  it("lets the keeper speak as a scene NPC in the shared story stream", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const session = {
      isHost: true,
      submit,
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-speak-as", "host");
    const scene = roomEntity("scene-foyer", "scene", "剧院门厅", "雨水淌过磨石地面。", {});
    const npc = roomEntity("npc-doorkeeper", "npc", "守门人", "脸色苍白的剧院守门人。", {
      presentedInSceneEntityIds: [scene.entityId],
    });
    const world = {
      ...createRoomWorldStateV2(room.id),
      activeSceneEntityId: scene.entityId,
      entities: new Map([[scene.entityId, scene], [npc.entityId, npc]]),
    };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "以守门人的身份发言" }));
    expect(screen.getByText(/正在以「守门人」的身份发言/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("现场发言"), { target: { value: "这么晚了，剧院不接待客人。" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      type: "chat.message",
      payload: expect.objectContaining({
        message: "这么晚了，剧院不接待客人。",
        persona: { name: "守门人", entityId: "npc-doorkeeper" },
      }),
    })));

    // Dropping the mask sends the next line as the keeper again.
    fireEvent.click(screen.getByRole("button", { name: "回到自己的身份" }));
    fireEvent.change(screen.getByLabelText("现场发言"), { target: { value: "雨声盖过了你们的脚步。" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    const second = submit.mock.calls[1]![0] as { payload: { persona?: unknown } };
    expect(second.payload.persona).toBeUndefined();
  });

  it("drafts an assistant reply the keeper can publish in the NPC's voice", async () => {
    draftSceneNpcReply.mockResolvedValue([{
      type: "result",
      result: { reply: { spokenText: "昨夜我一直守在温室。", stageDirection: "低头擦拭钥匙" } },
    }]);
    const submit = vi.fn().mockResolvedValue(undefined);
    const session = {
      isHost: true,
      submit,
      localSeat: { seatId: "seat-host", role: "host", displayName: "KP" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-npc-draft", "host");
    const scene = roomEntity("scene-foyer", "scene", "剧院门厅", "雨水淌过磨石地面。", {});
    const npc = roomEntity("npc-doorkeeper", "npc", "守门人", "脸色苍白的剧院守门人。", {
      presentedInSceneEntityIds: [scene.entityId],
    });
    const world = {
      ...createRoomWorldStateV2(room.id),
      activeSceneEntityId: scene.entityId,
      entities: new Map([[scene.entityId, scene], [npc.entityId, npc]]),
    };

    render(<RoomViewV2 room={room} session={session} views={[]} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "让助手代答：守门人" }));
    expect(await screen.findByText(/「守门人」的代答草稿 · 只有你能看到/)).toBeTruthy();
    expect(screen.getByText("昨夜我一直守在温室。")).toBeTruthy();
    expect(screen.getByText(/低头擦拭钥匙/)).toBeTruthy();
    expect(draftSceneNpcReply).toHaveBeenCalledWith("npc-reply", expect.objectContaining({
      provider: "codex",
      npcCard: expect.objectContaining({ id: "npc-doorkeeper" }),
    }), expect.anything());
    // Nothing reaches the table until the keeper says so.
    expect(submit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "让 TA 说出" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      type: "chat.message",
      payload: expect.objectContaining({
        message: "昨夜我一直守在温室。",
        persona: { name: "守门人", entityId: "npc-doorkeeper" },
      }),
    })));
    expect(screen.queryByText(/「守门人」的代答草稿/)).toBeNull();
  });

  it("shows an NPC-voiced line under the NPC's name and hides speak-as from players", () => {
    const session = {
      isHost: false,
      submit: vi.fn(),
      localSeat: { seatId: "seat-player", role: "player", displayName: "调查员" },
    } as unknown as RoomSessionV2;
    const room = roomRecord("room-v2-npc-line", "player");
    const scene = roomEntity("scene-foyer", "scene", "剧院门厅", "雨水淌过磨石地面。", {});
    const npc = roomEntity("npc-doorkeeper", "npc", "守门人", "脸色苍白的剧院守门人。", {
      presentedInSceneEntityIds: [scene.entityId],
    });
    const world = {
      ...createRoomWorldStateV2(room.id),
      activeSceneEntityId: scene.entityId,
      entities: new Map([[scene.entityId, scene], [npc.entityId, npc]]),
    };
    const views = [fullView({
      roomId: room.id,
      eventId: "00000000-0000-4000-8000-000000000201",
      sequence: 1,
      sender: { seatId: "seat-host", role: "host", displayName: "KP 本名" },
      type: "chat.message",
      payload: { message: "这么晚了，剧院不接待客人。", format: "plain", persona: { name: "守门人", entityId: "npc-doorkeeper" } },
    })];

    render(<RoomViewV2 room={room} session={session} views={views} world={world} seats={[]} paths={{}} authenticationState="authenticated" setConnectionError={vi.fn()} onLeave={vi.fn()} />);

    const line = screen.getByText("这么晚了，剧院不接待客人。").closest("article") as HTMLElement;
    expect(within(line).getByText("守门人")).toBeTruthy();
    expect(within(line).getByText("NPC")).toBeTruthy();
    expect(within(line).queryByText("KP 本名")).toBeNull();

    // Players talk to NPCs in the same stream; they get no impersonation tools.
    expect(screen.queryByRole("button", { name: "以守门人的身份发言" })).toBeNull();
    expect(screen.queryByRole("button", { name: "让助手代答：守门人" })).toBeNull();
  });
});

function playerCheckWorldFixture(
  roomId: string,
  options: { authorization: "none" | "ready" | "resolved-success" | "resolved-failure"; pushed?: boolean },
): { world: ReturnType<typeof createRoomWorldStateV2>; request: CheckRequestV2 } {
  const world = createRoomWorldStateV2(roomId);
  const character = roomInvestigator();
  const request: CheckRequestV2 = {
    requestId: options.pushed ? "check-player-push" : "check-player",
    characterId: character.id,
    characterName: character.name,
    skillName: "侦查",
    proposedTarget: 60,
    reason: options.pushed ? "拆下铰链销，从门背面拨锁" : "检查唱片机夹层",
    ...(options.pushed ? { pushOfRequestId: "check-player-original" } : {}),
    requesterSeatId: "seat-player",
    requestedAt: "2026-01-01T00:00:00.000Z",
    audience: { kind: "room" },
  };
  (world.latestCharacters as Map<string, Coc7Character>).set(character.id, character);
  (world.checkRequests as Map<string, CheckRequestV2>).set(request.requestId, request);
  if (options.authorization !== "none") {
    const authorization: CheckAuthorizationV2 = {
      requestId: request.requestId,
      skillName: request.skillName,
      target: 60,
      requiredDifficulty: "regular",
      bonusDice: 0,
      penaltyDice: 0,
      note: options.pushed ? "KP 已说明强推再次失败的代价。" : "可以检定。",
      ...(options.pushed ? { failureConsequence: "撬棍会折断，巨响惊醒地下沉睡的东西。" } : {}),
      requesterSeatId: "seat-player",
      authorizedAt: "2026-01-01T00:00:01.000Z",
      ...(options.authorization === "resolved-success" || options.authorization === "resolved-failure"
        ? { resolvedByEventId: "event-player-roll", resolvedSuccess: options.authorization === "resolved-success" }
        : {}),
    };
    (world.checkAuthorizations as Map<string, CheckAuthorizationV2>).set(request.requestId, authorization);
  }
  return { world, request };
}

function roomInvestigator(): Coc7Character {
  return {
    schemaVersion: 1,
    id: "character-player",
    ownerPeerId: "seat-player",
    name: "林默",
    playerName: "玩家",
    occupation: "调查记者",
    age: 29,
    residence: "东京",
    birthplace: "横滨",
    characteristics: { str: 45, con: 55, siz: 50, dex: 60, app: 55, int: 70, pow: 60, edu: 65, luck: 50 },
    derived: { hitPoints: 10, maxHitPoints: 10, magicPoints: 12, maxMagicPoints: 12, sanity: 60, maxSanity: 99, movementRate: 8, build: 0, damageBonus: "0" },
    skills: [{ id: "skill-spot", name: "侦查", baseValue: 25, value: 60, checked: false }],
    inventory: [],
    status: { temporaryInsanity: false, indefiniteInsanity: false, majorWound: false, dying: false, unconscious: false },
    background: { personalDescription: "", ideologyAndBeliefs: "", significantPeople: "", meaningfulLocations: "", treasuredPossessions: "", traits: "", injuriesAndScars: "", phobiasAndManias: "", arcaneTomesSpellsAndArtifacts: "", encountersWithStrangeEntities: "" },
    notes: "",
    updatedAt: "2026-01-01T00:00:00.000Z",
    extensions: {},
  };
}

function roomRecord(id: string, role: "host" | "player"): RoomRecord {
  return {
    id,
    name: "V2 room",
    localPeerId: `peer-${role}`,
    hostPeerId: "peer-host",
    localRole: role,
    localSeatId: `seat-${role}`,
    protocolVersion: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as RoomRecord;
}

function roomEntity(entityId: string, kind: RoomEntityV2["kind"], name: string, description: string, data: Record<string, unknown>): RoomEntityV2 {
  return { schemaVersion: 2, entityId, revision: 1, kind, name, description, artifactIds: [], audience: { kind: "room" }, data, extensions: {} };
}

function roomArtifact(
  artifactId: string,
  kind: RoomArtifactV2["kind"],
  title: string,
  audience: RoomArtifactV2["audience"],
): RoomArtifactV2 {
  return {
    schemaVersion: 2,
    artifactId,
    revision: 1,
    kind,
    title,
    description: "",
    body: `${title}正文`,
    attachments: [],
    audience,
    locked: false,
    archived: false,
    extensions: {},
  };
}

function openingModuleFixture(): ModulePackageV1 {
  return {
    schemaVersion: 1,
    moduleId: "module-private-opening",
    revision: 1,
    metadata: {
      title: "雨夜终幕",
      authors: [],
      language: "zh-CN",
      summary: "",
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    },
    overview: "",
    sourceDocuments: [],
    chapters: [],
    scenes: [{
      id: "scene-private-opening",
      name: "剧院后门",
      description: "这是 KP 才能看的场景摘要",
      synopsis: "这是 KP 才能看的场景摘要",
      locationIds: [],
      npcIds: [],
      clueIds: [],
      handoutIds: [],
      suggestedCheckIds: [],
      keeperNotes: "不要提前说出门后的真相",
      sourceRefs: [],
    }],
    locations: [],
    npcs: [],
    clues: [],
    handouts: [],
    suggestedChecks: [],
    keeperNotes: [],
    relations: [],
    extensions: {},
  };
}

function zeroSceneModuleFixture(): ModulePackageV1 {
  return {
    ...openingModuleFixture(),
    moduleId: "module-zero-scene-opening",
    metadata: {
      ...openingModuleFixture().metadata,
      title: "尚未分场的雨夜终幕",
      summary: "绝不能公开的模组概览",
    },
    overview: "绝不能公开的模组概览",
    scenes: [],
    keeperNotes: [{
      id: "keeper-note-zero-scene",
      title: "绝不能公开的主持人笔记",
      content: "幕后真相只属于 KP。",
      relatedEntityIds: [],
      sourceRefs: [],
    }],
  };
}

function fullView(event: Record<string, unknown>): RoomEventViewV2 {
  return {
    view: "full",
    event: {
      protocolVersion: 2,
      occurredAt: "2026-01-01T00:00:00.000Z",
      audience: { kind: "room" },
      causedByCommandId: "00000000-0000-4000-8000-000000000099",
      ...event,
    },
  } as unknown as RoomEventViewV2;
}

function recordSearchViews(roomId: string): RoomEventViewV2[] {
  return [
    fullView({
      roomId,
      eventId: "00000000-0000-4000-8000-000000000001",
      sequence: 1,
      sender: { seatId: "seat-player", role: "player", displayName: "林默", extensions: {} },
      type: "chat.message",
      payload: { message: "我听见门后有唱针声。", format: "plain" },
    }),
    fullView({
      roomId,
      eventId: "00000000-0000-4000-8000-000000000002",
      sequence: 2,
      sender: { seatId: "seat-player", role: "player", displayName: "林默", extensions: {} },
      type: "dice.result",
      payload: {
        result: {
          kind: "percentile",
          expression: "1d100",
          bonusDice: 0,
          penaltyDice: 0,
          unitsDie: 1,
          tensDice: [3],
          candidates: [31],
          total: 31,
          check: { roll: 31, target: 60, requiredDifficulty: "regular", outcome: "regular", success: true, thresholds: { regular: 60, hard: 30, extreme: 12 } },
        },
        reason: "侦查：检查唱片机",
        checkRequestId: "check-record-search",
      },
    }),
    fullView({
      roomId,
      eventId: "00000000-0000-4000-8000-000000000003",
      sequence: 3,
      sender: { seatId: "seat-host", role: "host", displayName: "KP", extensions: {} },
      type: "artifact.upserted",
      payload: { artifact: roomArtifact("artifact-bloody-ticket", "clue", "染血票根", { kind: "room" }) },
    }),
    fullView({
      roomId,
      eventId: "00000000-0000-4000-8000-000000000004",
      sequence: 4,
      sender: { seatId: "seat-player", role: "player", displayName: "林默", extensions: {} },
      type: "character.updated",
      payload: { character: { name: "林默", playerName: "小林", occupation: "调查记者" } },
    }),
  ];
}
