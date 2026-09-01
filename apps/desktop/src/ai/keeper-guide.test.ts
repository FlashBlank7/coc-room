import { describe, expect, it, vi } from "vitest";
import { modulePackageSchema, type ModulePackageV1 } from "@coc-room/protocol";
import { buildModuleDigest, generateKeeperGuide } from "./keeper-guide";

const { runWebDevelopmentAiTask, getSetting } = vi.hoisted(() => ({
  runWebDevelopmentAiTask: vi.fn(),
  getSetting: vi.fn(async () => undefined as string | undefined),
}));

vi.mock("./web-development-ai-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./web-development-ai-bridge")>();
  return { ...actual, runWebDevelopmentAiTask };
});

vi.mock("../data/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/repository")>();
  return { ...actual, getRepository: async () => ({ getSetting }) };
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
    sourceDocuments: [],
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
  it("keeps ids and structure so the guide can reference scenes and clues", () => {
    const digest = JSON.parse(buildModuleDigest(modulePackage())) as Record<string, unknown>;
    expect(digest.title).toBe("雨夜剧院");
    expect(digest.scenes).toMatchObject([{ id: "scene-foyer", keeperNotes: "守门人隐瞒了地下室。" }]);
    expect(digest.clues).toMatchObject([{ id: "clue-ticket", revealText: "票根背面写着一个座位号。", isCore: true }]);
  });
});

describe("generateKeeperGuide", () => {
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
  });
});
