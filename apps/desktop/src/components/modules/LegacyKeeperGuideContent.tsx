import type { KeeperGuideV1, ModulePackageV1 } from "@coc-room/protocol";

/** Read-only rendering, shared between the library card and the room workbench. */
export function LegacyKeeperGuideContent({
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
