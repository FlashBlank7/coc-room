// @vitest-environment jsdom
// Opt-in: validate an actual provider result against its source, then exercise
// three scenes on the real reducer. No model call and no claim of a human playtest.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { modulePackageSchema, type RoomEventProposalV2, type RoomWorldStateV2 } from "@coc-room/protocol";
import { generateKeeperGuide } from "../../ai/keeper-guide";
// These recorded pre-workflow outputs exercise batch assembly, not fresh workflow stages.
import { prepareKeeperGuideBatches as prepareKeeperGuide } from "../../ai/keeper-preparation";
import { guideNotes } from "../../ai/keeper-guide-context";
import type { KeeperGuideV1 } from "@coc-room/protocol";
import { KeeperPreparationReader } from "../../components/modules/KeeperPreparationReader";
import { KeeperGuideContentV2 } from "../../components/modules/KeeperGuidePanelV2";
import { CharacterBriefingEditor } from "../../components/characters/CharacterBriefingEditor";
import { CharacterCreationGuidance } from "../../components/characters/CharacterCreationGuidance";
import { KeeperModuleWorkbenchV2 } from "../../components/room/v2/InvestigationWorkspaceV2";
import { DirectCheckComposer } from "../../components/room/v2/DirectCheckComposer";
import { auditCharacterCreation, characterPromptWithBriefing } from "../../lib/character-creation-guidance";
import { enableSkillAllocation } from "../../lib/character-skill-allocation";
import { presentModuleSceneV2 } from "../../components/room/v2/investigation-workspace-helpers";
import { requireCompleteScenePublications } from "../../lib/scene-publications";
import type { RoomSessionV2 } from "../../network/RoomSessionV2";
import { commitMiniInvestigationProposal, createMiniInvestigationWorld, miniHostSeat, miniPlayerSeat, miniInvestigator } from "../scenarios/mini-investigation";

const { runWebDevelopmentAiTask } = vi.hoisted(() => ({ runWebDevelopmentAiTask: vi.fn() }));
vi.mock("../../ai/web-development-ai-bridge", () => ({ runWebDevelopmentAiTask }));
afterEach(cleanup);

it.skipIf(!process.env.COC_REAL_GUIDE_DIR || !existsSync(resolve(process.env.COC_REAL_GUIDE_DIR ?? ".", "keeper-contract-single-preparation-result.json")))("reads an actual preparation-only opening in both the library and live desk without needing a second generated summary", async () => {
  const directory = resolve(process.env.COC_REAL_GUIDE_DIR!);
  const { title: _title, sourceCoverage: _coverage, sources, preparationScope: _scope, preparationCastIds, ...rawModule } = JSON.parse(readFileSync(resolve(directory, "keeper-contract-comparison-input.json"), "utf8"));
  const modulePackage = modulePackageSchema.parse({ ...rawModule, extensions: {} });
  const output = JSON.parse(readFileSync(resolve(directory, "keeper-contract-single-preparation-result.json"), "utf8"));
  expect(output.guide.clueTrail).toEqual([]);
  runWebDevelopmentAiTask.mockReset();
  runWebDevelopmentAiTask.mockResolvedValueOnce([{ type: "result", result: output }]);
  const guide = await generateKeeperGuide({ modulePackage, sourceText: sources[0].text, preparationScope: "opening", preparationCastIds, provider: "codex", model: "", signal: new AbortController().signal });
  expect(guide.preparation!.cast.map((npc) => npc.npcId).sort()).toEqual([...preparationCastIds].sort());
  const opening = guide.preparation!.scenes[0]!;
  requireCompleteScenePublications(modulePackage, opening.sceneId, opening.publicEntities);
  for (const note of guideNotes(guide)) for (const quote of note.sources) expect(sources[0].text).toContain(quote.excerpt);
  const prepared = { ...modulePackage, keeperGuide: guide };
  const library = render(<KeeperPreparationReader modulePackage={prepared} sourceText={sources[0].text} />);
  const truthArticle = () => screen.getByRole("heading", { name: guide.preparation!.truth.title }).closest("article")!;
  expect(truthArticle().textContent).toContain(guide.preparation!.truth.text);
  library.unmount();
  render(<KeeperGuideContentV2 guide={guide} modulePackage={prepared} />);
  expect(truthArticle().textContent).toContain(guide.preparation!.truth.text);
  expect(screen.queryByLabelText("旧版补充参考")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "每一幕怎么带" }));
  expect(screen.getByText(opening.openingDraft)).toBeTruthy();
  for (const action of opening.actions) expect(screen.getByText(action.response.text)).toBeTruthy();
  for (const pitfall of opening.pitfalls) expect(screen.getByText(pitfall.text)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "调查途径与结局" }));
  for (const ending of guide.preparation!.endings) expect(screen.getByText(ending.text)).toBeTruthy();
});

