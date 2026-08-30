// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardV1, ModulePackageV1, RoomArtifactV2, RoomEntityV2, RoomEventV1 } from "@coc-room/protocol";
import { getRepository, type RoomRecord } from "../data/repository";
import { createCocmodPackage } from "../lib/cocmod-package";
import type { RoomSession } from "../network/RoomSession";
import { RoomSessionV2 } from "../network/RoomSessionV2";
import { useAppStore } from "../store/app-store";
import { ModulesView } from "./ModulesView";

afterEach(async () => {
  cleanup();
  document.head.innerHTML = "";
  useAppStore.setState({ activeView: "lobby", modules: [], pendingRoomModule: undefined, currentRoom: undefined, events: [], parserProvider: "codex" });
  await (await getRepository()).deleteModuleDraft("active-module-editor");
  vi.restoreAllMocks();
});

describe("ModulesView browser import", () => {
  it("keeps real AI disabled on a bridge-less player page while preserving import and mock UI work", async () => {
    render(<ModulesView />);
    fireEvent.change(screen.getByLabelText("粘贴原始模组文本"), {
      target: { value: "只用于检查玩家页边界的模组原文" },
    });

    expect(screen.getByRole("status", { name: "当前页面不能运行真实模组整理" }).textContent).toContain("没有本地安全桥");
    expect((screen.getByRole("button", { name: "当前页面不能运行真实整理" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "导入已整理的模组包" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByText("高级设置与测试工具"));
    fireEvent.click(screen.getByRole("button", { name: "使用模拟结果测试流程" }));
    expect((await screen.findByLabelText("模拟解析草稿")).textContent).toContain("模拟结果 · 未调用 Codex 或 DeepSeek");
  });

  it("guides a parsed draft through review before it enters the module library", async () => {
    mockSuccessfulBrowserParse(createModulePackageWithEntities());
    render(<ModulesView />);

    const steps = screen.getByLabelText("模组准备进度");
    expect(screen.getByRole("note", { name: "本次模组整理使用的 AI" }).textContent).toContain("本机登录的 Codex");
    expect(screen.getByRole("note", { name: "本次模组整理使用的 AI" }).textContent).toContain("只有点击按钮才会开始远端模型调用");
    expect(screen.getByRole("button", { name: "导入模组原文" })).not.toBeNull();
    expect(within(steps).getByText("放入原文").closest("li")?.getAttribute("aria-current")).toBe("step");

    fireEvent.change(screen.getByLabelText("粘贴原始模组文本"), {
      target: { value: "旧剧场里传来钟声。调查员需要寻找失踪的演员。" },
    });
    expect(within(steps).getByText("AI 整理").closest("li")?.getAttribute("aria-current")).toBe("step");

    fireEvent.click(screen.getByRole("button", { name: "开始整理模组" }));

    const unsavedDraft = await screen.findByLabelText("未保存的解析草稿");
    expect(within(unsavedDraft).getByText("AI 已整理完成 · 等你确认")).not.toBeNull();
    expect(within(unsavedDraft).getByRole("button", { name: "确认并保存备团资料" })).not.toBeNull();
    expect(useAppStore.getState().modules).toHaveLength(0);
    expect(within(steps).getByText("检查资料").closest("li")?.getAttribute("aria-current")).toBe("step");

    fireEvent.click(within(unsavedDraft).getByRole("button", { name: "确认并保存备团资料" }));

    await screen.findByLabelText("模组已保存");
    expect(useAppStore.getState().modules).toHaveLength(1);
    expect(within(steps).getByText("保存").closest("li")?.getAttribute("aria-current")).toBe("step");
    const savedModuleId = useAppStore.getState().modules[0]?.moduleId;
    if (savedModuleId) await (await getRepository()).deleteModule(savedModuleId);
  });

  it("recovers a parsed draft after a full remount without treating it as a saved module", async () => {
    const modulePackage = createModulePackageWithEntities();
    mockSuccessfulBrowserParse(modulePackage);
    const first = render(<ModulesView />);
    fireEvent.change(screen.getByLabelText("粘贴原始模组文本"), {
      target: { value: "刷新前尚未确认的模组正文" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始整理模组" }));
    await screen.findByLabelText("未保存的解析草稿");

    await waitFor(async () => {
      expect((await (await getRepository()).getModuleDraft("active-module-editor"))?.package.metadata.title)
        .toBe(modulePackage.metadata.title);
    }, { timeout: 2_000 });
    expect(useAppStore.getState().modules).toHaveLength(0);

    first.unmount();
    render(<ModulesView />);
    const recovery = await screen.findByLabelText("可恢复的模组草稿");
    expect(within(recovery).getByText(modulePackage.metadata.title)).not.toBeNull();
    expect(within(recovery).getByText(/不会把它自动用于房间/)).not.toBeNull();
    expect(useAppStore.getState().modules).toHaveLength(0);

    fireEvent.click(within(recovery).getByRole("button", { name: "恢复并继续检查" }));
    const restored = await screen.findByLabelText("未保存的解析草稿");
    expect(within(restored).getByText(/已恢复上次未保存的草稿/)).not.toBeNull();
    expect(useAppStore.getState().modules).toHaveLength(0);

    fireEvent.click(within(restored).getByRole("button", { name: "确认并保存备团资料" }));
    await screen.findByLabelText("模组已保存");
    expect(useAppStore.getState().modules).toHaveLength(1);
    expect(await (await getRepository()).getModuleDraft("active-module-editor")).toBeUndefined();
    const savedModuleId = useAppStore.getState().modules[0]?.moduleId;
    if (savedModuleId) await (await getRepository()).deleteModule(savedModuleId);
  });

  it("can discard a recovered draft without adding it to the formal library", async () => {
    const repository = await getRepository();
    const modulePackage = createModulePackageWithEntities();
    await repository.saveModuleDraft({
      draftId: "active-module-editor",
      package: modulePackage,
      sourceText: "仅用于恢复的正文",
      sourceName: "recovery.md",
      warnings: [],
      updatedAt: "2026-08-30T00:00:00.000Z",
    });
    const first = render(<ModulesView />);
    const recovery = await screen.findByLabelText("可恢复的模组草稿");

    fireEvent.click(within(recovery).getByRole("button", { name: "放弃这份草稿" }));

    await waitFor(() => expect(screen.queryByLabelText("可恢复的模组草稿")).toBeNull());
    expect(await repository.getModuleDraft("active-module-editor")).toBeUndefined();
    expect(useAppStore.getState().modules).toHaveLength(0);
    first.unmount();
    render(<ModulesView />);
    await waitFor(() => expect(screen.queryByLabelText("可恢复的模组草稿")).toBeNull());
  });

  it("does not resurrect a discarded recovery after the keeper explicitly opens saved material", async () => {
    const repository = await getRepository();
    const savedModule = {
      ...createModulePackageWithEntities(),
      moduleId: "module_saved_after_recovery_replace_01",
      metadata: {
        ...createModulePackageWithEntities().metadata,
        title: "正式保存的剧场模组",
      },
    };
    const parsedModule = {
      ...createModulePackageWithEntities(),
      moduleId: "module_unsaved_recovery_replace_01",
      metadata: {
        ...createModulePackageWithEntities().metadata,
        title: "准备放弃的解析草稿",
      },
    };
    await repository.saveModule({ package: savedModule, sourceText: "正式原文" });
    useAppStore.setState({ modules: [savedModule] });
    mockSuccessfulBrowserParse(parsedModule);
    const first = render(<ModulesView />);
    await screen.findByLabelText("正式保存的剧场模组模组内容浏览");

    fireEvent.change(screen.getByLabelText("粘贴原始模组文本"), {
      target: { value: "这份草稿稍后会被明确放弃" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始整理模组" }));
    await screen.findByLabelText("未保存的解析草稿");
    await waitFor(async () => {
      expect((await repository.getModuleDraft("active-module-editor"))?.package.moduleId)
        .toBe(parsedModule.moduleId);
    });

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(within(screen.getByLabelText("已保存模组：正式保存的剧场模组"))
      .getByRole("button", { name: "查看资料" }));

    await screen.findByLabelText("正式保存的剧场模组模组内容浏览");
    await waitFor(async () => expect(await repository.getModuleDraft("active-module-editor")).toBeUndefined());
    first.unmount();
    render(<ModulesView />);
    await waitFor(() => expect(screen.queryByLabelText("可恢复的模组草稿")).toBeNull());
    await repository.deleteModule(savedModule.moduleId);
  });

  it("keeps ZIP image attachments in a reviewable import queue instead of claiming backgrounds exist", async () => {
    const modulePackage = createModulePackageWithEntities();
    mockSuccessfulBrowserParse(modulePackage, {
      warnings: ["Archive includes 2 validated static image attachment(s); attachment bytes were not sent to the text extractor."],
      sourceAttachments: [
        { kind: "image", sha256: "a".repeat(64), mediaType: "image/png", byteLength: 1234, width: 1200, height: 800 },
        { kind: "image", sha256: "b".repeat(64), mediaType: "image/jpeg", byteLength: 2345, width: 900, height: 1200 },
      ],
    });
    render(<ModulesView />);
    fireEvent.change(screen.getByLabelText("粘贴原始模组文本"), {
      target: { value: "带两张配图的模组正文" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始整理模组" }));

    const reminders = await screen.findByLabelText("解析提醒");
    expect(reminders.textContent).toContain("检测到 2 张安全图片");
    expect(reminders.textContent).toContain("尚未进入模组资源库");
    expect(reminders.textContent).toContain("下方预览");
    expect(reminders.textContent).not.toContain("Archive includes");
    expect(screen.getByLabelText("源 ZIP 图片素材").textContent).toContain("不会设成背景，也不会发给玩家");

    fireEvent.click(screen.getByRole("button", { name: "确认并保存备团资料" }));
    await screen.findByLabelText("模组已保存");
    const saved = useAppStore.getState().modules[0];
    expect(saved?.extensions["org.coc-room.source-attachments.v1"]).toMatchObject({
      status: "detected_not_imported",
      items: [{ sha256: "a".repeat(64) }, { sha256: "b".repeat(64) }],
    });
    if (saved) await (await getRepository()).deleteModule(saved.moduleId);
  });

  it("does not claim packaged boards were copied into a room when importing a cocmod", async () => {
    const modulePackage = {
      ...createModulePackageWithEntities(),
      moduleId: "module_packaged_board_truth_01",
      metadata: {
        ...createModulePackageWithEntities().metadata,
        title: "带预设地图的模组",
      },
    };
    const board: BoardV1 = {
      schemaVersion: 1,
      boardId: "packaged-board",
      revision: 1,
      kind: "map",
      name: "旧宅平面图",
      description: "",
      audience: { kind: "room" },
      logicalSize: { width: 1600, height: 900 },
      archived: false,
      items: [],
      edges: [],
      extensions: {},
    };
    await (await getRepository()).deleteModule(modulePackage.moduleId);
    const bytes = await createCocmodPackage(modulePackage, { boards: [{ id: board.boardId, value: board }] });
    const fileBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(fileBuffer).set(bytes);
    const file = new File([fileBuffer], "module-with-board.cocmod", { type: "application/zip" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => fileBuffer,
    });
    const view = render(<ModulesView />);
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="导入模组包文件"]');
    if (!input) throw new Error("module package input was not rendered");

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      const visibleError = view.container.querySelector(".text-red-300")?.textContent;
      if (visibleError) throw new Error(`cocmod import failed: ${visibleError}`);
      expect(useAppStore.getState().modules.some((item) => item.moduleId === modulePackage.moduleId)).toBe(true);
    });
    const reminders = await screen.findByLabelText("模组处理提醒");
    expect(reminders.textContent).toContain("已保存在这份备团资料中");
    expect(reminders.textContent).toContain("启用模组时不会自动复制到房间或公开");
    expect(reminders.textContent).toContain("再次导出时会原样保留");
    expect(reminders.textContent).not.toContain("已一并导入");
    await (await getRepository()).deleteModule(modulePackage.moduleId);
  });

  it("keeps a simulated draft visibly separate and prevents it from entering the library", async () => {
    render(<ModulesView />);
    fireEvent.change(screen.getByLabelText("粘贴原始模组文本"), {
      target: { value: "需要先校对的模组正文" },
    });
    fireEvent.click(screen.getByText("高级设置与测试工具"));
    fireEvent.click(screen.getByRole("button", { name: "使用模拟结果测试流程" }));
    const draftNotice = await screen.findByLabelText("模拟解析草稿");
    expect(within(draftNotice).getByText("模拟结果 · 未调用 Codex 或 DeepSeek")).not.toBeNull();
    expect(within(draftNotice).getByText(/不是真实解析结果，也不能保存或用于跑团/)).not.toBeNull();
    expect((within(draftNotice).getByRole("button", { name: "模拟结果不能保存" }) as HTMLButtonElement).disabled).toBe(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    fireEvent.click(screen.getByRole("button", { name: "使用模拟结果测试流程" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("重新整理模组会丢失这些修改"));
    expect(within(draftNotice).getByText("模拟结果 · 未调用 Codex 或 DeepSeek")).not.toBeNull();
    expect(screen.queryByLabelText("模组已保存")).toBeNull();
    expect(useAppStore.getState().modules).toHaveLength(0);
  });

  it("blocks main navigation and browser close until a parsed draft is saved", async () => {
    mockSuccessfulBrowserParse(createModulePackageWithEntities());
    useAppStore.setState({ activeView: "modules" });
    render(<ModulesView />);
    fireEvent.change(screen.getByLabelText("粘贴原始模组文本"), {
      target: { value: "离开页面前必须保存的模组正文" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始整理模组" }));

    const unsavedDraft = await screen.findByLabelText("未保存的解析草稿");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    useAppStore.getState().setActiveView("lobby");

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("整理结果或模组修改还没有正式保存"));
    expect(useAppStore.getState().activeView).toBe("modules");
    expect(within(unsavedDraft).getByText("AI 已整理完成 · 等你确认")).not.toBeNull();

    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    fireEvent.click(within(unsavedDraft).getByRole("button", { name: "确认并保存备团资料" }));
    await screen.findByLabelText("模组已保存");

    confirm.mockClear();
    useAppStore.getState().setActiveView("lobby");
    expect(confirm).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeView).toBe("lobby");
    const cleanBeforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanBeforeUnload);
    expect(cleanBeforeUnload.defaultPrevented).toBe(false);

    const savedModuleId = useAppStore.getState().modules[0]?.moduleId;
    if (savedModuleId) await (await getRepository()).deleteModule(savedModuleId);
  });

  it("carries a reviewed module into a new-room setup without claiming it is already active", async () => {
    const modulePackage = createModulePackageWithEntities();
    useAppStore.setState({ activeView: "modules", modules: [modulePackage] });
    render(<ModulesView />);

    fireEvent.click(screen.getByLabelText(`用这份模组开新团：${modulePackage.metadata.title}`));

    expect(useAppStore.getState().activeView).toBe("lobby");
    expect(useAppStore.getState().pendingRoomModule).toEqual({
      moduleId: modulePackage.moduleId,
      revision: modulePackage.revision,
      title: modulePackage.metadata.title,
    });
  });

  it("requires an explicit post-create confirmation before activating the pending module", async () => {
    const modulePackage = createModulePackageWithEntities();
    const submit = vi.fn(async () => undefined);
    const session = { isHost: true, submit } as unknown as RoomSession;
    useAppStore.setState({
      activeView: "modules",
      modules: [modulePackage],
      currentRoom: createRoom("host"),
      pendingRoomModule: {
        moduleId: modulePackage.moduleId,
        revision: modulePackage.revision,
        title: modulePackage.metadata.title,
      },
    });
    render(<ModulesView session={session} />);

    const handoff = screen.getByLabelText("新房间模组交接");
    expect(within(handoff).getByText(/模组尚未带入/)).not.toBeNull();
    expect(submit).not.toHaveBeenCalled();

    fireEvent.click(within(handoff).getByRole("button", { name: "确认使用并进入现场" }));

    await waitFor(() => expect(submit).toHaveBeenCalledWith("module.switch", {
      moduleId: modulePackage.moduleId,
      revision: modulePackage.revision,
      title: modulePackage.metadata.title,
    }));
    expect(useAppStore.getState().pendingRoomModule).toBeUndefined();
    expect(useAppStore.getState().activeView).toBe("room");
  });

  it("shows a bridge failure inside the parsing step", async () => {
    document.head.innerHTML = '<meta name="coc-room-local-ai-token" content="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">';
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("connection refused"));
    render(<ModulesView />);
    fireEvent.change(screen.getByLabelText("粘贴原始模组文本"), {
      target: { value: "待解析的模组正文" },
    });

    fireEvent.click(screen.getByRole("button", { name: "开始整理模组" }));

    const parserPanel = screen.getByLabelText("模组解析步骤");
    const alert = await within(parserPanel).findByRole("alert");
    expect(alert.textContent).toContain("原文和已选页没有丢失");
    expect(alert.textContent).toContain("无法连接本地 AI 桥");
    expect(within(alert).getByRole("button", { name: "重试整理" })).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "改用 DeepSeek" })).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "打开 AI 设置" })).toBeTruthy();
    expect((within(alert).getByText("查看失败原因").closest("details") as HTMLDetailsElement).open).toBe(false);
    expect((screen.getByLabelText("粘贴原始模组文本") as HTMLTextAreaElement).value).toBe("待解析的模组正文");
    expect(screen.queryByLabelText("未保存的解析草稿")).toBeNull();
  });

  it("switches provider after a text parse failure without clearing the prepared source", async () => {
    document.head.innerHTML = '<meta name="coc-room-local-ai-token" content="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">';
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("connection refused"));
    render(<ModulesView />);
    const source = screen.getByLabelText("粘贴原始模组文本") as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: "必须留在页面里的调查模组原文" } });
    fireEvent.click(screen.getByRole("button", { name: "开始整理模组" }));

    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "改用 DeepSeek" }));

    await waitFor(() => expect(useAppStore.getState().parserProvider).toBe("deepseek"));
    expect(source.value).toBe("必须留在页面里的调查模组原文");
    expect((await screen.findByRole("status")).textContent).toContain("原文和已选页仍保留");
    expect(screen.getByText(/当前解析服务：/).textContent).toContain("DeepSeek API");
    await (await getRepository()).setSetting("moduleParserProvider", "codex");
  });

  it("restores an uploaded PDF and selected visual pages after opening AI settings", async () => {
    document.head.innerHTML = '<meta name="coc-room-local-ai-token" content="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">';
    const bytes = new TextEncoder().encode("bounded-pdf-placeholder");
    const file = new File([bytes], "keeper-pages.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    const pages = [2, 4].map((pageNumber) => ({
      pageNumber,
      mediaType: "image/png" as const,
      sha256: String(pageNumber).repeat(64),
      byteLength: 8,
      width: 10,
      height: 20,
      dataBase64: "iVBORw0KGgo=",
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(`${JSON.stringify({ type: "result", pages })}\n`, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      }))
      .mockRejectedValueOnce(new TypeError("connection refused"));
    const first = render(<ModulesView />);
    const input = first.container.querySelector<HTMLInputElement>('input[aria-label="选择原始模组文本"]');
    if (!input) throw new Error("browser source input was not rendered");
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText(/已选择：keeper-pages\.pdf/);
    fireEvent.click(screen.getByText("高级设置与测试工具"));
    fireEvent.change(screen.getByLabelText("视觉检查页"), { target: { value: "2, 4" } });
    fireEvent.click(screen.getByRole("button", { name: "预览并选中" }));
    await screen.findByAltText("PDF 第 4 页");
    fireEvent.click(screen.getByRole("button", { name: "开始整理模组" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).queryByRole("button", { name: "改用 DeepSeek" })).toBeNull();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(within(alert).getByRole("button", { name: "打开 AI 设置" }));
    expect(useAppStore.getState().activeView).toBe("settings");
    expect(confirm).not.toHaveBeenCalled();

    first.unmount();
    useAppStore.getState().setActiveView("modules");
    render(<ModulesView />);

    expect(await screen.findByText(/已选择：keeper-pages\.pdf/)).not.toBeNull();
    expect((screen.getByLabelText("视觉检查页") as HTMLInputElement).value).toBe("2, 4");
    expect(screen.getByAltText("PDF 第 2 页")).not.toBeNull();
    expect(screen.getByAltText("PDF 第 4 页")).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("原文和已选页没有丢失");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops a browser parse through fetch cancellation without keeping a late draft", async () => {
    document.head.innerHTML = '<meta name="coc-room-local-ai-token" content="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">';
    let fetchSignal: AbortSignal | undefined;
    let abortCount = 0;
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
        fetchSignal?.addEventListener("abort", () => {
          abortCount += 1;
        }, { once: true });
      });
    });
    render(<ModulesView />);
    const source = screen.getByLabelText("粘贴原始模组文本") as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: "需要较长时间整理、但由 KP 主动停止的模组正文" } });
    fireEvent.click(screen.getByRole("button", { name: "开始整理模组" }));

    const stop = await screen.findByRole("button", { name: "停止整理" });
    fireEvent.click(stop);
    fireEvent.click(stop);
    expect(fetchSignal?.aborted).toBe(true);
    expect(abortCount).toBe(1);
    resolveFetch?.(new Response(`${JSON.stringify({ type: "result", module: createModulePackage() })}\n`, { status: 200 }));

    const stopped = await screen.findByRole("status");
    expect(stopped.textContent).toContain("已停止本次整理");
    expect(stopped.textContent).toContain("没有生成或保存新草稿");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(source.value).toContain("由 KP 主动停止");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByLabelText("未保存的解析草稿")).toBeNull();
    expect(screen.queryByLabelText("模组已保存")).toBeNull();
    expect(useAppStore.getState().modules).toHaveLength(0);
  });

  it("does not save or display an empty draft when Codex cannot reach its service", async () => {
    document.head.innerHTML = '<meta name="coc-room-local-ai-token" content="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">';
    const failure = {
      type: "error",
      message: "Codex network remained unavailable: private diagnostic",
      error: { code: "CODEX_NETWORK_UNAVAILABLE", retryable: false },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(`${JSON.stringify(failure)}\n`, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    }));
    render(<ModulesView />);
    fireEvent.change(screen.getByLabelText("粘贴原始模组文本"), {
      target: { value: "待解析但不应生成空草稿的模组正文" },
    });

    fireEvent.click(screen.getByRole("button", { name: "开始整理模组" }));

    const parserPanel = screen.getByLabelText("模组解析步骤");
    const alert = await within(parserPanel).findByRole("alert");
    expect(alert.textContent).toContain("Codex 暂时无法连接服务。请检查网络后重试");
    expect(alert.textContent).toContain("本次没有生成或保存空白模组");
    expect(alert.textContent).not.toContain("private diagnostic");
    expect(screen.queryByLabelText("未保存的解析草稿")).toBeNull();
    expect(screen.queryByLabelText("模组已保存")).toBeNull();
    expect(useAppStore.getState().modules).toHaveLength(0);
  });

  it("accepts a DOCX for the web local bridge without persisting a fake path", async () => {
    const { container } = render(<ModulesView />);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="选择原始模组文本"]');
    if (!input) throw new Error("browser source input was not rendered");
    const file = new File(["bounded-docx-placeholder"], "keeper-notes.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    fireEvent.change(input, { target: { files: [file] } });

    expect((await screen.findByText(/已选择：keeper-notes\.docx/)).textContent).toContain("只在本次整理中使用");
    expect(screen.queryByText(/C:\\/)).toBeNull();
  });

  it("imports, selects, and opens a cocmod with browsable locations and NPCs", async () => {
    const modulePackage = createModulePackageWithEntities();
    const { container } = render(<ModulesView />);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="导入模组包文件"]');
    if (!input) throw new Error("browser module input was not rendered");

    const content = JSON.stringify(modulePackage);
    const file = new File([content], "preview.cocmod.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => content });
    fireEvent.change(input, { target: { files: [file] } });

    const browser = await screen.findByLabelText(`${modulePackage.metadata.title}模组内容浏览`);
    const savedModule = screen.getByLabelText(`已保存模组：${modulePackage.metadata.title}`);
    expect(savedModule.getAttribute("aria-current")).toBe("true");
    const savedDirectory = within(savedModule).getByLabelText(`${modulePackage.metadata.title}人物与地点`);
    expect(within(savedDirectory).getByText("观止剧场")).not.toBeNull();
    expect(within(savedDirectory).getByText("花小路")).not.toBeNull();
    expect(screen.getByRole("tab", { name: "阅读备团资料" }).getAttribute("aria-selected")).toBe("true");
    expect(useAppStore.getState().modules).toHaveLength(1);
    expect(useAppStore.getState().modules[0]?.moduleId).toBe(modulePackage.moduleId);

    fireEvent.click(within(browser).getByRole("tab", { name: /^地点\s*1$/ }));
    expect(within(browser).getByText("观止剧场")).not.toBeNull();
    fireEvent.click(within(browser).getByRole("tab", { name: /^NPC\s*1$/ }));
    expect(within(browser).getByText("花小路")).not.toBeNull();
  });

  it("scrolls to a newly opened workbench without jumping on every edit", async () => {
    const previousScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    try {
      const modulePackage = createModulePackageWithEntities();
      const { container } = render(<ModulesView />);
      const input = container.querySelector<HTMLInputElement>('input[aria-label="导入模组包文件"]');
      if (!input) throw new Error("browser module input was not rendered");
      const content = JSON.stringify(modulePackage);
      const file = new File([content], "scroll-test.cocmod.json", { type: "application/json" });
      Object.defineProperty(file, "text", { value: async () => content });
      fireEvent.change(input, { target: { files: [file] } });

      await screen.findByLabelText(`${modulePackage.metadata.title}模组内容浏览`);
      expect(scrollIntoView).toHaveBeenCalled();
      const callsAfterOpen = scrollIntoView.mock.calls.length;
      fireEvent.click(screen.getByRole("tab", { name: "检查并修正" }));
      fireEvent.click(screen.getByRole("button", { name: "基本信息" }));
      fireEvent.change(screen.getByLabelText("模组简介"), { target: { value: "编辑时不应跳动" } });
      expect(scrollIntoView).toHaveBeenCalledTimes(callsAfterOpen);
    } finally {
      if (previousScroll) Object.defineProperty(Element.prototype, "scrollIntoView", previousScroll);
      else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("upgrades an older import from repository state and preserves its local source", async () => {
    const repository = await getRepository();
    const moduleId = "module_revision_upgrade_01";
    const existing = {
      ...createModulePackage(),
      moduleId,
      revision: 4,
      metadata: {
        ...createModulePackage().metadata,
        title: "旧版模组",
        updatedAt: "2026-08-27T01:00:00.000Z",
      },
    };
    await repository.saveModule({ package: existing, sourceText: "本机保存的原始模组正文" });

    const incoming = {
      ...createModulePackageWithEntities(),
      moduleId,
      revision: 2,
      metadata: {
        ...createModulePackageWithEntities().metadata,
        title: "新版导入内容",
      },
    };
    const { container } = render(<ModulesView />);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="导入模组包文件"]');
    if (!input) throw new Error("browser module input was not rendered");
    const content = JSON.stringify(incoming);
    const file = new File([content], "older-revision.cocmod.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => content });
    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByLabelText(`${incoming.metadata.title}模组内容浏览`);
    const imported = useAppStore.getState().modules.find((item) => item.moduleId === moduleId);
    expect(imported?.revision).toBe(5);
    expect(imported?.locations[0]?.name).toBe("观止剧场");
    expect(imported?.npcs[0]?.name).toBe("花小路");
    const stored = (await repository.listModules()).find((item) => item.package.moduleId === moduleId);
    expect(stored?.sourceText).toBe("本机保存的原始模组正文");

    const newerContent = JSON.stringify({
      ...incoming,
      revision: 12,
      metadata: { ...incoming.metadata, title: "上游高版本内容" },
    });
    const newerFile = new File([newerContent], "newer-revision.cocmod.json", { type: "application/json" });
    Object.defineProperty(newerFile, "text", { value: async () => newerContent });
    fireEvent.change(input, { target: { files: [newerFile] } });

    await screen.findByLabelText("上游高版本内容模组内容浏览");
    expect(useAppStore.getState().modules.find((item) => item.moduleId === moduleId)?.revision).toBe(12);
  });

  it("opens, exports, edits, and deletes exact historical revisions without overwriting them", async () => {
    const repository = await getRepository();
    const moduleId = "module_ui_revision_history_01";
    const revisionOne = {
      ...createModulePackageWithEntities(),
      moduleId,
      metadata: {
        ...createModulePackageWithEntities().metadata,
        title: "历史修订",
        updatedAt: "2026-08-25T00:00:00.000Z",
      },
    };
    const revisionTwo = {
      ...revisionOne,
      revision: 2,
      overview: "第二版概览",
      metadata: {
        ...revisionOne.metadata,
        title: "当前修订",
        updatedAt: "2026-08-26T00:00:00.000Z",
      },
    };
    await repository.saveModule({ package: revisionOne, sourceText: "source v1" });
    await repository.saveModule({ package: revisionTwo, sourceText: "source v2" });
    useAppStore.setState({ modules: [revisionTwo] });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<ModulesView />);
    fireEvent.click(await screen.findByText("历史版本、导出与删除"));
    fireEvent.click(screen.getByLabelText("打开历史修订 v1"));
    await screen.findByLabelText("历史修订模组内容浏览");
    expect(screen.getByText("你正在查看已经保存的备团资料；修改后会保留原来的内容作为历史版本。")).not.toBeNull();

    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const createObjectUrl = vi.fn((_blob: Blob) => "blob:module-history-test");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    let downloadedName = "";
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadedName = this.download;
    });
    try {
      fireEvent.click(screen.getByLabelText("导出历史修订 v1"));
      await waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(1));
      const exported = createObjectUrl.mock.calls[0]![0];
      expect(exported.type).toBe("application/vnd.coc-room.module+zip");
      expect(downloadedName).toMatch(/-v1\.cocmod$/);
    } finally {
      anchorClick.mockRestore();
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectUrl });
    }

    fireEvent.click(screen.getByText("高级数据", { exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "编辑底层 JSON" }));
    const edited = { ...revisionOne, overview: "从历史版本产生的新修订" };
    fireEvent.change(screen.getByPlaceholderText("高级：在这里查看或编辑模组的底层 JSON 数据。"), {
      target: { value: JSON.stringify(edited) },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(async () => {
      expect((await repository.getModule(moduleId))?.package.revision).toBe(3);
    });
    expect((await repository.listModules({ moduleId, latestOnly: false })).map((item) => item.package.revision))
      .toEqual([3, 2, 1]);
    expect((await repository.getModule(moduleId, 1))?.package.overview).toBe("");

    const updatedCard = await screen.findByLabelText("已保存模组：历史修订");
    fireEvent.click(within(updatedCard).getByText("历史版本、导出与删除"));
    await within(updatedCard).findByText("第 3 版 · 最新");
    fireEvent.click(within(updatedCard).getByLabelText("删除历史修订 v1"));
    await waitFor(async () => expect(await repository.getModule(moduleId, 1)).toBeUndefined());
    expect((await repository.listModules({ moduleId, latestOnly: false })).map((item) => item.package.revision))
      .toEqual([3, 2]);

    fireEvent.click(screen.getByLabelText("删除整个模组：历史修订"));
    await waitFor(async () => expect(await repository.getModule(moduleId)).toBeUndefined());
  });
});

