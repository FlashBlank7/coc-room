import { afterEach, describe, expect, it, vi } from "vitest";
import { modulePackageSchema, type KeeperPreparationV1, type KeeperGuideV1, type ModulePackageV1 } from "@coc-room/protocol";
import { buildModuleDigest, generateKeeperGuide, runKeeperGuideStep } from "./keeper-guide";
import { validateGuideEvidence } from "./keeper-guide-context";

const { runWebDevelopmentAiTask, getSetting, invokeNative } = vi.hoisted(() => ({
  runWebDevelopmentAiTask: vi.fn(),
  getSetting: vi.fn(async () => undefined as string | undefined),
  invokeNative: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeNative }));
afterEach(() => { Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__"); vi.clearAllMocks(); });

function preparation(): KeeperPreparationV1 {
  const note = { title: "仪式与失踪", text: "乐团的失踪源于地下室仪式。", kind: "source" as const, sources: [{ sourceId: "source-original", excerpt: "乐团被地下室仪式困住。" }] };
  return {
    truth: note, hook: { ...note, title: "调查员为何来到这里" }, essentials: [note],
    playerBriefing: { title: "给玩家的委托", text: "寻找失踪乐团。", kind: "advice", sources: [] },
    timeline: [], endings: [], cast: [],
    scenes: [{ sceneId: "scene-foyer", purpose: note, openingDraft: "门厅里只有雨声。", actions: [{ intent: "问守门人", response: { ...note, kind: "advice", sources: [] } }], exits: [], pitfalls: [] }],
  };
}

vi.mock("./web-development-ai-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./web-development-ai-bridge")>();
  return { ...actual, runWebDevelopmentAiTask };
});

vi.mock("../data/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/repository")>();
  return { ...actual, getRepository: async () => ({ getSetting }) };
});

it("retries an invalid patch path once without changing the candidate or rewriting unrelated prose", async () => {
  const candidate = { preparation: preparation() };
  const before = structuredClone(candidate);
  runWebDevelopmentAiTask.mockResolvedValueOnce([{ type: "result", result: { guide: { edits: [{ op: "replace", path: "/scenes/99/openingDraft", value: "错误位置" }] } } }])
    .mockResolvedValueOnce([{ type: "result", result: { guide: { edits: [{ op: "replace", path: "/scenes/0/openingDraft", value: "守门人指向值班室。" }] } } }]);
  const result = await runKeeperGuideStep({ modulePackage: modulePackage(), provider: "codex", model: "", signal: new AbortController().signal }, { workflowStage: "patch", candidate }) as KeeperGuideV1;
  expect(runWebDevelopmentAiTask).toHaveBeenCalledTimes(2);
  expect(JSON.parse(runWebDevelopmentAiTask.mock.calls[1]![1].digest)).toMatchObject({ outputRetry: true, outputRetryReason: expect.stringContaining("/scenes/99/openingDraft") });
  expect(result.preparation!.scenes[0]!.openingDraft).toBe("守门人指向值班室。");
  expect(result.preparation!.scenes[0]!.actions).toEqual(candidate.preparation.scenes[0]!.actions);
  expect(candidate).toEqual(before);
});

function modulePackage(): ModulePackageV1 {
  const now = "2026-09-01T00:00:00.000Z";
  return modulePackageSchema.parse({
    schemaVersion: 1,
    moduleId: "module-theatre",
    revision: 3,
    metadata: {
      title: "雨夜剧院",
      authors: ["测试"],
      language: "zh-CN",
      summary: "一夜之间消失的乐团。",
      createdAt: now,
      updatedAt: now,
    },
    overview: "剧院每逢雨夜传出无人演奏的风琴声。",
    sourceDocuments: [{ id: "source-original", name: "剧院原文", mediaType: "text/plain" }],
    chapters: [],
    scenes: [{
      id: "scene-foyer",
      name: "剧院门厅",
      description: "磨石地面映着雨水。",
      sourceRefs: [],
      synopsis: "调查员初次进入剧院。",
      locationIds: [],
      npcIds: [],
      clueIds: ["clue-ticket"],
      handoutIds: [],
      suggestedCheckIds: [],
      keeperNotes: "守门人隐瞒了地下室。",
    }],
    locations: [],
    npcs: [],
    clues: [{
      id: "clue-ticket",
      name: "撕破的票根",
      description: "印着昨夜十一点。",
      sourceRefs: [],
      revealText: "票根背面写着一个座位号。",
      isCore: true,
    }],
    handouts: [],
    suggestedChecks: [],
    keeperNotes: [],
    relations: [],
    extensions: {},
  });
}