it.skipIf(!process.env.COC_REAL_GUIDE_DIR || !existsSync(resolve(process.env.COC_REAL_GUIDE_DIR ?? ".", "real-scene-supplement-result.json")))("supplements an actual older runbook while retaining its explanation and the model's cross-scene restriction", async () => {
  const directory = resolve(process.env.COC_REAL_GUIDE_DIR!);
  const { title: _title, sourceCoverage: _coverage, sources, ...rawModule } = JSON.parse(readFileSync(resolve(directory, "real-keeper-guide-input.json"), "utf8"));
  const modulePackage = modulePackageSchema.parse({ ...rawModule, extensions: {} });
  runWebDevelopmentAiTask.mockReset();
  runWebDevelopmentAiTask.mockResolvedValueOnce([{ type: "result", result: JSON.parse(readFileSync(resolve(directory, "real-keeper-guide-result.json"), "utf8")) }]);
  const original = await generateKeeperGuide({ modulePackage, sourceText: sources[0].text, provider: "codex", model: "", signal: new AbortController().signal });
  runWebDevelopmentAiTask.mockResolvedValueOnce([{ type: "result", result: JSON.parse(readFileSync(resolve(directory, "real-scene-supplement-result.json"), "utf8")) }]);
  const controller = new AbortController();
  let retained: KeeperGuideV1 | undefined;
  await expect(prepareKeeperGuide({ modulePackage: { ...modulePackage, keeperGuide: original }, sourceText: sources[0].text, provider: "codex", model: "", signal: controller.signal,
    onPartial: (guide) => { retained = guide; controller.abort(new Error("stop after supplementary batch")); },
  })).rejects.toThrow("stop after supplementary batch");
  expect(runWebDevelopmentAiTask).toHaveBeenCalledTimes(2);
  const digest = JSON.parse(runWebDevelopmentAiTask.mock.calls[1]![1].digest);
  expect(digest.preparationScope).toBe("scene-publications");
  expect(digest.preparationCastIds).toEqual([]);
  expect(digest.scenes.map((scene: { id: string }) => scene.id)).toEqual(modulePackage.scenes.slice(0, 3).map((scene) => scene.id));
  expect(retained!.preparation!.truth).toEqual(original.preparation!.truth);
  expect(retained!.preparation!.cast).toEqual(original.preparation!.cast);
  for (let index = 0; index < 3; index++) {
    const { publicEntities, ...scene } = retained!.preparation!.scenes[index]!;
    const { publicEntities: _oldEntries, ...before } = original.preparation!.scenes[index]!;
    expect(scene).toEqual(before);
    requireCompleteScenePublications(modulePackage, scene.sceneId, publicEntities);
  }
  expect(retained!.preparation!.scenes.slice(3)).toEqual(original.preparation!.scenes.slice(3));
  for (const note of guideNotes(retained!)) for (const quote of note.sources) expect(sources[0].text).toContain(quote.excerpt);
  const ghost = retained!.preparation!.scenes[1]!.publicEntities!.find((entry) => entry.name === "花小路的残魂")!;
  expect(ghost.when.kind).toBe("uncertain");
  expect(ghost.when.text).toMatch(/先去柳屋.*幻境/);
  expect(ghost.text).not.toContain("柳屋");
  const first = retained!.preparation!.scenes[0]!.publicEntities!;
  expect(first.find((entry) => entry.name === "扬屋")!.text).not.toMatch(/失踪|首饰|彼岸花/);
  expect(first.some((entry) => entry.name === "橘家的少爷")).toBe(true);
  expect(first.some((entry) => entry.name === "橘弥生")).toBe(false);
  writeFileSync(resolve(directory, "real-keeper-supplemented.cocmod.json"), JSON.stringify(modulePackageSchema.parse({ ...modulePackage, keeperGuide: retained }), null, 2) + "\n", "utf8");
});

