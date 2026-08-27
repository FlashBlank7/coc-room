// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModulePackageV1 } from "@coc-room/protocol";
import type { RoomRecord } from "../data/repository";
import type { RoomSession } from "../network/RoomSession";
import { useAppStore } from "../store/app-store";
import { ModulesView } from "./ModulesView";

afterEach(() => {
  cleanup();
  useAppStore.setState({ modules: [], currentRoom: undefined });
  vi.restoreAllMocks();
});

describe("ModulesView browser import", () => {
  it("imports a cocmod JSON file into the preview repository", async () => {
    const modulePackage = createModulePackage();
    const { container } = render(<ModulesView />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("browser module input was not rendered");

    const content = JSON.stringify(modulePackage);
    const file = new File([content], "preview.cocmod.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => content });
    fireEvent.change(input, { target: { files: [file] } });

    expect((await screen.findAllByText(modulePackage.metadata.title)).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("tab", { name: "资料浏览" }).getAttribute("aria-selected")).toBe("true");
    expect(useAppStore.getState().modules).toHaveLength(1);
    expect(useAppStore.getState().modules[0]?.moduleId).toBe(modulePackage.moduleId);
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
