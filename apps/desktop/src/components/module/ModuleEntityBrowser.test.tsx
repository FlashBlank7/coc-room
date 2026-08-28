// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { modulePackageSchema, type ModulePackageV1 } from "@coc-room/protocol";

import { ModuleEntityBrowser } from "./ModuleEntityBrowser";

afterEach(cleanup);

describe("ModuleEntityBrowser", () => {
  it("switches between NPC and location cards and shows the extracted sample entities", () => {
    render(<ModuleEntityBrowser modulePackage={createModulePackage()} />);

    expect(screen.getByText("见世之蝶")).toBeTruthy();
    const directory = screen.getByLabelText("人物与地点速览");
    expect(within(directory).getByRole("button", { name: "映夜太夫" })).toBeTruthy();
    expect(within(directory).getByRole("button", { name: "扬屋（映夜的处所）" })).toBeTruthy();

    fireEvent.click(within(directory).getByRole("button", { name: "映夜太夫" }));
    expect(screen.getByRole("tab", { name: /NPC/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "映夜太夫" })).toBeTruthy();
    expect(screen.getByText("花魁（委托人）")).toBeTruthy();
    expect(screen.getByText("为姐姐蝴蝶复仇")).toBeTruthy();
    expect(screen.getByText("一位举止温雅、神情忧虑的花魁。")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /地点/ }));
    expect(screen.getByRole("heading", { name: "扬屋（映夜的处所）" })).toBeTruthy();
    expect(screen.getByText(/也是她被绑架后的现场/)).toBeTruthy();
    expect(screen.getByText("铺着草榻的雅致会客之所。")).toBeTruthy();
  });

  it("focuses the exact NPC or location card selected from the overview", () => {
    render(<ModuleEntityBrowser modulePackage={createModulePackage()} />);
    const directory = screen.getByRole("article", { name: /速览/ });

    fireEvent.click(within(directory).getByTitle("npc:eiya"));
    expect(screen.getByRole("tab", { name: /NPC/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement?.getAttribute("id")).toBe("npc:eiya");

    fireEvent.click(screen.getAllByRole("tab")[0]!);
    fireEvent.click(screen.getByTitle("location:ageya"));
    expect(document.activeElement?.getAttribute("id")).toBe("location:ageya");
  });

  it("searches the active category across body text, IDs, and source excerpts", () => {
    render(<ModuleEntityBrowser modulePackage={createModulePackage()} />);
    fireEvent.click(screen.getByRole("tab", { name: /NPC/ }));

    const search = screen.getByPlaceholderText("搜索名称、正文、ID 或原文摘要");
    fireEvent.change(search, { target: { value: "无人匹配" } });
    expect(screen.queryByRole("heading", { name: "映夜太夫" })).toBeNull();
    expect(screen.getByText(/没有与“无人匹配”匹配的内容/)).toBeTruthy();

    fireEvent.change(search, { target: { value: "复仇" } });
    expect(screen.getByRole("heading", { name: "映夜太夫" })).toBeTruthy();

    fireEvent.change(search, { target: { value: "映夜会请他们一见" } });
    expect(screen.getByRole("heading", { name: "映夜太夫" })).toBeTruthy();
  });

  it("marks keeper-only clue text and explains that an empty revealText cannot be shared", () => {
    render(<ModuleEntityBrowser modulePackage={createModulePackage()} />);
    fireEvent.click(screen.getByRole("tab", { name: /线索/ }));

    expect(screen.getByRole("heading", { name: "草榻的印记" })).toBeTruthy();
    expect(screen.getByText("守秘人线索说明")).toBeTruthy();
    expect(screen.getAllByText("守秘人内容").length).toBeGreaterThan(0);
    expect(screen.getByText("尚无玩家可见文本，不能直接公开。")).toBeTruthy();
    expect(screen.getByText("原文定位 · 1 处")).toBeTruthy();
  });

  it("shows readable names beside related IDs and provides a handout category", () => {
    render(<ModuleEntityBrowser modulePackage={createModulePackage()} />);

    fireEvent.click(screen.getByRole("tab", { name: /关系/ }));
    expect(screen.getByText("映夜太夫")).toBeTruthy();
    expect(screen.getByText("橘弥生")).toBeTruthy();
    expect(screen.getByText("npc:eiya")).toBeTruthy();
    expect(screen.getByText("npc:yayoi")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /文字手记/ }));
    expect(screen.getByRole("heading", { name: "染血的俳句" })).toBeTruthy();
    expect(screen.getByText("蝶自血泊中醒来。")).toBeTruthy();
  });

  it("shows DeepSeek provenance in the overview", () => {
    const modulePackage = createModulePackage();
    modulePackage.extensions["org.coc-room.parser"] = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      parsedAt: "2026-08-28T03:04:05.000Z",
      sourceName: "观止-见世之蝶.docx",
      status: "needs_review",
      issues: [{ code: "UNRESOLVED_REFERENCE", message: "一条引用需要修正" }],
      usage: { calls: 3, inputTokens: 2_000, outputTokens: 800 },
    };

    render(<ModuleEntityBrowser modulePackage={modulePackage} />);
    const provenance = screen.getByLabelText("解析来源");

    expect(within(provenance).getByText("DeepSeek API")).toBeTruthy();
    expect(within(provenance).getByText("deepseek-v4-flash")).toBeTruthy();
    expect(within(provenance).getByText("需要人工修正")).toBeTruthy();
    expect(within(provenance).getByText("观止-见世之蝶.docx")).toBeTruthy();
    expect(within(provenance).getByText("3")).toBeTruthy();
    expect(within(provenance).getByText("1 条")).toBeTruthy();
    expect(within(provenance).getByText(/2026/)).toBeTruthy();
  });

  it("explains that provenance is unavailable for an older imported package", () => {
    render(<ModuleEntityBrowser modulePackage={createModulePackage()} />);

    expect(within(screen.getByLabelText("解析来源")).getByText("来源未记录")).toBeTruthy();
  });
});