it.skipIf(!process.env.COC_REAL_GUIDE_DIR || !existsSync(resolve(process.env.COC_REAL_GUIDE_DIR ?? ".", "real-scene-publications-result.json")))("reviews actual scene introductions, retains the route restriction and publishes only the chosen alias and stage", async () => {
  const directory = resolve(process.env.COC_REAL_GUIDE_DIR!);
  const { title: _title, sourceCoverage: _coverage, sources, ...rawModule } = JSON.parse(readFileSync(resolve(directory, "real-keeper-guide-input.json"), "utf8"));
  const modulePackage = modulePackageSchema.parse({ ...rawModule, extensions: {} });
  const output = JSON.parse(readFileSync(resolve(directory, "real-scene-publications-result.json"), "utf8"));
  const sourceText: string = sources[0].text;
  runWebDevelopmentAiTask.mockResolvedValue([{ type: "result", result: output }]);
  const guide = await generateKeeperGuide({ modulePackage: { ...modulePackage, scenes: modulePackage.scenes.slice(0, 3) }, sourceText, preparationScope: "scene-publications", provider: "codex", model: "", signal: new AbortController().signal });
  for (const scene of guide.preparation!.scenes) requireCompleteScenePublications(modulePackage, scene.sceneId, scene.publicEntities);
  for (const note of guideNotes(guide)) for (const quote of note.sources) expect(sourceText).toContain(quote.excerpt);
  const opening = guide.preparation!.scenes[0]!;
  const yangya = opening.publicEntities!.find((entry) => entry.name === "扬屋")!;
  expect(yangya.text).not.toMatch(/失踪|首饰|彼岸花|纸张/);
  for (const name of ["花小路", "桃子"]) expect(opening.publicEntities!.some((entry) => entry.name === name && entry.text.trim())).toBe(true);
  const secretIdentity = modulePackage.npcs.find((npc) => npc.name === "安昙蝴蝶")!;
  const aliases = guide.preparation!.scenes.flatMap((scene) => scene.publicEntities ?? []).filter((entry) => entry.entityId === secretIdentity.id);
  expect(aliases.length).toBeGreaterThan(0);
  expect(aliases.every((entry) => entry.name === "蝴蝶" && !entry.text.includes("安昙"))).toBe(true);

  // Editorial correction after reading the source: the raw trial omitted this
  // cross-scene restriction. Keep raw output intact and label the ambiguity.
  const ghost = guide.preparation!.scenes.flatMap((scene) => scene.publicEntities ?? []).find((entry) => entry.name === "花小路的残魂")!;
  const routeQuote = sourceText.split(/\r?\n/u).find((line) => line.includes("如果调查员一定要先去柳屋"))!;
  expect(routeQuote).toBeTruthy();
  ghost.when = { ...ghost.when, kind: "uncertain", text: `${ghost.when.text}\n核对路线先后：启幕注明，先去柳屋就无法提前触发巴斯特的祝福，也无法进入猫咪的幻境。三味线段落没有进一步解释这条限制如何衔接见到残魂；遇到先去柳屋的队伍时，需要先对照这条限制裁定。`, sources: [...ghost.when.sources, { sourceId: sources[0].sourceId, excerpt: routeQuote }] };
  expect(ghost.when.text).toContain("先去柳屋");
  const base = modulePackageSchema.parse(JSON.parse(readFileSync(resolve(directory, "../初次主持试阅-前六幕.cocmod.json"), "utf8")));
  const prepared = modulePackageSchema.parse({ ...base, keeperGuide: { ...base.keeperGuide!, preparation: { ...base.keeperGuide!.preparation!, scenes: base.keeperGuide!.preparation!.scenes.map((scene) => ({ ...scene, publicEntities: guide.preparation!.scenes.find((entry) => entry.sceneId === scene.sceneId)?.publicEntities ?? scene.publicEntities })) } } });
  expect(prepared.keeperGuide!.preparation!.truth).toEqual(base.keeperGuide!.preparation!.truth);
  expect(prepared.keeperGuide!.preparation!.scenes[0]!.actions).toEqual(base.keeperGuide!.preparation!.scenes[0]!.actions);
  let world = createMiniInvestigationWorld();
  const proposals: RoomEventProposalV2[] = [];
  const session = { isHost: true, localSeat: miniHostSeat, get world() { return world; }, submitConfirmed: async (proposal: RoomEventProposalV2) => { proposals.push(proposal); world = commitMiniInvestigationProposal(world, miniHostSeat, proposal); return "accepted"; } } as unknown as RoomSessionV2;
  render(<KeeperModuleWorkbenchV2 modulePackage={prepared} session={session} world={world} />);
  await waitFor(() => expect((screen.getByLabelText("玩家可见介绍：扬屋") as HTMLTextAreaElement).value).toBe(yangya.text));
  const youngMaster = opening.publicEntities!.find((entry) => entry.name === "橘家的少爷")!;
  fireEvent.click(screen.getByText("准备一起登场的内容"));
  fireEvent.click(screen.getByRole("checkbox", { name: "橘家的少爷" }));
  fireEvent.click(screen.getByRole("button", { name: "预览一起登场" }));
  const preview = screen.getByLabelText("成组呈现公开预览");
  expect(preview.textContent).toContain(youngMaster.text);
  expect(preview.textContent).not.toContain("橘弥生");
  expect(preview.textContent).not.toContain(youngMaster.when.text);
  fireEvent.click(within(preview).getByRole("button", { name: "确认呈现场景与 1 项内容" }));
  await waitFor(() => expect([...world.entities.values()].some((entity) => entity.kind === "npc" && entity.name === "橘家的少爷")).toBe(true));
  expect(JSON.stringify(proposals)).not.toContain(youngMaster.when.text);
  expect(JSON.stringify(proposals)).not.toContain("橘弥生");
  writeFileSync(resolve(directory, "real-keeper-phase-reviewed.cocmod.json"), JSON.stringify(prepared, null, 2) + "\n", "utf8");
});