describe("ModulesView room publishing controls", () => {
  it("hands a newly reviewed draft straight to the current room without a version-selection detour", async () => {
    mockSuccessfulBrowserParse(createModulePackageWithEntities());
    const submit = vi.fn(async () => undefined);
    const session = { isHost: true, submit } as unknown as RoomSession;
    useAppStore.setState({ currentRoom: createRoom("host") });
    render(<ModulesView session={session} />);

    fireEvent.change(screen.getByLabelText("粘贴原始模组文本"), {
      target: { value: "调查员在雨夜来到旧剧场，寻找失踪的演员。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始整理模组" }));
    const draftNotice = await screen.findByLabelText("未保存的解析草稿");
    fireEvent.click(within(draftNotice).getByRole("button", { name: "确认并保存备团资料" }));

    const saved = await screen.findByLabelText("模组已保存");
    expect(within(saved).getByText(/最后一步：把它用于当前房间/)).not.toBeNull();
    fireEvent.click(within(saved).getByRole("button", { name: /用于本次跑团/ }));

    const modulePackage = useAppStore.getState().modules[0]!;
    await waitFor(() => expect(submit).toHaveBeenCalledWith("module.switch", {
      moduleId: modulePackage.moduleId,
      revision: modulePackage.revision,
      title: modulePackage.metadata.title,
    }));
    useAppStore.getState().setEvents([createModuleSwitchedEvent(modulePackage)]);
    await waitFor(() => expect(within(screen.getByLabelText("模组准备进度")).getByText("用于跑团").closest("li")?.getAttribute("aria-current")).toBe("step"));

    await (await getRepository()).deleteModule(modulePackage.moduleId);
  });

  it("returns to a V2 room only after the host-confirmed module switch succeeds", async () => {
    const modulePackage = createModulePackageWithEntities();
    let confirmSwitch!: (commandId: string) => void;
    const submit = vi.fn(() => new Promise<string>((resolve) => { confirmSwitch = resolve; }));
    const session = createV2HostSession(submit);
    useAppStore.setState({
      activeView: "modules",
      modules: [modulePackage],
      currentRoom: createV2HostRoom(),
    });
    render(<ModulesView session={session} />);

    fireEvent.click(await screen.findByLabelText(`用于本次跑团并回到现场：${modulePackage.metadata.title}`));

    expect(useAppStore.getState().activeView).toBe("modules");
    expect(submit).toHaveBeenCalledWith({
      type: "module.switched",
      audience: { kind: "room" },
      payload: {
        moduleId: modulePackage.moduleId,
        revision: modulePackage.revision,
        title: modulePackage.metadata.title,
      },
    });

    confirmSwitch("module-switch-command");
    await waitFor(() => expect(useAppStore.getState().activeView).toBe("room"));
  });

  it("can activate a V2 room module while deliberately staying in the preparation workbench", async () => {
    const modulePackage = createModulePackageWithEntities();
    const submit = vi.fn(async () => "module-switch-command");
    const session = createV2HostSession(submit);
    useAppStore.setState({
      activeView: "modules",
      modules: [modulePackage],
      currentRoom: createV2HostRoom(),
    });
    render(<ModulesView session={session} />);

    fireEvent.click(await screen.findByLabelText(`用于本次跑团，继续备团：${modulePackage.metadata.title}`));

    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(useAppStore.getState().activeView).toBe("modules");
  });

  it("keeps the V2 keeper in the module workbench and shows the error when switching fails", async () => {
    const modulePackage = createModulePackageWithEntities();
    const submit = vi.fn().mockRejectedValue(new Error("房间拒绝了这次模组切换"));
    const session = createV2HostSession(submit);
    useAppStore.setState({
      activeView: "modules",
      modules: [modulePackage],
      currentRoom: createV2HostRoom(),
    });
    render(<ModulesView session={session} />);

    fireEvent.click(await screen.findByLabelText(`用于本次跑团并回到现场：${modulePackage.metadata.title}`));

    expect(await screen.findByText("房间拒绝了这次模组切换")).not.toBeNull();
    expect(useAppStore.getState().activeView).toBe("modules");
  });

  it("offers an explicit return to the scene after the saved module is already active", async () => {
    const modulePackage = createModulePackageWithEntities();
    const session = createV2HostSession(vi.fn(), modulePackage);
    useAppStore.setState({
      activeView: "modules",
      modules: [modulePackage],
      currentRoom: createV2HostRoom(),
    });
    render(<ModulesView session={session} />);

    const saved = await screen.findByLabelText("模组已保存");
    fireEvent.click(within(saved).getByRole("button", { name: "回到现场" }));

    expect(useAppStore.getState().activeView).toBe("room");
  });

  it("lets an online host switch modules and publishes only player-visible clue/handout text", async () => {
    const modulePackage = createModulePackageWithPublicContent();
    const submit = vi.fn(async () => undefined);
    const session = { isHost: true, submit } as unknown as RoomSession;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    useAppStore.setState({ modules: [modulePackage], currentRoom: createRoom("host") });
    render(<ModulesView session={session} />);

    fireEvent.click(screen.getByLabelText(`用于本次跑团：${modulePackage.metadata.title}`));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("module.switch", {
      moduleId: modulePackage.moduleId,
      revision: modulePackage.revision,
      title: modulePackage.metadata.title,
    }));
    await screen.findByLabelText(`${modulePackage.metadata.title}模组内容浏览`);
    expect(screen.queryByLabelText("公开线索：可公开线索")).toBeNull();
    expect(screen.getByText(/房间当前没有使用你正在查看的这份资料/)).not.toBeNull();

    useAppStore.getState().setEvents([
      createModuleSwitchedEvent(modulePackage),
      createLocationPublishedEvent(modulePackage),
    ]);
    await screen.findByLabelText("房间内容公开");
    fireEvent.change(screen.getByLabelText("公开内容关联地点"), {
      target: { value: "location-public" },
    });

    submit.mockClear();
    fireEvent.click(screen.getByLabelText("公开线索：可公开线索"));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("content.reveal", {
      moduleId: modulePackage.moduleId,
      revision: modulePackage.revision,
      contentId: "clue-public",
      contentType: "clue",
      title: "可公开线索",
      body: "玩家可见的线索正文",
      locationId: "location-public",
    }));

    submit.mockClear();
    fireEvent.click(screen.getByLabelText("公开手记：玩家手记"));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("content.reveal", {
      moduleId: modulePackage.moduleId,
      revision: modulePackage.revision,
      contentId: "handout-public",
      contentType: "handout",
      title: "玩家手记",
      body: "玩家可见的手记正文",
      locationId: "location-public",
    }));
  });

  it("disables an empty revealText and never falls back to the keeper description", async () => {
    const modulePackage = createModulePackageWithPublicContent();
    const submit = vi.fn(async () => undefined);
    const session = { isHost: true, submit } as unknown as RoomSession;
    useAppStore.setState({
      modules: [modulePackage],
      currentRoom: createRoom("host"),
      events: [createModuleSwitchedEvent(modulePackage)],
    });
    render(<ModulesView session={session} />);
    await screen.findByLabelText("房间内容公开");

    const button = screen.getByLabelText("公开线索：未公开线索") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).not.toContain("守秘人专用描述，绝不能公开");
    fireEvent.click(button);
    expect(submit).not.toHaveBeenCalled();
  });

  it("updates the existing V2 NPC snapshot without erasing scene presentation or NPC data", async () => {
    const modulePackage = {
      ...createModulePackageWithEntities(),
      npcs: createModulePackageWithEntities().npcs.map((npc) => ({
        ...npc,
        playerDescription: "她把湿伞靠在剧场门边。",
      })),
    };
    const existing: RoomEntityV2 = {
      schemaVersion: 2,
      entityId: "npc-room-hana",
      revision: 4,
      kind: "npc",
      name: "花小路（旧介绍）",
      description: "旧的玩家可见说明",
      artifactIds: ["artifact-hana-portrait"],
      audience: { kind: "room" },
      data: {
        sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "npc", id: "npc-hana" },
        presentedInSceneEntityIds: ["scene-theater"],
        character: { hitPoints: 8, sanity: 42 },
      },
      extensions: { "org.coc-room.npc-stats.v1": { confirmed: true } },
    };
    const submit = vi.fn(async () => "entity-update");
    const session = createV2HostSession(submit, modulePackage, {
      entities: new Map([[existing.entityId, existing]]),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    useAppStore.setState({ modules: [modulePackage], currentRoom: createV2HostRoom() });
    render(<ModulesView session={session} />);

    const publishing = await screen.findByLabelText("地点和人物公开");
    fireEvent.click(within(publishing).getByRole("button", { name: /NPC：花小路/ }));

    await waitFor(() => expect(submit).toHaveBeenCalledWith({
      type: "entity.upserted",
      audience: { kind: "room" },
      payload: {
        entity: expect.objectContaining({
          entityId: existing.entityId,
          revision: 5,
          name: "花小路",
          description: "她把湿伞靠在剧场门边。",
          artifactIds: ["artifact-hana-portrait"],
          data: expect.objectContaining({
            presentedInSceneEntityIds: ["scene-theater"],
            character: { hitPoints: 8, sanity: 42 },
          }),
          extensions: { "org.coc-room.npc-stats.v1": { confirmed: true } },
        }),
      },
    }));
  });

  it("updates one source-matched V2 clue artifact instead of creating duplicate reveals", async () => {
    const modulePackage = createModulePackageWithPublicContent();
    const attachment = {
      schemaVersion: 1 as const,
      assetId: `sha256:${"b".repeat(64)}`,
      mediaType: "image/webp",
      byteLength: 1_024,
      width: 640,
      height: 360,
    };
    const existing: RoomArtifactV2 = {
      schemaVersion: 2,
      artifactId: "artifact-public-clue",
      revision: 3,
      kind: "clue",
      title: "旧线索标题",
      description: "玩家整理的备注",
      body: "旧正文",
      attachments: [attachment],
      audience: { kind: "room" },
      locked: false,
      archived: false,
      extensions: {
        sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "clue", id: "clue-public" },
        playerLayout: { column: 1 },
      },
    };
    const submit = vi.fn(async () => "artifact-update");
    const session = createV2HostSession(submit, modulePackage, {
      artifacts: new Map([[existing.artifactId, existing]]),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    useAppStore.setState({ modules: [modulePackage], currentRoom: createV2HostRoom() });
    render(<ModulesView session={session} />);

    await screen.findByLabelText("房间内容公开");
    expect(screen.queryByLabelText("公开内容关联地点")).toBeNull();
    expect(screen.queryByText(/同时出现在该地点舞台/)).toBeNull();
    fireEvent.click(screen.getByLabelText("公开线索：可公开线索"));

    await waitFor(() => expect(submit).toHaveBeenCalledWith({
      type: "artifact.upserted",
      audience: { kind: "room" },
      payload: {
        artifact: expect.objectContaining({
          artifactId: existing.artifactId,
          revision: 4,
          title: "可公开线索",
          body: "玩家可见的线索正文",
          description: "玩家整理的备注",
          attachments: [attachment],
          extensions: {
            sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "clue", id: "clue-public" },
            playerLayout: { column: 1 },
          },
        }),
      },
    }));
  });

  it("hides switching and publishing controls from players", () => {
    const modulePackage = createModulePackageWithPublicContent();
    const session = { isHost: false, submit: vi.fn() } as unknown as RoomSession;
    useAppStore.setState({ modules: [modulePackage], currentRoom: createRoom("player") });
    render(<ModulesView session={session} />);

    expect(screen.queryByLabelText(`用于本次跑团：${modulePackage.metadata.title}`)).toBeNull();
    expect(screen.queryByLabelText("公开线索：可公开线索")).toBeNull();
    expect(screen.queryByLabelText("公开手记：玩家手记")).toBeNull();
  });

  it("hides switching and publishing controls while the host is offline", () => {
    const modulePackage = createModulePackageWithPublicContent();
    useAppStore.setState({ modules: [modulePackage], currentRoom: createRoom("host") });
    render(<ModulesView />);

    expect(screen.queryByLabelText(`用于本次跑团：${modulePackage.metadata.title}`)).toBeNull();
    expect(screen.queryByLabelText("公开线索：可公开线索")).toBeNull();
    expect(screen.queryByLabelText("公开手记：玩家手记")).toBeNull();
  });
});

