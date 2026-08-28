// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModulePackageV1 } from "@coc-room/protocol";

import { KeeperSceneControls } from "./KeeperSceneControls";
import type { PublishedRoomLocation } from "./RoomWorldStage";

afterEach(cleanup);

describe("KeeperSceneControls", () => {
  it("shows every module location, scene context, and both related and unrelated NPCs", () => {
    renderControls();

    expect(screen.getByRole("button", { name: "选择地点：观止剧场" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "选择地点：无名庭院" })).toBeTruthy();
    expect(screen.getByText("开幕场景")).toBeTruthy();
    expect(screen.getByText("调查员在剧场第一次见到演员。")).toBeTruthy();

    const npcDirectory = screen.getByLabelText("在观止剧场发布 NPC");
    expect(within(npcDirectory).getByText("关联 NPC · 1")).toBeTruthy();
    expect(within(npcDirectory).getByText("其他 NPC · 2")).toBeTruthy();
    expect(within(npcDirectory).getByText("花小路")).toBeTruthy();
    expect(within(npcDirectory).getByText("木村晃")).toBeTruthy();
    expect(within(npcDirectory).getByText("无公开稿人物")).toBeTruthy();
    expect(screen.getByText(/持久同步给全体成员/)).toBeTruthy();

    fireEvent.change(within(npcDirectory).getByLabelText("筛选 NPC"), {
      target: { value: "木村" },
    });
    expect(within(npcDirectory).getByText("木村晃")).toBeTruthy();
    expect(within(npcDirectory).queryByText("花小路")).toBeNull();
  });

  it("publishes a location using only playerDescription", () => {
    const onPublishLocation = vi.fn();
    renderControls({ onPublishLocation });

    expect(screen.getByText("KP 私密：这里其实是绑架现场。")).toBeTruthy();
    expect(screen.getByText("玩家公开：帷幕后传来木板轻响。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "向全房间公开地点" }));

    expect(onPublishLocation).toHaveBeenCalledWith({
      id: "location-theater",
      name: "观止剧场",
      description: "玩家公开：帷幕后传来木板轻响。",
    });
    expect(JSON.stringify(onPublishLocation.mock.calls[0])).not.toContain("绑架现场");
  });

  it("never falls back to keeper location text when playerDescription is absent", () => {
    const onPublishLocation = vi.fn();
    renderControls({ onPublishLocation });

    fireEvent.click(screen.getByRole("button", { name: "选择地点：无名庭院" }));
    const card = screen.getByLabelText("地点发布：无名庭院");
    expect(within(card).getByText("KP 私密：庭院地下埋着遗体。")).toBeTruthy();
    expect(within(card).getByText(/不会使用上方守秘人资料作为后备文本/)).toBeTruthy();
    expect((within(card).getByRole("button", { name: "向全房间公开地点" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onPublishLocation).not.toHaveBeenCalled();
  });

  it("publishes an NPC only to a published location and only with playerDescription", () => {
    const publicLocation: PublishedRoomLocation = {
      id: "location-theater",
      name: "观止剧场",
      description: "玩家公开：帷幕后传来木板轻响。",
    };
    const onPublishNpc = vi.fn();
    renderControls({
      publishedLocations: new Map([[publicLocation.id, publicLocation]]),
      onPublishNpc,
    });

    fireEvent.click(screen.getByRole("button", { name: "发布 NPC：花小路" }));
    expect(onPublishNpc).toHaveBeenCalledWith(publicLocation, {
      id: "npc-hana",
      name: "花小路",
      description: "玩家公开：她的笑容有些勉强。",
    });
    expect(JSON.stringify(onPublishNpc.mock.calls[0])).not.toContain("知道凶手身份");

    const unavailable = screen.getByRole("button", { name: "发布 NPC：无公开稿人物" }) as HTMLButtonElement;
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.title).toContain("玩家可见描述");
  });

  it("marks an NPC already at the location and disables duplicate publication", () => {
    const publicLocation: PublishedRoomLocation = {
      id: "location-theater",
      name: "观止剧场",
      description: "公开剧场",
    };
    const onPublishNpc = vi.fn();
    renderControls({
      publishedLocations: new Map([[publicLocation.id, publicLocation]]),
      npcsByLocation: new Map([[publicLocation.id, new Map([[
        "npc-hana",
        { id: "npc-hana", name: "花小路", description: "玩家公开：她的笑容有些勉强。" },
      ]])]]),
      onPublishNpc,
    });

    const button = screen.getByRole("button", { name: "发布 NPC：花小路" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("已在此地");
    fireEvent.click(button);
    expect(onPublishNpc).not.toHaveBeenCalled();
  });

  it("applies a room-level disabled reason to otherwise valid publications", () => {
    const onPublishLocation = vi.fn();
    renderControls({
      disabled: true,
      disabledReason: "房主离线，无法发布",
      onPublishLocation,
    });

    const button = screen.getByRole("button", { name: "向全房间公开地点" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("房主离线，无法发布");
    expect(screen.getByText("房主离线，无法发布")).toBeTruthy();
  });
});

function renderControls(overrides: Partial<React.ComponentProps<typeof KeeperSceneControls>> = {}) {
  const props: React.ComponentProps<typeof KeeperSceneControls> = {
    modulePackage: createModulePackage(),
    publishedLocations: new Map(),
    npcsByLocation: new Map(),
    onPublishLocation: vi.fn(),
    onPublishNpc: vi.fn(),
    ...overrides,
  };
  return render(<KeeperSceneControls {...props} />);
}

function createModulePackage(): ModulePackageV1 {
  const timestamp = "2026-08-28T00:00:00.000Z";
  return {
    schemaVersion: 1,
    moduleId: "module-stage-controls",
    revision: 3,
    metadata: {
      title: "见世之蝶",
      authors: [],
      language: "zh-CN",
      summary: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    overview: "",
    sourceDocuments: [],
    chapters: [],
    scenes: [
      {
        id: "scene-opening",
        name: "开幕场景",
        description: "",
        synopsis: "调查员在剧场第一次见到演员。",
        locationIds: ["location-theater"],
        npcIds: ["npc-hana"],
        clueIds: [],
        handoutIds: [],
        suggestedCheckIds: [],
        keeperNotes: "KP 提示：先让灯光熄灭。",
        sourceRefs: [],
      },
    ],
    locations: [
      {
        id: "location-theater",
        name: "观止剧场",
        description: "KP 私密：这里其实是绑架现场。",
        playerDescription: "玩家公开：帷幕后传来木板轻响。",
        aliases: ["剧场"],
        sourceRefs: [],
      },
      {
        id: "location-garden",
        name: "无名庭院",
        description: "KP 私密：庭院地下埋着遗体。",
        aliases: [],
        sourceRefs: [],
      },
    ],
    npcs: [
      {
        id: "npc-hana",
        name: "花小路",
        description: "KP 私密：她知道凶手身份。",
        playerDescription: "玩家公开：她的笑容有些勉强。",
        role: "演员",
        motivation: "保守秘密",
        traits: ["谨慎"],
        sourceRefs: [],
      },
      {
        id: "npc-kimura",
        name: "木村晃",
        description: "KP 私密：他与另一场景有关。",
        playerDescription: "玩家公开：一位沉默的手艺人。",
        role: "店主",
        motivation: "",
        traits: [],
        sourceRefs: [],
      },
      {
        id: "npc-no-public-copy",
        name: "无公开稿人物",
        description: "KP 私密：绝不能直接发送。",
        role: "幕后人物",
        motivation: "",
        traits: [],
        sourceRefs: [],
      },
    ],
    clues: [],
    handouts: [],
    suggestedChecks: [],
    keeperNotes: [],
    relations: [],
    extensions: {},
  };
}
