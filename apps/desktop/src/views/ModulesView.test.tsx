// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModulePackageV1 } from "@coc-room/protocol";
import { getRepository, type RoomRecord } from "../data/repository";
import type { RoomSession } from "../network/RoomSession";
import { useAppStore } from "../store/app-store";
import { ModulesView } from "./ModulesView";

afterEach(() => {
  cleanup();
  useAppStore.setState({ modules: [], currentRoom: undefined });
  vi.restoreAllMocks();
});

describe("ModulesView browser import", () => {
  it("imports, selects, and opens a cocmod with browsable locations and NPCs", async () => {
    const modulePackage = createModulePackageWithEntities();
    const { container } = render(<ModulesView />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("browser module input was not rendered");

    const content = JSON.stringify(modulePackage);
    const file = new File([content], "preview.cocmod.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => content });
    fireEvent.change(input, { target: { files: [file] } });

    const browser = await screen.findByLabelText(`${modulePackage.metadata.title}模组内容浏览`);
    expect(screen.getByLabelText(`已保存模组：${modulePackage.metadata.title}`).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("tab", { name: "资料浏览" }).getAttribute("aria-selected")).toBe("true");
    expect(useAppStore.getState().modules).toHaveLength(1);
    expect(useAppStore.getState().modules[0]?.moduleId).toBe(modulePackage.moduleId);

    fireEvent.click(within(browser).getByRole("tab", { name: /^地点\s*1$/ }));
    expect(within(browser).getByText("观止剧场")).not.toBeNull();
    fireEvent.click(within(browser).getByRole("tab", { name: /^NPC\s*1$/ }));
    expect(within(browser).getByText("花小路")).not.toBeNull();
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
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
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
    fireEvent.click(await screen.findByText("修订历史 · 2 个版本"));
    fireEvent.click(screen.getByLabelText("打开历史修订 v1"));
    await screen.findByLabelText("历史修订模组内容浏览");
    expect(screen.getByText("当前打开 v1；修改后会另存为新的修订。")).not.toBeNull();

    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const createObjectUrl = vi.fn((_blob: Blob) => "blob:module-history-test");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    try {
      fireEvent.click(screen.getByLabelText("导出历史修订 v1"));
      await waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(1));
      const exported = createObjectUrl.mock.calls[0]![0];
      const exportedText = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(exported);
      });
      expect(JSON.parse(exportedText).revision).toBe(1);
    } finally {
      anchorClick.mockRestore();
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectUrl });
    }

    fireEvent.click(screen.getByRole("tab", { name: "JSON 编辑" }));
    const edited = { ...revisionOne, overview: "从历史版本产生的新修订" };
    fireEvent.change(screen.getByPlaceholderText("解析结果会出现在这里，也可以粘贴 ModulePackageV1 JSON。"), {
      target: { value: JSON.stringify(edited) },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));

    await waitFor(async () => {
      expect((await repository.getModule(moduleId))?.package.revision).toBe(3);
    });
    expect((await repository.listModules({ moduleId, latestOnly: false })).map((item) => item.package.revision))
      .toEqual([3, 2, 1]);
    expect((await repository.getModule(moduleId, 1))?.package.overview).toBe("");

    const updatedCard = await screen.findByLabelText("已保存模组：历史修订");
    await within(updatedCard).findByText("修订历史 · 3 个版本");
    fireEvent.click(within(updatedCard).getByLabelText("删除历史修订 v1"));
    await waitFor(async () => expect(await repository.getModule(moduleId, 1)).toBeUndefined());
    expect((await repository.listModules({ moduleId, latestOnly: false })).map((item) => item.package.revision))
      .toEqual([3, 2]);

    fireEvent.click(screen.getByLabelText("删除整个模组：历史修订"));
    await waitFor(async () => expect(await repository.getModule(moduleId)).toBeUndefined());
  });
});

describe("ModulesView room publishing controls", () => {
  it("lets an online host switch modules and publishes only player-visible clue/handout text", async () => {
    const modulePackage = createModulePackageWithPublicContent();
    const submit = vi.fn(async () => undefined);
    const session = { isHost: true, submit } as unknown as RoomSession;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    useAppStore.setState({ modules: [modulePackage], currentRoom: createRoom("host") });
    render(<ModulesView session={session} />);

    fireEvent.click(screen.getByLabelText(`切换房间模组：${modulePackage.metadata.title}`));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("module.switch", {
      moduleId: modulePackage.moduleId,
      revision: modulePackage.revision,
      title: modulePackage.metadata.title,
    }));

    submit.mockClear();
    fireEvent.click(screen.getByLabelText("公开线索：可公开线索"));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("content.reveal", {
      moduleId: modulePackage.moduleId,
      revision: modulePackage.revision,
      contentId: "clue-public",
      contentType: "clue",
      title: "可公开线索",
      body: "玩家可见的线索正文",
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
    }));
  });

  it("disables an empty revealText and never falls back to the keeper description", () => {
    const modulePackage = createModulePackageWithPublicContent();
    const submit = vi.fn(async () => undefined);
    const session = { isHost: true, submit } as unknown as RoomSession;
    useAppStore.setState({ modules: [modulePackage], currentRoom: createRoom("host") });
    render(<ModulesView session={session} />);

    const button = screen.getByLabelText("公开线索：未公开线索") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).not.toContain("守秘人专用描述，绝不能公开");
    fireEvent.click(button);
    expect(submit).not.toHaveBeenCalled();
  });

  it("hides switching and publishing controls from players", () => {
    const modulePackage = createModulePackageWithPublicContent();
    const session = { isHost: false, submit: vi.fn() } as unknown as RoomSession;
    useAppStore.setState({ modules: [modulePackage], currentRoom: createRoom("player") });
    render(<ModulesView session={session} />);

    expect(screen.queryByLabelText(`切换房间模组：${modulePackage.metadata.title}`)).toBeNull();
    expect(screen.queryByLabelText("公开线索：可公开线索")).toBeNull();
    expect(screen.queryByLabelText("公开手记：玩家手记")).toBeNull();
  });

  it("hides switching and publishing controls while the host is offline", () => {
    const modulePackage = createModulePackageWithPublicContent();
    useAppStore.setState({ modules: [modulePackage], currentRoom: createRoom("host") });
    render(<ModulesView />);

    expect(screen.queryByLabelText(`切换房间模组：${modulePackage.metadata.title}`)).toBeNull();
    expect(screen.queryByLabelText("公开线索：可公开线索")).toBeNull();
    expect(screen.queryByLabelText("公开手记：玩家手记")).toBeNull();
  });
});

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
