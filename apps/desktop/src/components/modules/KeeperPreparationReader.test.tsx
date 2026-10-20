// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { KeeperGuideNoteV1, ModulePackageV1 } from "@coc-room/protocol";
import { miniModule } from "../../test/scenarios/mini-investigation";
import { KeeperPreparationReader } from "./KeeperPreparationReader";
import { keeperContentHash, keeperInputHash } from "../../ai/keeper-workflow";

afterEach(cleanup);

it("shows the review result but invalidates it when the keeper edits the guide", async () => {
  const sourceText = "本幕原文";
  const guide = { schemaVersion: 1 as const, truth: "旧说明", hook: "", clueTrail: [], timeline: [], endings: [], pacing: "" };
  const modulePackage: ModulePackageV1 = { ...miniModule, sourceDocuments: [{ id: "source-original", name: "原文", mediaType: "text/plain" }], keeperGuide: {
    ...guide, workflow: { version: 1, inputHash: await keeperInputHash({ ...miniModule, sourceDocuments: [{ id: "source-original", name: "原文", mediaType: "text/plain" }] }, sourceText, "codex", ""), contentHash: await keeperContentHash(guide), provider: "codex", model: "", stage: "complete", reviews: [], audit: { checks: [], findings: [] } },
  } };
  const view = render(<KeeperPreparationReader modulePackage={modulePackage} sourceText={sourceText} />);
  expect(await screen.findByText("自动核对完成")).toBeTruthy();
  view.rerender(<KeeperPreparationReader modulePackage={{ ...modulePackage, keeperGuide: { ...modulePackage.keeperGuide!, truth: "KP 新改写" } }} sourceText={sourceText} />);
  expect(await screen.findByText("资料已改变或当前缺少原文，旧核对结果不能代表当前内容。")).toBeTruthy();
  expect(screen.queryByText("自动核对完成")).toBeNull();
});

it("presents generated reference without claiming a semantic audit took place", async () => {
  const sourceText = "本幕原文";
  const modulePackage: ModulePackageV1 = { ...miniModule, sourceDocuments: [{ id: "source-original", name: "原文", mediaType: "text/plain" }] };
  const guide = { schemaVersion: 1 as const, truth: "供 KP 调整的参考", hook: "", clueTrail: [], timeline: [], endings: [], pacing: "" };
  modulePackage.keeperGuide = { ...guide, workflow: {
    version: 1, provider: "codex", model: "", stage: "complete", reviews: [],
    inputHash: await keeperInputHash(modulePackage, sourceText, "codex", ""), contentHash: await keeperContentHash(guide),
  } };
  render(<KeeperPreparationReader modulePackage={modulePackage} sourceText={sourceText} />);
  expect(await screen.findByText("主持参考已生成")).toBeTruthy();
  expect(screen.queryByText("自动核对完成")).toBeNull();
});

