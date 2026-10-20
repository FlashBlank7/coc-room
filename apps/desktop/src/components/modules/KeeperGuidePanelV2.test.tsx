// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { KeeperGuideV1, ModulePackageV1 } from "@coc-room/protocol";
import { getRepository } from "../../data/repository";
import { miniModule } from "../../test/scenarios/mini-investigation";
import { KeeperGuideContentV2 } from "./KeeperGuidePanelV2";

afterEach(cleanup);

it("lets the keeper read the authoritative preparation and inspect stored source context from the live desk", async () => {
  const source = { title: "乐团为什么失踪", text: "乐团被地下室的仪式困住。", kind: "source" as const, sources: [{ sourceId: "source-live-reference", excerpt: "乐团被地下室的仪式困住。" }] };
  const advice = { title: "玩家没找到曲目单时", text: "可以让场务提起昨夜的演出。", kind: "advice" as const, sources: [] };
  const guide: KeeperGuideV1 = { schemaVersion: 1, truth: "旧简版摘要不会替代带出处的参考", hook: "", clueTrail: [], timeline: [], endings: [], pacing: "",
    preparation: { truth: source, hook: { ...source, title: "为什么来到剧院" }, playerBriefing: { ...source, title: "玩家委托" }, essentials: [{ ...source, title: "开场前要记住" }],
      timeline: [], endings: [{ ...source, title: "如何结束仪式" }], cast: [],
      scenes: [{ sceneId: miniModule.scenes[0]!.id, purpose: { ...source, title: "本幕作用" }, openingDraft: "唱片室内只剩雨声。", actions: [], exits: [], pitfalls: [advice] }],
    },
  };
  const modulePackage: ModulePackageV1 = { ...miniModule, moduleId: "module-live-reference-reader", keeperGuide: guide, sourceDocuments: [{ id: "source-live-reference", name: "剧院原文", mediaType: "text/plain" }] };
  await (await getRepository()).saveModule({ package: modulePackage, sourceText: "昨夜剧院停电。乐团被地下室的仪式困住。曲目单可以解除仪式。" });
  const ui = render(<KeeperGuideContentV2 guide={guide} modulePackage={modulePackage} />);
  expect(within(screen.getByLabelText("第一次带这个模组")).queryByText(guide.truth)).toBeNull();
  expect((screen.getByLabelText("旧版补充参考") as HTMLDetailsElement).open).toBe(false);
  const truth = screen.getByRole("heading", { name: "乐团为什么失踪" }).closest("article")!;
  fireEvent.click(within(truth).getByText("展开原文依据（1 处）"));
  fireEvent.click(await within(truth).findByText("查看前后文"));
  expect(within(truth).getByText("昨夜剧院停电。乐团被地下室的仪式困住。曲目单可以解除仪式。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "每一幕怎么带" }));
  expect(screen.getByText(advice.text)).toBeTruthy();
  expect(screen.getByText("主持建议")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "采用为这一幕的玩家开场" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "调查途径与结局" }));
  expect(screen.getByText("如何结束仪式")).toBeTruthy();
  ui.rerender(<KeeperGuideContentV2 guide={guide} modulePackage={{ ...modulePackage, moduleId: "module-without-local-source" }} />);
  const nextTruth = screen.getByRole("heading", { name: "乐团为什么失踪" }).closest("article")!;
  fireEvent.click(within(nextTruth).getByText("展开原文依据（1 处）"));
  expect(within(nextTruth).getByText(/当前未附完整原文/)).toBeTruthy();
  expect(within(nextTruth).queryByText("查看前后文")).toBeNull();
});

it("continues displaying an older guide that has no evidence-backed preparation", () => {
  const guide: KeeperGuideV1 = { schemaVersion: 1, truth: "旧模组真相", hook: "旧委托", clueTrail: [], timeline: [], endings: [], pacing: "旧版节奏建议" };
  render(<KeeperGuideContentV2 guide={guide} modulePackage={miniModule} />);
  expect(screen.getByText("旧模组真相")).toBeTruthy();
  expect(screen.getByText("旧版节奏建议")).toBeTruthy();
});