it.skipIf(!process.env.COC_REAL_GUIDE_DIR || !existsSync(resolve(process.env.COC_REAL_GUIDE_DIR ?? ".", "real-keeper-opening-result.json")))("validates the actual shorter opening and keeps its two discovery routes separate", async () => {
  const directory = resolve(process.env.COC_REAL_GUIDE_DIR!);
  const input = JSON.parse(readFileSync(resolve(directory, "real-keeper-guide-input.json"), "utf8"));
  const output = JSON.parse(readFileSync(resolve(directory, "real-keeper-opening-result.json"), "utf8"));
  const { title: _title, sourceCoverage: _coverage, sources, ...rawModule } = input;
  const modulePackage = modulePackageSchema.parse({ ...rawModule, extensions: {} });
  const sourceText: string = sources[0].text;
  runWebDevelopmentAiTask.mockResolvedValue([{ type: "result", result: output }]);
  const guide = await generateKeeperGuide({ modulePackage: { ...modulePackage, scenes: modulePackage.scenes.slice(0, 1) }, sourceText, provider: "codex", model: "", signal: new AbortController().signal });
  const prepared = modulePackageSchema.parse({ ...modulePackage, keeperGuide: guide });
  expect(guide.preparation!.scenes).toHaveLength(1);
  expect(guide.preparation!.cast).toHaveLength(5);
  for (const note of guideNotes(guide)) for (const quote of note.sources) expect(sourceText).toContain(quote.excerpt);
  expect(guideNotes(guide).filter((note) => note.kind === "source")).toHaveLength(JSON.stringify(output.guide.preparation).match(/"kind":"source"/gu)?.length ?? 0);
  const variants = guide.preparation!.publicClues!;
  expect(variants).toHaveLength(2);
  expect(variants[0]!.clueId).toBe(variants[1]!.clueId);
  expect(variants[0]!.text).not.toBe(variants[1]!.text);
  const onApplyClue = vi.fn();
  render(<KeeperPreparationReader modulePackage={prepared} sourceText={sourceText} onApplyClue={onApplyClue} />);
  fireEvent.click(screen.getByRole("button", { name: "每一幕怎么带" }));
  const drafts = screen.getByLabelText("本场发现的公开草稿");
  for (const draft of variants) {
    const row = within(drafts).getByText(draft.text).closest("section")!;
    expect(row.textContent).toContain(draft.when.text);
    fireEvent.click(within(row).getByRole("button", { name: "采用这条线索的公开文案" }));
    expect(onApplyClue).toHaveBeenLastCalledWith(draft.clueId, draft.text);
  }
  writeFileSync(resolve(directory, "real-keeper-opening.cocmod.json"), JSON.stringify(prepared, null, 2) + "\n", "utf8");
});

