import { beforeEach, expect, it, vi } from "vitest";
import { type KeeperGuideV1, type KeeperReview, type ModulePackageV1 } from "@coc-room/protocol";
import { miniModule } from "../test/scenarios/mini-investigation";
import { keeperInputHash, prepareKeeperGuide } from "./keeper-workflow";
import { generateKeeperGuide, runKeeperGuideStep, type GenerateKeeperGuideOptions } from "./keeper-guide";

vi.mock("./keeper-guide", async (original) => ({ ...await original<typeof import("./keeper-guide")>(), generateKeeperGuide: vi.fn(), runKeeperGuideStep: vi.fn() }));
const sourceText = "先向守门人取得钥匙，才可进入地下室。窗户不能通向地下室。";
const note = { title: "地下室前提", text: sourceText, kind: "source" as const, sources: [{ sourceId: "source-original", excerpt: sourceText }] };
const modulePackage: ModulePackageV1 = { ...miniModule, keeperGuide: undefined,
  sourceDocuments: [{ id: "source-original", name: "原文", mediaType: "text/plain" }],
  scenes: [{ ...miniModule.scenes[0]!, npcIds: [], locationIds: [], clueIds: [], suggestedCheckIds: [] }], npcs: [], locations: [],
};
const fact = { id: "fact-key", category: "route" as const, sceneIds: [modulePackage.scenes[0]!.id], note };
const clean: KeeperReview = { checks: [{ factId: fact.id, verdict: "covered", reason: "已区分前提与替代建议" }], findings: [] };
const issue: KeeperReview = { checks: [{ factId: fact.id, verdict: "issue", reason: "写成可以绕过钥匙" }], findings: [{ severity: "error", sceneIds: fact.sceneIds, field: "scenes[0].openingDraft", note }] };
function candidate(options: GenerateKeeperGuideOptions): KeeperGuideV1 {
  return { schemaVersion: 1, truth: note.text, hook: note.text, clueTrail: [], timeline: [], endings: [], pacing: "", preparation: {
    truth: note, hook: note, essentials: [note], playerBriefing: note, timeline: [], endings: [], cast: [], publicClues: [],
    scenes: options.modulePackage.scenes.map((scene) => ({ sceneId: scene.id, purpose: note, openingDraft: options.workflowContext?.workflowStage === "repair" ? "先寻找钥匙。" : "从窗户直入地下室。", actions: [], exits: [], pitfalls: [], publicEntities: [] })),
  } };
}
function options(guide?: KeeperGuideV1) { return { modulePackage: { ...modulePackage, keeperGuide: guide }, sourceText, provider: "codex" as const, model: "", semanticReview: true, signal: new AbortController().signal }; }
function setupReview(resolve: (context: Record<string, unknown>) => KeeperReview = () => clean) {
  vi.mocked(runKeeperGuideStep).mockImplementation(async (_options, context = {}) => {
    if (context.workflowStage === "extract") return { facts: [fact] };
    if (context.workflowStage === "plan") return { scenes: _options.modulePackage.scenes.map((scene) => ({ sceneId: scene.id, factIds: [], purpose: "取得钥匙后调查", alternativeRoutes: note })) };
    if (context.workflowStage === "patch") return candidate({ ..._options, workflowContext: { ...context, workflowStage: "repair" } });
    return resolve(context);
  });
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(generateKeeperGuide).mockImplementation(async (request) => candidate(request)); setupReview(); });

it("keeps the input identity across a formal revision save but changes it with source edits", async () => {
  const original = await keeperInputHash(modulePackage, sourceText, "codex", "");
  expect(await keeperInputHash({ ...modulePackage, revision: 20, metadata: { ...modulePackage.metadata, updatedAt: new Date().toISOString() } }, sourceText, "codex", "")).toBe(original);
  expect(await keeperInputHash(modulePackage, sourceText + "new source", "codex", "")).not.toBe(original);
});

it("extracts, plans, independently reviews and repairs, then audits the merged result", async () => {
  setupReview((context) => JSON.stringify(context.candidate).includes("从窗户直入") ? issue : clean);
  const checkpoints: KeeperGuideV1[] = [];
  const result = await prepareKeeperGuide({ ...options(), onPartial: (guide) => { checkpoints.push(guide); } });
  expect(vi.mocked(runKeeperGuideStep).mock.calls.map(([, context]) => context!.workflowStage)).toEqual(["extract", "plan", "review", "patch", "review", "review"]);
  expect(vi.mocked(generateKeeperGuide).mock.calls.map(([request]) => request.workflowContext!.workflowStage)).toEqual(["draft"]);
  expect(result.preparation!.scenes[0]!.openingDraft).toBe("先寻找钥匙。");
  expect(result.workflow?.stage).toBe("complete");
  expect(result.workflow?.plan?.scenes[0]?.factIds).toEqual([fact.id]);
  expect(checkpoints.filter((guide) => guide.workflow?.pending).every((guide) => !guide.preparation)).toBe(true);
});

