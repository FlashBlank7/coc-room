import { beforeEach, expect, it, vi } from "vitest";
import type { KeeperGuideV1, ModulePackageV1 } from "@coc-room/protocol";
import { miniModule } from "../test/scenarios/mini-investigation";
import { prepareKeeperGuideBatches as prepareKeeperGuide } from "./keeper-preparation";
import { generateKeeperGuide, type GenerateKeeperGuideOptions } from "./keeper-guide";

vi.mock("./keeper-guide", () => ({ generateKeeperGuide: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

const modulePackage: ModulePackageV1 = { ...miniModule, keeperGuide: undefined, scenes: Array.from({ length: 7 }, (_, index) => ({ ...miniModule.scenes[0]!, id: `scene-${index}` })) };
const introductionModule: ModulePackageV1 = { ...modulePackage,
  npcs: [{ id: "npc-matron", name: "管事", description: "掌握剧院来客名单", sourceRefs: [], role: "证人", motivation: "", traits: [] }],
  locations: [{ id: "place-theatre", name: "剧院", description: "古老剧院", sourceRefs: [], aliases: [] }],
  scenes: modulePackage.scenes.map((scene) => ({ ...scene, npcIds: ["npc-matron"], locationIds: ["place-theatre"] })),
};
function batchGuide(options: GenerateKeeperGuideOptions): KeeperGuideV1 {
  const note = { title: "参考", text: "保留原文条件", kind: "advice" as const, sources: [] };
  return { schemaVersion: 1, truth: options.preparationScope === "scene-batch" ? "must not replace overview" : "first overview", hook: "", clueTrail: [], timeline: [], endings: [], pacing: "", preparation: {
    truth: note, hook: note, playerBriefing: note, essentials: [note], timeline: [], endings: [], cast: (options.preparationCastIds ?? []).map((npcId) => ({ npcId, notes: [note] })), publicClues: [],
    scenes: options.modulePackage.scenes.map((scene) => ({ sceneId: scene.id, purpose: note, openingDraft: "雨声", actions: [], exits: [], pitfalls: [], publicEntities: [
      ...scene.npcIds.map((entityId) => ({ kind: "npc" as const, entityId, name: "人物", text: "已知介绍", when: note })),
      ...scene.locationIds.map((entityId) => ({ kind: "location" as const, entityId, name: "地点", text: "当前可见", when: note })),
    ] })),
  } };
}

it("delivers usable batches before completion and keeps the first overview", async () => {
  vi.mocked(generateKeeperGuide).mockImplementation(async (options) => batchGuide(options));
  const progress: number[] = [];
  const guide = await prepareKeeperGuide({ modulePackage, provider: "codex", model: "", signal: new AbortController().signal, onPartial: (guide) => { progress.push(guide.preparation!.scenes.length); } });
  expect(progress).toEqual([1, 4, 7]);
  expect(guide.truth).toBe("first overview");
  expect(vi.mocked(generateKeeperGuide).mock.calls[1]![0].preparationScope).toBe("scene-batch");
});

it("keeps successful scenes recoverable after a later failure, then resumes only missing scenes", async () => {
  vi.mocked(generateKeeperGuide).mockImplementationOnce(async (options) => batchGuide(options)).mockRejectedValueOnce(new Error("provider timeout"));
  let partial: KeeperGuideV1 | undefined;
  await expect(prepareKeeperGuide({ modulePackage, provider: "codex", model: "", signal: new AbortController().signal, onPartial: (guide) => { partial = guide; } })).rejects.toThrow("provider timeout");
  expect(partial!.preparation!.scenes).toHaveLength(1);
  vi.mocked(generateKeeperGuide).mockImplementation(async (options) => batchGuide(options));
  const resumed = await prepareKeeperGuide({ modulePackage: { ...modulePackage, keeperGuide: partial }, provider: "codex", model: "", signal: new AbortController().signal });
  expect(resumed.preparation!.scenes).toHaveLength(7);
  expect(vi.mocked(generateKeeperGuide).mock.calls[2]![0].modulePackage.scenes.map((scene) => scene.id)).toEqual(["scene-1", "scene-2", "scene-3"]);
});

it("stops after retaining a completed batch without starting more model calls", async () => {
  vi.mocked(generateKeeperGuide).mockImplementation(async (options) => batchGuide(options));
  const controller = new AbortController();
  const onPartial = vi.fn(() => { controller.abort(new Error("stopped")); });
  await expect(prepareKeeperGuide({ modulePackage, provider: "codex", model: "", signal: controller.signal, onPartial })).rejects.toThrow("stopped");
  expect(onPartial).toHaveBeenCalledOnce();
  expect(generateKeeperGuide).toHaveBeenCalledOnce();
});

it("retains separate disclosures of one clue across batches without duplicating an identical route", async () => {
  const clueId = miniModule.clues[0]!.id;
  const free = { clueId, text: "侍女说她来自长野。", when: { title: "直接询问", text: "询问侍女即可得知，不需要检定。", kind: "advice" as const, sources: [] } };
  const gated = { clueId, text: "柿饼是长野名产。", when: { ...free.when, title: "识别食物", text: "注意到食物并通过知识检定后给出。" } };
  vi.mocked(generateKeeperGuide).mockImplementation(async (options) => {
    const guide = batchGuide(options);
    guide.preparation!.publicClues = options.preparationScope === "opening" ? [free, gated] : [gated];
    return guide;
  });
  const guide = await prepareKeeperGuide({ modulePackage, provider: "codex", model: "", signal: new AbortController().signal });
  expect(guide.preparation!.publicClues).toEqual([free, gated]);
});

it("prepares only opening NPCs first, adds later and unlinked cast, and resumes a cast-only remainder", async () => {
  vi.mocked(generateKeeperGuide).mockImplementation(async (options) => batchGuide(options));
  const npcs = ["npc-opening", "npc-later", "npc-unlinked"].map((id) => ({ id, name: id, description: "", sourceRefs: [], role: "", motivation: "", traits: [] }));
  const full = { ...modulePackage, npcs, scenes: modulePackage.scenes.map((scene, index) => ({ ...scene, npcIds: index === 0 ? [npcs[0]!.id] : index === 2 ? [npcs[1]!.id] : [] })) };
  const guide = await prepareKeeperGuide({ modulePackage: full, provider: "codex", model: "", signal: new AbortController().signal });
  expect(vi.mocked(generateKeeperGuide).mock.calls.map(([call]) => call.preparationCastIds)).toEqual([["npc-opening"], ["npc-later"], ["npc-unlinked"]]);
  expect(guide.preparation!.cast.map((npc) => npc.npcId)).toEqual(npcs.map((npc) => npc.id));
  const partial = { ...guide, preparation: { ...guide.preparation!, cast: guide.preparation!.cast.slice(0, 2) } };
  vi.mocked(generateKeeperGuide).mockClear();
  const resumed = await prepareKeeperGuide({ modulePackage: { ...full, keeperGuide: partial }, provider: "codex", model: "", signal: new AbortController().signal });
  expect(resumed.preparation!.scenes).toHaveLength(7);
  expect(generateKeeperGuide).toHaveBeenCalledOnce();
  expect(vi.mocked(generateKeeperGuide).mock.calls[0]![0]).toMatchObject({ modulePackage: { scenes: [] }, preparationCastIds: ["npc-unlinked"], preparationScope: "scene-batch" });
});

it("retains useful scene output before reporting an omitted NPC, and retries only that missing cast", async () => {
  const full = { ...modulePackage, scenes: [modulePackage.scenes[0]!], npcs: [{ id: "npc-missing", name: "人物", description: "", sourceRefs: [], role: "", motivation: "", traits: [] }] };
  vi.mocked(generateKeeperGuide).mockImplementation(async (options) => {
    const result = batchGuide(options);
    result.preparation!.cast = [];
    return result;
  });
  let saved: KeeperGuideV1 | undefined;
  await expect(prepareKeeperGuide({ modulePackage: full, provider: "codex", model: "", signal: new AbortController().signal, onPartial: (guide) => { saved = guide; } })).rejects.toThrow("尚缺 1 位人物");
  expect(saved!.preparation!.scenes).toHaveLength(1);
  vi.mocked(generateKeeperGuide).mockImplementation(async (options) => batchGuide(options));
  const result = await prepareKeeperGuide({ modulePackage: { ...full, keeperGuide: saved }, provider: "codex", model: "", signal: new AbortController().signal });
  expect(result.preparation!.cast).toHaveLength(1);
  expect(vi.mocked(generateKeeperGuide).mock.calls[1]![0].modulePackage.scenes).toEqual([]);
});

it("supplements an old complete runbook without replacing keeper edits or complete introduction variants", async () => {
  const modulePackage = introductionModule;
  const options = { modulePackage, provider: "codex" as const, model: "", signal: new AbortController().signal, preparationCastIds: modulePackage.npcs.map((npc) => npc.id) };
  const existing = batchGuide(options);
  existing.preparation!.truth.text = "KP 已核对的真相与修正";
  const originalScene = existing.preparation!.scenes[0]!;
  const retained = { ...originalScene.publicEntities![0]!, text: "KP 手写的介绍" };
  originalScene.publicEntities = [retained];
  existing.preparation!.scenes[1]!.publicEntities = [];
  const before = structuredClone(existing);
  vi.mocked(generateKeeperGuide).mockImplementation(async (request) => batchGuide(request));
  const result = await prepareKeeperGuide({ ...options, modulePackage: { ...modulePackage, keeperGuide: existing } });
  expect(generateKeeperGuide).toHaveBeenCalledOnce();
  expect(vi.mocked(generateKeeperGuide).mock.calls[0]![0]).toMatchObject({ preparationScope: "scene-publications", preparationCastIds: [] });
  expect(vi.mocked(generateKeeperGuide).mock.calls[0]![0].modulePackage.scenes.map((scene) => scene.id)).toEqual(["scene-0", "scene-1"]);
  expect(result.preparation!.truth).toEqual(before.preparation!.truth);
  expect(result.preparation!.cast).toEqual(before.preparation!.cast);
  expect(result.preparation!.scenes[0]!.purpose).toEqual(before.preparation!.scenes[0]!.purpose);
  expect(result.preparation!.scenes[0]!.publicEntities).toContainEqual(retained);
  expect(result.preparation!.scenes[2]).toEqual(before.preparation!.scenes[2]);
  expect(existing).toEqual(before);
});

it("retains successful supplementary scenes before reporting gaps and retries only incomplete scenes", async () => {
  const modulePackage = introductionModule;
  const options = { modulePackage: { ...modulePackage, scenes: modulePackage.scenes.slice(0, 3) }, provider: "codex" as const, model: "", signal: new AbortController().signal, preparationCastIds: modulePackage.npcs.map((npc) => npc.id) };
  const existing = batchGuide(options);
  for (const scene of existing.preparation!.scenes) scene.publicEntities = [];
  vi.mocked(generateKeeperGuide).mockImplementationOnce(async (request) => {
    const next = batchGuide(request);
    next.preparation!.scenes[2]!.publicEntities = [];
    return next;
  });
  let partial: KeeperGuideV1 | undefined;
  await expect(prepareKeeperGuide({ ...options, modulePackage: { ...options.modulePackage, keeperGuide: existing }, onPartial: (guide) => { partial = guide; } })).rejects.toThrow("仍有 1 幕缺项");
  expect(partial!.preparation!.scenes[0]!.publicEntities!.length).toBeGreaterThan(0);
  vi.mocked(generateKeeperGuide).mockImplementation(async (request) => batchGuide(request));
  await prepareKeeperGuide({ ...options, modulePackage: { ...options.modulePackage, keeperGuide: partial } });
  expect(vi.mocked(generateKeeperGuide).mock.calls[1]![0].modulePackage.scenes.map((scene) => scene.id)).toEqual(["scene-2"]);
});

it("continues extraction into missing introductions and honors an explicit not-yet-visible entry", async () => {
  const modulePackage = introductionModule;
  const full = { ...modulePackage, scenes: modulePackage.scenes.slice(0, 1) };
  vi.mocked(generateKeeperGuide).mockImplementation(async (options) => {
    const next = batchGuide(options);
    if (options.preparationScope === "opening") {
      const entries = next.preparation!.scenes[0]!.publicEntities!;
      next.preparation!.scenes[0]!.publicEntities = [{ ...entries[0]!, name: "", text: "", when: { ...entries[0]!.when, text: "此时尚未登场" } }];
    }
    return next;
  });
  const result = await prepareKeeperGuide({ modulePackage: full, provider: "codex", model: "", signal: new AbortController().signal });
  expect(vi.mocked(generateKeeperGuide).mock.calls.map(([request]) => request.preparationScope)).toEqual(["opening", "scene-publications"]);
  expect(result.preparation!.scenes[0]!.publicEntities![0]).toMatchObject({ name: "", text: "", when: { text: "此时尚未登场" } });
});