function mockSuccessfulBrowserParse(
  modulePackage: ModulePackageV1,
  extras: Record<string, unknown> = {},
) {
  document.head.innerHTML = '<meta name="coc-room-local-ai-token" content="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">';
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(`${JSON.stringify({
    request_id: "module-view-real-parse",
    type: "result",
    module: modulePackage,
    normalizedText: "经本地安全桥整理的模组原文",
    issues: [],
    warnings: [],
    usage: { calls: 1 },
    ...extras,
  })}\n`, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  }));
}

function createModulePackage(): ModulePackageV1 {
  const timestamp = "2026-08-27T00:00:00.000Z";
  return {
    schemaVersion: 1,
    moduleId: "module_preview_import_01",
    revision: 1,
    metadata: {
      title: "导入测试模组",
      authors: [],
      language: "zh-CN",
      summary: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    overview: "",
    sourceDocuments: [],
    chapters: [],
    scenes: [],
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

function createModulePackageWithEntities(): ModulePackageV1 {
  return {
    ...createModulePackage(),
    locations: [
      {
        id: "location-theater",
        name: "观止剧场",
        description: "调查开始的剧场。",
        aliases: ["剧场"],
        sourceRefs: [],
      },
    ],
    npcs: [
      {
        id: "npc-hana",
        name: "花小路",
        description: "剧场中的关键人物。",
        role: "剧场演员",
        motivation: "寻找失踪的同伴",
        traits: ["谨慎"],
        sourceRefs: [],
      },
    ],
  };
}

function createModulePackageWithPublicContent(): ModulePackageV1 {
  return {
    ...createModulePackage(),
    moduleId: "module_public_content_01",
    metadata: {
      ...createModulePackage().metadata,
      title: "公开内容测试模组",
    },
    locations: [{
      id: "location-public",
      name: "公开书房",
      description: "KP 私密地点说明",
      playerDescription: "一间安静的旧书房。",
      aliases: [],
      sourceRefs: [],
    }],
    clues: [
      {
        id: "clue-private",
        name: "未公开线索",
        description: "守秘人专用描述，绝不能公开",
        revealText: "   ",
        isCore: true,
        sourceRefs: [],
      },
      {
        id: "clue-public",
        name: "可公开线索",
        description: "守秘人补充说明，不应进入公开事件",
        revealText: "玩家可见的线索正文",
        isCore: false,
        sourceRefs: [],
      },
    ],
    handouts: [
      {
        id: "handout-public",
        name: "手记实体",
        title: "玩家手记",
        description: "守秘人手记说明，不应进入公开事件",
        content: "玩家可见的手记正文",
        sourceRefs: [],
      },
    ],
  };
}

function createModuleSwitchedEvent(modulePackage: ModulePackageV1): RoomEventV1 {
  return {
    protocolVersion: 1,
    roomId: "room-module-test",
    eventId: "00000000-0000-4000-8000-000000000001",
    sequence: 1,
    sender: { peerId: "host-peer", displayName: "守秘人", role: "host" },
    occurredAt: "2026-08-27T00:00:00.000Z",
    type: "module.switched",
    payload: {
      moduleId: modulePackage.moduleId,
      revision: modulePackage.revision,
      title: modulePackage.metadata.title,
    },
  };
}

function createLocationPublishedEvent(modulePackage: ModulePackageV1): RoomEventV1 {
  return {
    protocolVersion: 1,
    roomId: "room-module-test",
    eventId: "00000000-0000-4000-8000-000000000002",
    sequence: 2,
    sender: { peerId: "host-peer", displayName: "守秘人", role: "host" },
    occurredAt: "2026-08-27T00:01:00.000Z",
    type: "location.published",
    payload: {
      moduleId: modulePackage.moduleId,
      revision: modulePackage.revision,
      location: {
        id: "location-public",
        name: "公开书房",
        description: "一间安静的旧书房。",
      },
    },
  };
}

function createRoom(localRole: "host" | "player"): RoomRecord {
  return {
    id: "room-module-test",
    name: "模组测试房间",
    localRole,
    localPeerId: localRole === "host" ? "host-peer" : "player-peer",
    hostPeerId: "host-peer",
    inviteToken: "01234567890123456789012345678901",
    joinToken: localRole === "player" ? "abcdefghijklmnopqrstuvwxyz123456" : undefined,
    relayUrl: "ws://127.0.0.1:8787/v1/rooms/room-module-test/ws",
    lastSeq: 0,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

function createV2HostRoom(): RoomRecord {
  return {
    ...createRoom("host"),
    protocolVersion: 2,
    localSeatId: "seat-host",
    hostSeatId: "seat-host",
    seatCredentialVersion: 1,
  };
}

function createV2HostSession(
  submit: (...args: unknown[]) => Promise<unknown>,
  activeModule?: ModulePackageV1,
  world: {
    entities?: ReadonlyMap<string, RoomEntityV2>;
    artifacts?: ReadonlyMap<string, RoomArtifactV2>;
  } = {},
): RoomSessionV2 {
  const session = Object.create(RoomSessionV2.prototype) as RoomSessionV2;
  Object.defineProperties(session, {
    localSeat: {
      value: {
        seatId: "seat-host",
        role: "host",
        displayName: "守秘人",
        peerId: "host-peer",
        extensions: {},
      },
    },
    world: {
      value: {
        activeModule: activeModule ? {
          moduleId: activeModule.moduleId,
          revision: activeModule.revision,
          title: activeModule.metadata.title,
        } : undefined,
        entities: world.entities ?? new Map(),
        artifacts: world.artifacts ?? new Map(),
      },
    },
    submit: { value: submit },
  });
  return session;
}
