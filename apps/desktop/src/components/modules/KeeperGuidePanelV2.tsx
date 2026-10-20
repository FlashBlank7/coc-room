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
import { KeeperPreparationReader } from "./KeeperPreparationReader";
import { LegacyKeeperGuideContent } from "./LegacyKeeperGuideContent";
import { getRepository } from "../../data/repository";

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

/** The live desk and library read the same preparation, including its evidence. */
export function KeeperGuideContentV2({ guide, modulePackage }: {
  readonly guide: KeeperGuideV1;
  readonly modulePackage?: ModulePackageV1;
}) {
  const [source, setSource] = useState<{ moduleId: string; revision: number; text: string }>();
  useEffect(() => {
    if (!guide.preparation || !modulePackage) return;
    let active = true;
    void getRepository().then((repository) => repository.getModule(modulePackage.moduleId, modulePackage.revision))
      .then((stored) => { if (active) setSource({ moduleId: modulePackage.moduleId, revision: modulePackage.revision, text: stored?.sourceText ?? "" }); })
      .catch(() => { if (active) setSource(undefined); });
    return () => { active = false; };
  }, [modulePackage?.moduleId, modulePackage?.revision, Boolean(guide.preparation)]);
  if (!guide.preparation || !modulePackage) return <LegacyKeeperGuideContent guide={guide} modulePackage={modulePackage} />;
  const sourceText = source?.moduleId === modulePackage.moduleId && source?.revision === modulePackage.revision ? source.text : "";
  const hasLegacySupplement = guide.clueTrail.length || guide.timeline.length || guide.endings.length || guide.pacing
    || (guide.truth && guide.truth !== guide.preparation.truth.text) || (guide.hook && guide.hook !== guide.preparation.hook.text);
  return <>
    <KeeperPreparationReader key={`${modulePackage.moduleId}:${modulePackage.revision}`} modulePackage={{ ...modulePackage, keeperGuide: guide }} sourceText={sourceText} />
    {Boolean(hasLegacySupplement) && <details aria-label="旧版补充参考" className="mt-3 border-t border-zinc-800 pt-3"><summary className="cursor-pointer text-xs text-zinc-400">旧版补充参考</summary><div className="mt-3"><LegacyKeeperGuideContent guide={guide} modulePackage={modulePackage} /></div></details>}
  </>;
}