it("uses a source-and-plan pipeline for keeper reference without semantic review or repair calls", async () => {
  setupReview(() => issue);
  const { semanticReview: _diagnostic, ...referenceOptions } = options();
  const result = await prepareKeeperGuide(referenceOptions);
  expect(vi.mocked(runKeeperGuideStep).mock.calls.map(([, context]) => context?.workflowStage)).toEqual(["extract", "plan"]);
  expect(generateKeeperGuide).toHaveBeenCalledOnce();
  expect(result.workflow?.audit).toBeUndefined();
  expect(result.workflow?.reviews).toEqual([]);
  expect(result.workflow?.stage).toBe("complete");
  expect(result.preparation?.scenes).toHaveLength(1);
});

it("continues a reference draft after interruption without repeating its generated prose", async () => {
  const abort = new AbortController();
  let saved: KeeperGuideV1 | undefined;
  await expect(prepareKeeperGuide({ ...options(), semanticReview: false, signal: abort.signal, onPartial: (guide) => {
    saved = guide;
    if (guide.workflow?.pending) abort.abort(new Error("stop after reference draft"));
  } })).rejects.toThrow("stop after reference draft");
  const result = await prepareKeeperGuide({ ...options(saved), semanticReview: false });
  expect(generateKeeperGuide).toHaveBeenCalledOnce();
  expect(result.preparation?.scenes).toHaveLength(1);
  expect(result.workflow?.pending).toBeUndefined();
  expect(result.workflow?.audit).toBeUndefined();
});

it("resumes a persisted draft at review without regenerating extraction, plan or prose", async () => {
  const abort = new AbortController();
  let saved: KeeperGuideV1 | undefined;
  await expect(prepareKeeperGuide({ ...options(), signal: abort.signal, onPartial: (guide) => {
    saved = guide;
    if (guide.workflow?.pending) abort.abort(new Error("stop after draft"));
  } })).rejects.toThrow("stop after draft");
  expect(saved?.workflow?.pending?.preparation.scenes).toHaveLength(1);
  vi.mocked(runKeeperGuideStep).mockClear();
  const result = await prepareKeeperGuide(options(saved));
  expect(generateKeeperGuide).toHaveBeenCalledOnce();
  expect(vi.mocked(runKeeperGuideStep).mock.calls.map(([, context]) => context!.workflowStage)).toEqual(["review", "review"]);
  expect(result.workflow?.pending).toBeUndefined();
});

it("resumes regeneration of a complete old guide without mistaking the old scenes for newly finished work", async () => {
  const original = await prepareKeeperGuide(options());
  vi.mocked(generateKeeperGuide).mockImplementation(async (request) => {
    const next = candidate(request);
    next.preparation!.scenes[0]!.openingDraft = "新一轮已经写完，等待审查。";
    return next;
  });
  const abort = new AbortController();
  let saved: KeeperGuideV1 | undefined;
  await expect(prepareKeeperGuide({ ...options(original), signal: abort.signal, onPartial: (guide) => {
    saved = guide;
    if (guide.workflow?.pending) abort.abort(new Error("interrupt regeneration"));
  } })).rejects.toThrow("interrupt regeneration");
  expect(saved?.preparation).toEqual(original.preparation);
  const result = await prepareKeeperGuide(options(saved));
  expect(generateKeeperGuide).toHaveBeenCalledTimes(2);
  expect(result.preparation!.scenes[0]!.openingDraft).toBe("新一轮已经写完，等待审查。");
  expect(result.workflow?.pending).toBeUndefined();
});

it("bounds automatic repair and exposes unresolved issues instead of reporting success", async () => {
  setupReview(() => issue);
  const result = await prepareKeeperGuide(options());
  expect(generateKeeperGuide).toHaveBeenCalledOnce();
  expect(vi.mocked(runKeeperGuideStep).mock.calls.filter(([, context]) => context?.workflowStage === "patch")).toHaveLength(2);
  expect(result.workflow?.stage).toBe("needs-review");
  expect(result.workflow?.audit?.findings).toEqual(issue.findings);
});

it("does not erase an unresolved batch finding just because the final reviewer overlooks it", async () => {
  let reviews = 0;
  setupReview(() => [1, 2, 4].includes(++reviews) ? issue : clean);
  const result = await prepareKeeperGuide(options());
  expect(result.workflow?.audit?.findings).toEqual([]);
  expect(result.workflow?.stage).toBe("needs-review");
});