it.skipIf(!process.env.COC_REAL_GUIDE_DIR)("makes three actual module scenes readable and publishes only their previewed openings", async () => {
  const directory = resolve(process.env.COC_REAL_GUIDE_DIR!);
  const input = JSON.parse(readFileSync(resolve(directory, "real-keeper-guide-input.json"), "utf8"));
  const output = JSON.parse(readFileSync(resolve(directory, "real-keeper-guide-result.json"), "utf8"));
  const { title: _title, sourceCoverage: _coverage, sources, ...rawModule } = input;
  const modulePackage = modulePackageSchema.parse({ ...rawModule, extensions: {} });
  const sourceText: string = sources[0].text;
  runWebDevelopmentAiTask.mockResolvedValue([{ type: "result", result: output }]);
  const guide = await generateKeeperGuide({ modulePackage, sourceText, provider: "codex", model: "", signal: new AbortController().signal });
  const prepared = modulePackageSchema.parse({ ...modulePackage, keeperGuide: guide });
  expect(guide.preparation!.scenes).toHaveLength(modulePackage.scenes.length);
  const originalSourceNotes = JSON.stringify(output.guide.preparation).match(/"kind":"source"/gu)?.length;
  expect(guideNotes(guide).filter((note) => note.kind === "source")).toHaveLength(originalSourceNotes ?? 0);
  for (const note of guideNotes(guide)) for (const quote of note.sources) expect(sourceText).toContain(quote.excerpt);

  let world: RoomWorldStateV2 = createMiniInvestigationWorld();
  const proposals: RoomEventProposalV2[] = [];
  const session = { isHost: true, get world() { return world; }, submitConfirmed: async (proposal: RoomEventProposalV2) => {
    proposals.push(proposal); world = commitMiniInvestigationProposal(world, miniHostSeat, proposal); return "accepted";
  } } as unknown as RoomSessionV2;
  const applyOpening = vi.fn();
  render(<KeeperPreparationReader modulePackage={prepared} sourceText={sourceText} onApplyOpening={applyOpening} />);
  expect(screen.getByText(guide.preparation!.truth.text)).toBeTruthy();
  expect(screen.getByText(guide.preparation!.hook.text)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "每一幕怎么带" }));
  for (const scene of prepared.scenes.slice(0, 3)) {
    const reference = guide.preparation!.scenes.find((item) => item.sceneId === scene.id)!;
    expect(reference.actions.length).toBeGreaterThan(0);
    expect(reference.exits.length).toBeGreaterThan(0);
    expect(reference.pitfalls.length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("主持引导场景"), { target: { value: scene.id } });
    expect(screen.getByText(reference.purpose.text)).toBeTruthy();
    expect(screen.getByText(reference.pitfalls[0]!.text)).toBeTruthy();
    const evidence = within(screen.getByText(reference.purpose.text).closest("article")!);
    expect(evidence.getByText(/展开原文依据/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "采用为这一幕的玩家开场" }));
    expect(applyOpening).toHaveBeenLastCalledWith(scene.id, reference.openingDraft);
    await presentModuleSceneV2(session, prepared, scene, reference.openingDraft);
    expect(world.entities.get(world.activeSceneEntityId!)?.description).toBe(reference.openingDraft);
    expect(JSON.stringify(proposals)).not.toContain(reference.purpose.text);
  }
  expect(JSON.stringify(proposals)).not.toContain(guide.preparation!.truth.text);
  expect(proposals.every((proposal) => proposal.audience.kind === "room")).toBe(true);
  writeFileSync(resolve(directory, "real-keeper-prepared.cocmod.json"), JSON.stringify(prepared, null, 2) + "\n", "utf8");
});

