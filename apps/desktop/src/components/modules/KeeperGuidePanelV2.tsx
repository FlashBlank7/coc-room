import { useEffect, useState } from "react";
import { Loader2, Map as MapIcon, Sparkles, Square } from "lucide-react";
import type { KeeperGuideV1, ModulePackageV1 } from "@coc-room/protocol";

import {
  isKeeperGuideRunning,
  keeperGuideRunError,
  startKeeperGuideRun,
  stopKeeperGuideRun,
  subscribeKeeperGuideRuns,
} from "../../ai/keeper-guide";
import { useAppStore } from "../../store/app-store";
import { Button } from "../ui/Button";

/**
 * 运行指引: the keeper's runbook for actually running a parsed module —
 * hidden truth, hook, clue trail with backup paths, timeline, endings, and
 * pacing. Parsing yields elements; this panel adds the layer that tells the
 * keeper what to do with them, and stores it on the module package itself so
 * it survives export and travels into the room workbench.
 */
export function KeeperGuidePanelV2({
  modulePackage,
  onSaved,
}: {
  readonly modulePackage: ModulePackageV1;
  readonly onSaved?: () => Promise<unknown> | void;
}) {
  // Runs live in a module-level manager, so navigating away and back keeps
  // both the spinner and the eventual result; the view only mirrors it.
  const [runTick, setRunTick] = useState(0);
  useEffect(() => subscribeKeeperGuideRuns(() => {
    setRunTick((tick) => tick + 1);
    void onSaved?.();
  }), [onSaved]);
  void runTick;
  const busy = isKeeperGuideRunning(modulePackage.moduleId);
  const error = keeperGuideRunError(modulePackage.moduleId);
  const guide = modulePackage.keeperGuide;

  const generate = () => {
    const state = useAppStore.getState();
    void startKeeperGuideRun({
      modulePackage,
      provider: state.parserProvider,
      model: state.parserProvider === "codex" ? state.codexModel : state.deepseekModel,
    });
  };

  const stop = () => stopKeeperGuideRun(modulePackage.moduleId);

  return (
    <details aria-label={`运行指引：${modulePackage.metadata.title}`} className="mt-3 border-t border-zinc-800 pt-2">
      <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300">
        <MapIcon className="h-3.5 w-3.5" />运行指引{guide ? <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] text-emerald-300">已生成</span> : <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">未生成</span>}
      </summary>
      <div className="mt-2 grid gap-2">
        {!guide && !busy && <p className="text-xs leading-5 text-zinc-500">解析只整理出了要素。运行指引会按真实模组的写法补上「背景真相 → 开场引入 → 线索链（含卡关补救）→ 时间线 → 结局 → 节奏建议」，让你照着就能跑。</p>}
        {busy && <p role="status" className="text-xs leading-5 text-amber-200/90">正在梳理运行指引（通常一到几分钟）。可以随意切换页面，完成后会以新版本出现在这里。</p>}
        {guide && <KeeperGuideContentV2 guide={guide} modulePackage={modulePackage} />}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" className="h-8 text-xs" disabled={busy} onClick={generate}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1.5 h-3.5 w-3.5" />}
            {busy ? "正在梳理运行指引…" : guide ? "重新生成运行指引" : "生成运行指引"}
          </Button>
          {busy && <Button variant="ghost" className="h-8 text-xs" onClick={stop}><Square className="mr-1.5 h-3 w-3" />停止</Button>}
        </div>
        {error && <p role="alert" className="rounded border border-red-900/60 bg-red-950/20 p-2 text-xs leading-5 text-red-300">{error}</p>}
      </div>
    </details>
  );
}

/** Read-only rendering, shared between the library card and the room workbench. */
export function KeeperGuideContentV2({
  guide,
  modulePackage,
}: {
  readonly guide: KeeperGuideV1;
  readonly modulePackage?: ModulePackageV1;
}) {
  const sceneName = (sceneId?: string) =>
    sceneId ? modulePackage?.scenes.find((scene) => scene.id === sceneId)?.name : undefined;
  const clueName = (clueId?: string) =>
    clueId ? modulePackage?.clues.find((clue) => clue.id === clueId)?.name : undefined;
  return (
    <div className="grid gap-2 text-xs leading-5 text-zinc-300">
      {guide.truth && <section className="rounded border border-red-900/40 bg-red-950/10 p-2">
        <h4 className="font-semibold text-red-200">背景真相（仅 KP）</h4>
        <p className="mt-1 whitespace-pre-wrap text-zinc-400">{guide.truth}</p>
      </section>}
      {guide.hook && <section className="rounded bg-zinc-950 p-2">
        <h4 className="font-semibold text-zinc-200">开场引入</h4>
        <p className="mt-1 whitespace-pre-wrap text-zinc-400">{guide.hook}</p>
      </section>}
      {guide.clueTrail.length > 0 && <section className="rounded bg-zinc-950 p-2">
        <h4 className="font-semibold text-zinc-200">线索链 · 怎么一步步跑</h4>
        <ol className="mt-1 grid gap-2">
          {guide.clueTrail.map((step, index) => <li key={`${step.title}-${index}`} className="rounded border border-zinc-800 p-2">
            <p className="font-medium text-brass">{index + 1}. {step.title}{sceneName(step.sceneId) ? <span className="ml-1 text-[10px] text-zinc-500">（场景：{sceneName(step.sceneId)}）</span> : null}</p>
            {step.goal && <p className="mt-1 text-zinc-400">目的：{step.goal}</p>}
            {step.leadIn && <p className="mt-1 text-zinc-400">进入：{step.leadIn}</p>}
            {step.keyClues.length > 0 && <ul className="mt-1 grid gap-1">
              {step.keyClues.map((clue, clueIndex) => <li key={clueIndex} className="rounded bg-black/25 p-1.5 text-zinc-400">
                <span className="text-zinc-200">🔍 {clueName(clue.clueId) ?? "线索"}</span>：{clue.summary}
                {clue.pointsTo && <span className="text-zinc-500"> → {clue.pointsTo}</span>}
              </li>)}
            </ul>}
            {step.ifStuck && <p className="mt-1 text-amber-200/80">卡关补救：{step.ifStuck}</p>}
          </li>)}
        </ol>
      </section>}
      {guide.timeline.length > 0 && <section className="rounded bg-zinc-950 p-2">
        <h4 className="font-semibold text-zinc-200">时间线 · 调查员不动，世界在动</h4>
        <ul className="mt-1 grid gap-1">
          {guide.timeline.map((entry, index) => <li key={index} className="text-zinc-400"><span className="text-zinc-200">{entry.when}</span> — {entry.event}</li>)}
        </ul>
      </section>}
      {guide.endings.length > 0 && <section className="rounded bg-zinc-950 p-2">
        <h4 className="font-semibold text-zinc-200">结局</h4>
        <ul className="mt-1 grid gap-1.5">
          {guide.endings.map((ending, index) => <li key={index} className="rounded border border-zinc-800 p-1.5">
            <p className="font-medium text-zinc-200">{ending.title}</p>
            {ending.condition && <p className="text-zinc-400">条件：{ending.condition}</p>}
            {ending.outcome && <p className="text-zinc-400">走向：{ending.outcome}</p>}
          </li>)}
        </ul>
      </section>}
      {guide.pacing && <section className="rounded bg-zinc-950 p-2">
        <h4 className="font-semibold text-zinc-200">节奏建议</h4>
        <p className="mt-1 whitespace-pre-wrap text-zinc-400">{guide.pacing}</p>
      </section>}
    </div>
  );
}