it("lets a new request repair a completed needs-review result without regenerating the book", async () => {
  setupReview(() => issue);
  const unfinished = await prepareKeeperGuide(options());
  expect(unfinished.workflow?.finalRepair?.remaining).toEqual([]);
  vi.mocked(generateKeeperGuide).mockClear();
  vi.mocked(runKeeperGuideStep).mockClear();
  let reviews = 0;
  setupReview(() => ++reviews === 1 ? issue : clean);
  const result = await prepareKeeperGuide(options(unfinished));
  expect(result.workflow?.stage).toBe("complete");
  expect(generateKeeperGuide).not.toHaveBeenCalled();
  expect(vi.mocked(runKeeperGuideStep).mock.calls.filter(([, context]) => context?.workflowStage === "patch")).toHaveLength(1);
  expect(vi.mocked(runKeeperGuideStep).mock.calls.every(([, context]) => ["review", "patch"].includes(String(context?.workflowStage)))).toBe(true);
  expect(vi.mocked(runKeeperGuideStep).mock.calls[0]![1]?.priorFindings).toEqual(expect.arrayContaining(unfinished.workflow!.audit!.findings));
});

it("still limits a new needs-review request to one final repair pass", async () => {
  setupReview(() => issue);
  const unfinished = await prepareKeeperGuide(options());
  vi.mocked(generateKeeperGuide).mockClear();
  vi.mocked(runKeeperGuideStep).mockClear();
  const result = await prepareKeeperGuide(options(unfinished));
  expect(result.workflow?.stage).toBe("needs-review");
  expect(generateKeeperGuide).not.toHaveBeenCalled();
  expect(vi.mocked(runKeeperGuideStep).mock.calls.filter(([, context]) => context?.workflowStage === "patch")).toHaveLength(1);
});

it("repairs an error found only after merging, then audits the repaired content", async () => {
  setupReview((context) => context.reviewScope === "audit" && JSON.stringify(context.candidate).includes("从窗户直入") ? issue : clean);
  const result = await prepareKeeperGuide(options());
  expect(result.preparation!.scenes[0]!.openingDraft).toBe("先寻找钥匙。");
  expect(generateKeeperGuide).toHaveBeenCalledOnce();
  expect(result.workflow?.finalRepair?.remaining).toEqual([]);
  expect(result.workflow?.stage).toBe("complete");
});

it("repairs global prose even when the finding names only a later affected scene", async () => {
  const second = { ...modulePackage.scenes[0]!, id: "scene-second", name: "Second" };
  vi.mocked(generateKeeperGuide).mockImplementation(async (request) => {
    const draft = candidate(request);
    draft.preparation!.truth = { ...note, text: request.workflowContext?.workflowStage === "repair" ? note.text : "Wrong global summary" };
    return draft;
  });
  setupReview((context) => context.reviewScope === "audit" && JSON.stringify(context.candidate).includes("Wrong global")
    ? { ...issue, findings: [{ ...issue.findings[0]!, sceneIds: [second.id], field: "candidate.preparation.truth.text" }] } : clean);
  const result = await prepareKeeperGuide({ ...options(), modulePackage: { ...modulePackage, scenes: [...modulePackage.scenes, second] } });
  expect(result.preparation!.truth.text).toBe(note.text);
  expect(result.preparation!.scenes).toHaveLength(2);
  expect(result.workflow?.stage).toBe("complete");
});

it("retains a shared-note correction made while repairing only a later scene", async () => {
  const second = { ...modulePackage.scenes[0]!, id: "scene-second", name: "Second" };
  setupReview((context) => context.reviewScope === "audit" && JSON.stringify(context.candidate).includes("从窗户直入")
    ? { ...issue, findings: [{ ...issue.findings[0]!, sceneIds: [second.id], field: "candidate.preparation.scenes[1].openingDraft" }] } : clean);
  const original = vi.mocked(runKeeperGuideStep).getMockImplementation()!;
  vi.mocked(runKeeperGuideStep).mockImplementation(async (request, context = {}) => {
    if (context.workflowStage !== "patch") return original(request, context);
    const repaired = candidate({ ...request, workflowContext: { workflowStage: "repair" } });
    repaired.preparation!.truth = { ...note, text: "共同前提已经补齐。" };
    return repaired;
  });
  const result = await prepareKeeperGuide({ ...options(), modulePackage: { ...modulePackage, scenes: [...modulePackage.scenes, second] } });
  expect(result.preparation!.truth.text).toBe("共同前提已经补齐。");
  expect(result.preparation!.scenes).toHaveLength(2);
  expect(result.preparation!.scenes[1]!.openingDraft).toBe("先寻找钥匙。");
  expect(vi.mocked(runKeeperGuideStep).mock.calls.filter(([, context]) => context?.workflowStage === "patch")).toHaveLength(1);
});