describe("buildModuleDigest", () => {
  it("keeps original evidence, handouts, conditions and references instead of summarizing them away", () => {
    const module = modulePackage();
    module.suggestedChecks = [{ id: "check-door", skill: "侦查", difficulty: "regular", purpose: "检查暗门", onSuccess: "找到门闩", onFailure: "声响引来守卫", sourceRefs: [] }];
    module.keeperNotes = [{ id: "note-time", title: "时限", content: "天亮后仪式结束", relatedEntityIds: [], sourceRefs: [] }];
    const digest = JSON.parse(buildModuleDigest(module, "乐团被地下室仪式困住。"));
    expect(digest.sources[0].text).toBe("乐团被地下室仪式困住。");
    expect(digest.suggestedChecks[0].onFailure).toBe("声响引来守卫");
    expect(digest.keeperNotes[0].content).toBe("天亮后仪式结束");
    expect(() => buildModuleDigest(module, "x".repeat(300_001))).toThrow("没有被截断");
  });
  it("keeps ids and structure so the guide can reference scenes and clues", () => {
    const digest = JSON.parse(buildModuleDigest(modulePackage())) as Record<string, unknown>;
    expect(digest.title).toBe("雨夜剧院");
    expect(digest.scenes).toMatchObject([{ id: "scene-foyer", keeperNotes: "守门人隐瞒了地下室。" }]);
    expect(digest.clues).toMatchObject([{ id: "clue-ticket", revealText: "票根背面写着一个座位号。", isCore: true }]);
  });
});

describe("generateKeeperGuide", () => {
  it("accepts the compact preparation-only response without losing evidence or requiring duplicate legacy summaries", async () => {
    const prepared = preparation();
    runWebDevelopmentAiTask.mockResolvedValue([{ type: "result", result: { guide: { preparation: prepared } } }]);
    const guide = await generateKeeperGuide({ modulePackage: modulePackage(), sourceText: "乐团被地下室仪式困住。", provider: "codex", model: "", signal: new AbortController().signal });
    expect(guide.preparation).toEqual(prepared);
    expect(guide.truth).toBe(prepared.truth.text);
    expect(guide.hook).toBe(prepared.hook.text);
    expect(guide.clueTrail).toEqual([]);
  });

  it("wraps the bridge result into a schema-valid guide and strips null ids", async () => {
    runWebDevelopmentAiTask.mockResolvedValue([{
      type: "result",
      result: {
        status: "draft",
        provider: "codex",
        model: "",
        guide: {
          truth: "风琴声是地下室仪式的回响。",
          hook: "委托人邀请调查员查一夜消失的乐团。",
          clueTrail: [{
            sceneId: "scene-foyer",
            title: "进入门厅",
            goal: "拿到指向地下室的第一条线索",
            leadIn: "从委托开场直接抵达。",
            keyClues: [{ clueId: null, summary: "潮湿的脚印通向员工通道", pointsTo: "地下室" }],
            ifStuck: "守门人主动搭话，抱怨风琴声。",
          }],
          timeline: [{ when: "第二个雨夜", event: "风琴声再次响起，守门人失踪。" }],
          endings: [{ title: "封印", condition: "在仪式完成前烧毁乐谱", outcome: "剧院恢复寂静。" }],
          pacing: "第一小时内让玩家拿到票根。",
          preparation: preparation(),
        },
      },
    }]);

    const guide = await generateKeeperGuide({
      modulePackage: modulePackage(),
      provider: "codex",
      model: "",
      signal: new AbortController().signal,
    });
    expect(guide.schemaVersion).toBe(1);
    expect(guide.clueTrail[0]!.sceneId).toBe("scene-foyer");
    expect(guide.clueTrail[0]!.keyClues[0]).toEqual({ summary: "潮湿的脚印通向员工通道", pointsTo: "地下室" });
    expect(guide.endings[0]!.title).toBe("封印");
    expect(guide.preparation?.truth.kind).toBe("uncertain");
  });

  it("uses the native guide task and forwards cancellation instead of rejecting desktop mode", async () => {
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    invokeNative.mockImplementation((command) => command === "run_keeper_guide" ? new Promise(() => {}) : Promise.resolve(true));
    const controller = new AbortController();
    const result = generateKeeperGuide({ modulePackage: modulePackage(), sourceText: "乐团被地下室仪式困住。", provider: "codex", model: "", signal: controller.signal });
    const rejection = expect(result).rejects.toThrow();
    expect(invokeNative).toHaveBeenCalledWith("run_keeper_guide", expect.objectContaining({ request: expect.objectContaining({ provider: "codex", digest: expect.stringContaining("乐团被地下室仪式困住。") }) }));
    controller.abort();
    await rejection;
    expect(invokeNative).toHaveBeenCalledWith("cancel_keeper_guide", expect.objectContaining({ requestId: expect.any(String) }));
  });
});