it("starts with the truth, distinguishes optional recovery advice, and lets the keeper inspect evidence and prepare an opening", () => {
  const note: KeeperGuideNoteV1 = { title: "为什么调查唱片室", text: "曲目单指向地下室的仪式。", kind: "source", sources: [{ sourceId: "source-original", excerpt: "曲目单指向地下室。" }] };
  const modulePackage: ModulePackageV1 = {
    ...miniModule,
    sourceDocuments: [{ id: "source-original", name: "剧院原文", mediaType: "text/plain" }],
    keeperGuide: {
      schemaVersion: 1, truth: "", hook: "", clueTrail: [], timeline: [], endings: [], pacing: "",
      preparation: {
        truth: note, hook: { ...note, title: "受谁委托" }, essentials: [{ ...note, title: "开场前记住" }],
        playerBriefing: { ...note, title: "玩家背景" }, timeline: [], endings: [], cast: [],
        publicClues: [{ clueId: miniModule.clues[0]!.id, text: "曲目顺序从终幕倒向序曲。", when: { ...note, title: "取得曲目单后", text: "找到曲目单后可公开纸上的曲序；不要同时说明仪式用途。" } }],
        scenes: [{ sceneId: miniModule.scenes[0]!.id, purpose: { ...note, title: "这一幕的作用" }, openingDraft: "门内传来唱针摩擦声。", actions: [], exits: [note], pitfalls: [{ title: "玩家错过曲目单时", text: "可让场务提起昨夜的曲序。", kind: "advice", sources: [] }] }],
      },
    },
  };
  const apply = vi.fn();
  const applyClue = vi.fn();
  render(<KeeperPreparationReader modulePackage={modulePackage} sourceText="昨夜雨很大。曲目单指向地下室。仪式尚未结束。" onApplyOpening={apply} onApplyClue={applyClue} />);
  expect(screen.getByRole("heading", { name: "为什么调查唱片室" })).toBeTruthy();
  const truth = screen.getByRole("heading", { name: "为什么调查唱片室" }).closest("article")!;
  fireEvent.click(within(truth).getByText("展开原文依据（1 处）"));
  expect(within(truth).getByText("曲目单指向地下室。")).toBeTruthy();
  fireEvent.click(within(truth).getByText("查看前后文"));
  expect(within(truth).getByText("昨夜雨很大。曲目单指向地下室。仪式尚未结束。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "每一幕怎么带" }));
  expect(screen.getByText("主持建议")).toBeTruthy();
  expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "采用为这一幕的玩家开场" }));
  expect(apply).toHaveBeenCalledWith(miniModule.scenes[0]!.id, "门内传来唱针摩擦声。");
  expect(screen.getByLabelText("本场发现的公开草稿").textContent).toContain("找到曲目单后可公开");
  expect(applyClue).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "采用这条线索的公开文案" }));
  expect(applyClue).toHaveBeenCalledWith(miniModule.clues[0]!.id, "曲目顺序从终幕倒向序曲。");
});

it("gives old imported modules an honest starting point and an explicit preparation action", () => {
  const generate = vi.fn();
  render(<KeeperPreparationReader modulePackage={{ ...miniModule, keeperGuide: undefined }} onGenerate={generate} />);
  expect(screen.getByLabelText("第一次带这个模组")).toBeTruthy();
  expect(screen.getByText(/没有保留完整原文/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "补全初次主持引导" }));
  expect(generate).toHaveBeenCalledOnce();
});

it("offers only missing introductions when the story, scene references and cast are already prepared", () => {
  const note: KeeperGuideNoteV1 = { title: "KP 核对过的真相", text: "这里保留已整理好的因果解释。", kind: "advice", sources: [] };
  const modulePackage: ModulePackageV1 = { ...miniModule,
    locations: [{ id: "place-theatre", name: "剧院", description: "古老剧院", sourceRefs: [], aliases: [] }],
    scenes: miniModule.scenes.map((scene) => ({ ...scene, locationIds: ["place-theatre"] })),
    keeperGuide: {
    schemaVersion: 1, truth: note.text, hook: "", clueTrail: [], timeline: [], endings: [], pacing: "",
    preparation: { truth: note, hook: { ...note, title: "委托" }, essentials: [note], playerBriefing: note, timeline: [], endings: [],
      cast: miniModule.npcs.map((npc) => ({ npcId: npc.id, notes: [note] })),
      scenes: miniModule.scenes.map((scene) => ({ sceneId: scene.id, purpose: note, openingDraft: "可以采用的开场", actions: [], exits: [], pitfalls: [] })),
    },
  } };
  const generate = vi.fn();
  render(<KeeperPreparationReader modulePackage={modulePackage} onGenerate={generate} />);
  expect(screen.queryByRole("button", { name: "重新整理主持引导" })).toBeNull();
  expect(screen.getByText(/只补缺项，保留已有主持笔记/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /补全 \d+ 幕登场资料/ }));
  expect(generate).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "每一幕怎么带" }));
  expect(screen.getByText("可以采用的开场")).toBeTruthy();
});