it.skipIf(!process.env.COC_REAL_GUIDE_DIR || !existsSync(resolve(process.env.COC_REAL_GUIDE_DIR ?? ".", "real-keeper-batch-1-result.json")))("carries actual three-scene preparation through public character guidance, discoveries and an unexpected action", async () => {
  const directory = resolve(process.env.COC_REAL_GUIDE_DIR!);
  const input = JSON.parse(readFileSync(resolve(directory, "real-keeper-guide-input.json"), "utf8"));
  const output = JSON.parse(readFileSync(resolve(directory, "real-keeper-batch-1-result.json"), "utf8"));
  const { title: _title, sourceCoverage: _coverage, sources, ...rawModule } = input;
  let prepared = modulePackageSchema.parse({ ...rawModule, extensions: {} });
  const sourceText: string = sources[0].text;
  runWebDevelopmentAiTask.mockResolvedValue([{ type: "result", result: output }]);
  const guide = await generateKeeperGuide({ modulePackage: { ...prepared, scenes: prepared.scenes.slice(0, 3) }, sourceText, provider: "codex", model: "", signal: new AbortController().signal });
  prepared = modulePackageSchema.parse({ ...prepared, keeperGuide: guide });
  expect(guide.preparation!.scenes).toHaveLength(3);
  for (const note of guideNotes(guide)) for (const quote of note.sources) expect(sourceText).toContain(quote.excerpt);
  const proposals: RoomEventProposalV2[] = [];
  let world = createMiniInvestigationWorld();
  const session = { isHost: true, localSeat: miniHostSeat, get world() { return world; }, submitConfirmed: async (proposal: RoomEventProposalV2) => {
    proposals.push(proposal); world = commitMiniInvestigationProposal(world, miniHostSeat, proposal); return "accepted";
  } } as unknown as RoomSessionV2;

  // KP reviews the real module's public premise. Numeric caps below are explicit
  // test house rules, not rules inferred from the scenario or from CoC.
  render(<CharacterBriefingEditor session={session} world={world} modulePackage={prepared} />);
  fireEvent.click(screen.getByText("本团车卡说明与点数要求"));
  fireEvent.click(screen.getByRole("button", { name: "从主持引导填入公开草稿" }));
  fireEvent.click(screen.getByText("配置自动核算的房规"));
  fireEvent.change(screen.getByLabelText("八项属性总点（不含幸运）"), { target: { value: "400" } });
  fireEvent.change(screen.getByLabelText("技能购点总预算（不含基础值）"), { target: { value: "100" } });
  fireEvent.change(screen.getByLabelText("技能最终值上限"), { target: { value: "75" } });
  fireEvent.click(screen.getByRole("button", { name: "预览本团要求" }));
  expect(screen.getByLabelText("车卡要求公开预览").textContent).toContain(guide.preparation!.playerBriefing.text);
  expect(proposals).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "确认发布给玩家" }));
  await waitFor(() => expect(world.characterBriefing?.text).toBe(guide.preparation!.playerBriefing.text));
  cleanup();

  let character = { ...miniInvestigator, occupation: "作家", skills: miniInvestigator.skills.map((skill, index) => ({ ...skill, value: index ? skill.value : 80 })) };
  render(<CharacterCreationGuidance character={character} briefing={world.characterBriefing} />);
  expect(screen.getByLabelText("车卡待修改项").textContent).toContain("超出");
  cleanup();
  character = { ...character, characteristics: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 50 }, skills: character.skills.map((skill, index) => ({ ...skill, value: index ? skill.value : 65 })) };
  character = { ...enableSkillAllocation(character), creation: { ...enableSkillAllocation(character).creation!, occupationFormula: "edu4", occupationSkillIds: [character.skills[0]!.id], allocations: { [character.skills[0]!.id]: { occupation: 30, interest: 10 }, [character.skills[1]!.id]: { occupation: 0, interest: 30 } } } };
  expect(auditCharacterCreation(character, world.characterBriefing).issues).toEqual([]);
  const prompt = characterPromptWithBriefing("一位回应映夜委托的作家", world.characterBriefing);
  expect(prompt).toContain(guide.preparation!.playerBriefing.text);
  expect(prompt).not.toContain(guide.preparation!.truth.text);
  world = commitMiniInvestigationProposal(world, miniPlayerSeat, { type: "character.updated", audience: { kind: "room" }, payload: { character } });

  let publishedDiscoveries = 0;
  for (const scene of prepared.scenes.slice(0, 3)) {
    const reference = guide.preparation!.scenes.find((item) => item.sceneId === scene.id)!;
    const discovery = guide.preparation!.publicClues!.find((clue) => scene.clueIds.includes(clue.clueId))!;
    expect(discovery).toBeTruthy();
    const clue = prepared.clues.find((item) => item.id === discovery.clueId)!;
    render(<KeeperPreparationReader modulePackage={prepared} sourceText={sourceText} onApplyOpening={(id, text) => {
      prepared = { ...prepared, scenes: prepared.scenes.map((item) => item.id === id ? { ...item, playerDescription: text } : item) };
    }} onApplyClue={(id, text) => {
      prepared = { ...prepared, clues: prepared.clues.map((item) => item.id === id ? { ...item, revealText: text } : item) };
    }} />);
    fireEvent.click(screen.getByRole("button", { name: "每一幕怎么带" }));
    fireEvent.change(screen.getByLabelText("主持引导场景"), { target: { value: scene.id } });
    expect(screen.getByText(reference.pitfalls[0]!.text)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "采用为这一幕的玩家开场" }));
    const draftRow = screen.getByRole("heading", { name: clue.name }).closest("section")!;
    expect(within(draftRow).getByText(discovery.when.text)).toBeTruthy();
    fireEvent.click(within(draftRow).getByRole("button", { name: "采用这条线索的公开文案" }));
    expect(world.artifacts.size).toBe(publishedDiscoveries);
    cleanup();

    await presentModuleSceneV2(session, prepared, scene, reference.openingDraft);
    render(<KeeperModuleWorkbenchV2 modulePackage={prepared} world={world} session={session} />);
    const publication = within(screen.getByLabelText(`模组线索：${clue.name}`));
    expect(publication.getByLabelText(`发现条件：${clue.name}`).textContent).toContain(discovery.when.text);
    expect(publication.getByLabelText(`公开预览：${clue.isCore ? "核心 · " : ""}${clue.name}`).textContent).toContain(discovery.text);
    // The KP, not this test, decides when the discovery condition is satisfied.
    fireEvent.click(publication.getByRole("button", { name: "公开到调查案卷" }));
    await waitFor(() => expect([...world.artifacts.values()].some((artifact) => artifact.body === discovery.text)).toBe(true));
    publishedDiscoveries += 1;
    cleanup();
    expect(JSON.stringify(proposals)).not.toContain(discovery.when.text);
    expect(JSON.stringify(proposals)).not.toContain(reference.purpose.text);
  }

  // A deviation can use KP's current-scene guidance and a direct check without
  // transcribing a complete action workflow first. No hidden consequence is sent.
  render(<DirectCheckComposer session={session} world={world} preset={{ skill: "侦查", difficulty: "regular" }} />);
  fireEvent.change(screen.getByLabelText("直接检定公开说明"), { target: { value: "我先检查窗外是否有人尾随，再决定是否离开。" } });
  fireEvent.click(screen.getByRole("button", { name: "发给调查员掷骰" }));
  await waitFor(() => expect(world.checkAuthorizations.size).toBe(1));
  expect([...world.checkAuthorizations.values()][0]!.requesterSeatId).toBe(miniPlayerSeat.seatId);
  expect(JSON.stringify(proposals)).not.toContain(guide.preparation!.truth.text);
  expect(world.artifacts.size).toBe(3);
  writeFileSync(resolve(directory, "real-keeper-first-three.cocmod.json"), JSON.stringify(modulePackageSchema.parse(prepared), null, 2) + "\n", "utf8");
});

