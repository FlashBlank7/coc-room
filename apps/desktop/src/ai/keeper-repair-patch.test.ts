import { expect, it } from "vitest";
import { keeperGuideSchema } from "@coc-room/protocol";
import { miniModule } from "../test/scenarios/mini-investigation";
import { applyKeeperRepairPatch } from "./keeper-repair-patch";

const source = "先取得钥匙，再进入地下室。";
const note = { title: "进入条件", text: source, kind: "source", sources: [{ sourceId: "source-original", excerpt: source }] };
const modulePackage = { ...miniModule, sourceDocuments: [{ id: "source-original", name: "原文", mediaType: "text/plain" as const }],
  scenes: [{ ...miniModule.scenes[0]!, npcIds: [], locationIds: [] }] };
const guide = keeperGuideSchema.parse({ schemaVersion: 1, truth: source, hook: source, clueTrail: [], timeline: [], endings: [], pacing: "", preparation: {
  truth: note, hook: note, essentials: [note], playerBriefing: note, timeline: [], endings: [], cast: [], publicClues: [],
  scenes: [{ sceneId: modulePackage.scenes[0]!.id, purpose: note, openingDraft: "错误开场", publicEntities: [], actions: [], exits: [note], pitfalls: [] }],
} });

it("changes only specified prose and preserves every other prepared field", () => {
  const result = applyKeeperRepairPatch(guide, { edits: [
    { op: "replace", path: "/scenes/0/openingDraft", value: "先向守门人询问钥匙。" },
    { op: "add", path: "/scenes/0/pitfalls/-", value: { title: "失败接续", text: "建议询问其他入口，但不跳过钥匙条件。", kind: "advice", sources: [] } },
  ] }, modulePackage, source);
  const expected = structuredClone(guide);
  expected.preparation!.scenes[0]!.openingDraft = "先向守门人询问钥匙。";
  expected.preparation!.scenes[0]!.pitfalls.push({ title: "失败接续", text: "建议询问其他入口，但不跳过钥匙条件。", kind: "advice", sources: [] });
  expect(result).toEqual(expected);
  expect(guide.preparation!.scenes[0]!.openingDraft).toBe("错误开场");
});

it("rejects a whole invalid patch atomically, including identity and prototype paths", () => {
  for (const path of ["/scenes/0/sceneId", "/scenes", "/workflow", "/__proto__/polluted", "/scenes/99/openingDraft"]) {
    const before = structuredClone(guide);
    expect(() => applyKeeperRepairPatch(guide, { edits: [
      { op: "replace", path: "/scenes/0/openingDraft", value: "这一条原本合法" },
      { op: "replace", path, value: "invalid" },
    ] }, modulePackage, source)).toThrow();
    expect(guide).toEqual(before);
  }
});

it("validates the resulting references and required content, not just patch syntax", () => {
  expect(() => applyKeeperRepairPatch(guide, { edits: [{ op: "add", path: "/publicClues/-", value: {
    clueId: "clue-unknown", text: "不存在的线索", when: note,
  } }] }, modulePackage, source)).toThrow("不存在");
  expect(() => applyKeeperRepairPatch(guide, { edits: [{ op: "remove", path: "/essentials/0", value: null }] }, modulePackage, source)).toThrow();
  expect(guide.preparation!.essentials).toHaveLength(1);
});

it("rechecks citations and keeps legacy summary text in sync with a changed truth note", () => {
  const result = applyKeeperRepairPatch(guide, { edits: [{ op: "replace", path: "/truth", value: {
    ...note, text: "另一个解释", sources: [{ sourceId: "source-original", excerpt: "捏造的依据" }],
  } }] }, modulePackage, source);
  expect(result.truth).toBe("另一个解释");
  expect(result.preparation!.truth).toMatchObject({ kind: "uncertain", sources: [] });
});