function createModulePackage(): ModulePackageV1 {
  const timestamp = "2026-08-27T00:00:00.000Z";
  const sourceRef = {
    sourceId: "source:butterfly",
    start: 588,
    end: 890,
    excerpt: "映夜会请他们一见，在扬屋中交代离奇死亡的情况。",
  };

  return modulePackageSchema.parse({
    schemaVersion: 1,
    moduleId: "module:butterfly",
    revision: 1,
    metadata: {
      title: "见世之蝶",
      authors: ["观止"],
      language: "zh-CN",
      summary: "明治八年的吉原发生了连续怪死事件。",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    overview: "调查员受映夜太夫委托调查两名游女的离奇死亡。",
    sourceDocuments: [
      {
        id: "source:butterfly",
        name: "观止-见世之蝶.docx",
        mediaType: "text/markdown",
      },
    ],
    chapters: [
      {
        id: "chapter:opening",
        title: "吉原启幕",
        order: 0,
        sceneIds: ["scene:opening"],
        notes: "从扬屋开始调查。",
      },
    ],
    scenes: [
      {
        id: "scene:opening",
        name: "启幕",
        description: "调查员在扬屋与映夜太夫初次见面。",
        sourceRefs: [sourceRef],
        synopsis: "映夜委托调查两名游女的死亡。",
        locationIds: ["location:ageya"],
        npcIds: ["npc:eiya"],
        clueIds: ["clue:tatami"],
        handoutIds: ["handout:haiku"],
        suggestedCheckIds: ["check:spot"],
        keeperNotes: "映夜没有说出真正动机。",
      },
    ],
    locations: [
      {
        id: "location:ageya",
        name: "扬屋（映夜的处所）",
        description: "映夜太夫所在的扬屋，也是她被绑架后的现场。",
        playerDescription: "铺着草榻的雅致会客之所。",
        sourceRefs: [sourceRef],
        aliases: ["扬屋"],
      },
    ],
    npcs: [
      {
        id: "npc:eiya",
        name: "映夜太夫",
        description: "温婉典雅的花魁。",
        playerDescription: "一位举止温雅、神情忧虑的花魁。",
        sourceRefs: [sourceRef],
        role: "花魁（委托人）",
        motivation: "为姐姐蝴蝶复仇",
        traits: ["温婉典雅", "博学多才"],
      },
      {
        id: "npc:yayoi",
        name: "橘弥生",
        description: "映夜的爱慕者。",
        sourceRefs: [sourceRef],
        role: "协力者",
        motivation: "帮助映夜",
        traits: ["痴迷"],
      },
    ],
    clues: [
      {
        id: "clue:tatami",
        name: "草榻的印记",
        description: "困难侦察可发现十指抠进草榻的印记。",
        sourceRefs: [sourceRef],
        revealText: "",
        isCore: false,
      },
    ],
    handouts: [
      {
        id: "handout:haiku",
        name: "俳句手记",
        title: "染血的俳句",
        description: "案发现场留下的文字。",
        content: "蝶自血泊中醒来。",
        sourceRefs: [sourceRef],
      },
    ],
    suggestedChecks: [
      {
        id: "check:spot",
        skill: "侦察",
        difficulty: "hard",
        purpose: "在房间寻找痕迹",
        onSuccess: "发现草榻印记。",
        onFailure: "未发现痕迹。",
        sourceRefs: [sourceRef],
      },
    ],
    keeperNotes: [
      {
        id: "note:culprit",
        title: "真凶与动机",
        content: "映夜是事件主谋。",
        relatedEntityIds: ["npc:eiya"],
        sourceRefs: [sourceRef],
      },
    ],
    relations: [
      {
        id: "relation:devotion",
        fromEntityId: "npc:eiya",
        toEntityId: "npc:yayoi",
        kind: "映夜的爱慕者",
        description: "橘弥生深爱映夜并为她行动。",
        sourceRefs: [sourceRef],
      },
    ],
    extensions: {},
  });
}