it("resumes a final repair candidate at review without repeating its rewrite", async () => {
  setupReview((context) => context.reviewScope === "audit" && JSON.stringify(context.candidate).includes("从窗户直入") ? issue : clean);
  const abort = new AbortController();
  let saved: KeeperGuideV1 | undefined;
  await expect(prepareKeeperGuide({ ...options(), signal: abort.signal, onPartial: (guide) => {
    saved = guide;
    if (guide.workflow?.finalRepair && guide.workflow.pending?.repairs === 1) abort.abort(new Error("stop after final repair"));
  } })).rejects.toThrow("stop after final repair");
  expect(saved?.workflow?.pending?.repairs).toBe(1);
  const result = await prepareKeeperGuide(options(saved));
  expect(generateKeeperGuide).toHaveBeenCalledOnce();
  expect(result.workflow?.stage).toBe("complete");
  expect(result.preparation!.scenes[0]!.openingDraft).toBe("先寻找钥匙。");
});

it("retains source contradictions even if a reviewer claims the draft is fine", async () => {
  vi.mocked(runKeeperGuideStep).mockImplementationOnce(async () => ({ facts: [{ ...fact, category: "contradiction", note: { ...note, kind: "uncertain" } }] }));
  const result = await prepareKeeperGuide(options());
  expect(result.workflow?.stage).toBe("needs-review");
});

it("corrects a mistaken ledger interpretation before asking the writer to repair it", async () => {
  const correction: KeeperReview = { ...issue, findings: [{ ...issue.findings[0]!, field: `workflowEvidence.facts.${fact.id}`, note }] };
  let reviews = 0;
  setupReview(() => ++reviews === 1 ? correction : reviews === 2 ? issue : clean);
  vi.mocked(runKeeperGuideStep).mockImplementationOnce(async () => ({ facts: [{ ...fact, note: { ...note, kind: "uncertain", text: "误将原文理解为两个矛盾的前提" } }] }));
  const result = await prepareKeeperGuide(options());
  const repair = vi.mocked(runKeeperGuideStep).mock.calls.find(([, context]) => context?.workflowStage === "patch")![1]!;
  expect(repair.workflowEvidence).toEqual({ facts: [fact] });
  expect(result.workflow?.evidence?.facts[0]?.note).toEqual(note);
  expect(result.workflow?.stage).toBe("complete");
});

it("rejects incomplete review coverage while preserving the pending draft", async () => {
  setupReview(() => ({ checks: [], findings: [] }));
  let saved: KeeperGuideV1 | undefined;
  await expect(prepareKeeperGuide({ ...options(), onPartial: (guide) => { saved = guide; } })).rejects.toThrow("没有逐条核对");
  expect(saved?.workflow?.pending).toBeDefined();
  expect(saved?.workflow?.stage).toBe("review");
});

it("does not accept not-applicable as a way to skip a relevant condition", async () => {
  setupReview(() => ({ checks: [{ factId: fact.id, verdict: "not-applicable", reason: "本批未涉及" }], findings: [] }));
  const result = await prepareKeeperGuide(options());
  expect(result.workflow?.stage).toBe("needs-review");
  expect(result.workflow?.audit?.findings[0]?.field).toBe(`facts.${fact.id}`);
});

it("invalidates cached work when source changes and retains manual prose when it is edited", async () => {
  const original = await prepareKeeperGuide(options());
  const edited = structuredClone(original);
  edited.preparation!.truth.text = "KP 手写解释";
  vi.mocked(generateKeeperGuide).mockClear();
  vi.mocked(runKeeperGuideStep).mockClear();
  const result = await prepareKeeperGuide({ ...options(edited), sourceText: sourceText + "新版补充。" });
  expect(runKeeperGuideStep).toHaveBeenCalledTimes(3);
  expect(generateKeeperGuide).not.toHaveBeenCalled();
  expect(result.preparation!.truth.text).toBe("KP 手写解释");
  expect(result.workflow?.inputHash).not.toBe(original.workflow?.inputHash);
});

it("rejects invalid source references as factual evidence instead of silently certifying them", async () => {
  vi.mocked(runKeeperGuideStep).mockImplementationOnce(async () => ({ facts: [{ ...fact, note: { ...note, sources: [{ sourceId: "source-original", excerpt: "原文里并没有的句子" }] } }] }));
  const result = await prepareKeeperGuide(options());
  expect(result.workflow?.evidence?.facts[0]?.note).toMatchObject({ kind: "uncertain", sources: [] });
  expect(result.workflow?.stage).toBe("needs-review");
});