describe("guide evidence", () => {
  const guide = (): KeeperGuideV1 => ({ schemaVersion: 1, truth: "真相", hook: "委托", clueTrail: [], timeline: [], endings: [], pacing: "", preparation: preparation() });
  it("preserves exact evidence, downgrades invented quotes, and never changes optional advice into facts", () => {
    const candidate = guide();
    candidate.preparation!.hook.sources = [{ sourceId: "source-original", excerpt: "原文没有这句话" }];
    const result = validateGuideEvidence(candidate, modulePackage(), "乐团被地下室仪式困住。");
    expect(result.preparation!.truth.kind).toBe("source");
    expect(result.preparation!.hook.kind).toBe("uncertain");
    expect(result.preparation!.hook.sources).toEqual([]);
    expect(result.preparation!.playerBriefing.kind).toBe("advice");
  });
  it("rejects a guide that points the keeper to nonexistent scenes", () => {
    const candidate = guide();
    candidate.preparation!.scenes[0]!.sceneId = "scene-invented";
    expect(() => validateGuideEvidence(candidate, modulePackage())).toThrow("不存在");
  });
  it("checks scene-specific publication references and verifies their keeper-only conditions", () => {
    const candidate = guide();
    candidate.preparation!.scenes[0]!.publicEntities = [{ kind: "npc", entityId: "npc-wrong-scene", text: "不该在这幕出现的人。", when: { title: "条件", text: "编造条件", kind: "source", sources: [{ sourceId: "source-original", excerpt: "不存在的原文" }] } }];
    expect(() => validateGuideEvidence(candidate, modulePackage())).toThrow("不属于这个场景");
    const input = modulePackage();
    input.scenes[0]!.npcIds.push("npc-wrong-scene");
    input.npcs.push({ id: "npc-wrong-scene", name: "守门人", description: "", role: "", motivation: "", traits: [], sourceRefs: [] });
    const result = validateGuideEvidence(candidate, input, "乐团被地下室仪式困住。");
    expect(result.preparation!.scenes[0]!.publicEntities![0]!.when).toMatchObject({ kind: "uncertain", sources: [] });
  });
});

it("automatically retries malformed step output once without restarting earlier pipeline stages", async () => {
  runWebDevelopmentAiTask.mockResolvedValueOnce([{ type: "error", error: { code: "INVALID_STRUCTURE" } }])
    .mockResolvedValueOnce([{ type: "result", result: { guide: { checks: [], findings: [] } } }]);
  const result = await runKeeperGuideStep({ modulePackage: modulePackage(), provider: "codex", model: "", signal: new AbortController().signal }, { workflowStage: "review" });
  expect(result).toEqual({ checks: [], findings: [] });
  expect(runWebDevelopmentAiTask).toHaveBeenCalledTimes(2);
  expect(JSON.parse(runWebDevelopmentAiTask.mock.calls[1]![1].digest)).toMatchObject({ workflowStage: "review", outputRetry: true });
});

it("stops after one format retry and never retries a cancelled request", async () => {
  runWebDevelopmentAiTask.mockResolvedValue([{ type: "error", error: { code: "INVALID_STRUCTURE" } }]);
  const options = { modulePackage: modulePackage(), provider: "codex" as const, model: "", signal: new AbortController().signal };
  await expect(runKeeperGuideStep(options, { workflowStage: "review" })).rejects.toThrow("INVALID_STRUCTURE");
  expect(runWebDevelopmentAiTask).toHaveBeenCalledTimes(2);
  runWebDevelopmentAiTask.mockClear();
  const controller = new AbortController();
  controller.abort(new Error("stop before retry"));
  await expect(runKeeperGuideStep({ ...options, signal: controller.signal }, { workflowStage: "review" })).rejects.toThrow("stop before retry");
  expect(runWebDevelopmentAiTask).not.toHaveBeenCalled();
});