it.skipIf(!process.env.COC_REAL_GUIDE_DIR || !existsSync(resolve(process.env.COC_REAL_GUIDE_DIR ?? ".", "real-keeper-batch-2-result.json")))("merges two real provider batches and retains six scenes when the keeper stops", async () => {
  const directory = resolve(process.env.COC_REAL_GUIDE_DIR!);
  const { title: _title, sourceCoverage: _coverage, sources, ...rawModule } = JSON.parse(readFileSync(resolve(directory, "real-keeper-guide-input.json"), "utf8"));
  const modulePackage = modulePackageSchema.parse({ ...rawModule, extensions: {} });
  runWebDevelopmentAiTask.mockReset();
  runWebDevelopmentAiTask.mockResolvedValueOnce([{ type: "result", result: JSON.parse(readFileSync(resolve(directory, "real-keeper-batch-1-result.json"), "utf8")) }]);
  const initial = await generateKeeperGuide({ modulePackage: { ...modulePackage, scenes: modulePackage.scenes.slice(0, 3) }, sourceText: sources[0].text, provider: "codex", model: "", signal: new AbortController().signal });
  runWebDevelopmentAiTask.mockResolvedValueOnce([{ type: "result", result: JSON.parse(readFileSync(resolve(directory, "real-keeper-batch-2-result.json"), "utf8")) }]);
  const controller = new AbortController();
  const progress: number[] = [3];
  let partial: KeeperGuideV1 | undefined;
  await expect(prepareKeeperGuide({ modulePackage: { ...modulePackage, keeperGuide: initial }, sourceText: sources[0].text, provider: "codex", model: "", signal: controller.signal, onPartial: (guide) => {
    partial = guide;
    progress.push(guide.preparation!.scenes.length);
    if (guide.preparation!.scenes.length === 6) controller.abort(new Error("keeper stopped after six scenes"));
  } })).rejects.toThrow("keeper stopped after six scenes");
  expect(progress).toEqual([3, 6]);
  expect(runWebDevelopmentAiTask).toHaveBeenCalledTimes(2);
  expect(partial!.preparation!.publicClues!.length).toBeGreaterThanOrEqual(8);
  expect(partial!.preparation!.cast.length).toBeGreaterThan(0);
  const prepared = modulePackageSchema.parse({ ...modulePackage, keeperGuide: partial });
  for (const note of guideNotes(partial!)) for (const quote of note.sources) expect(sources[0].text).toContain(quote.excerpt);
  writeFileSync(resolve(directory, "real-keeper-six-scenes.cocmod.json"), JSON.stringify(prepared, null, 2) + "\n", "utf8");
});
