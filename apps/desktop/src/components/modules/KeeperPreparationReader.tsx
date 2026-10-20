import { useEffect, useState } from "react";
import type { KeeperGuideNoteV1, ModulePackageV1 } from "@coc-room/protocol";
import { keeperContentHash, keeperInputHash, unresolvedKeeperFindings } from "../../ai/keeper-workflow";
import { Button } from "../ui/Button";
import { LegacyKeeperGuideContent } from "./LegacyKeeperGuideContent";
import { publicClueVariantKey } from "../../lib/clue-discovery";
import { hasCompleteScenePublications, publicEntityVariantKey } from "../../lib/scene-publications";

export function GuideNote({ note, sourceText, modulePackage, onChange }: { note: KeeperGuideNoteV1; sourceText?: string; modulePackage?: ModulePackageV1; onChange?: (note: KeeperGuideNoteV1) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const [kind, setKind] = useState(note.kind);
  const hasOriginal = Boolean(sourceText && modulePackage?.sourceDocuments.length === 1);
  const quoteMismatch = note.kind === "source" && (!note.sources.length || (hasOriginal && note.sources.some((quote) => quote.sourceId !== modulePackage!.sourceDocuments[0]!.id || !sourceText!.includes(quote.excerpt))));
  const label = quoteMismatch ? "待核对" : note.kind === "source" ? "原文依据" : note.kind === "advice" ? "主持建议" : "待核对";
  return <article className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
    <div className="flex items-center gap-2"><h3 className="font-semibold text-zinc-100">{note.title}</h3><span className={`shrink-0 rounded px-2 py-0.5 text-[11px] ${note.kind === "uncertain" ? "bg-amber-950 text-amber-200" : "bg-zinc-800 text-zinc-400"}`}>{label}</span></div>
    {editing ? <div className="mt-3 grid gap-2"><textarea aria-label={`修改：${note.title}`} className="min-h-32 rounded border border-zinc-700 bg-zinc-950 p-3 text-sm leading-6" value={text} maxLength={8_000} onChange={(event) => setText(event.target.value)} /><label className="text-xs text-zinc-400">内容性质 <select aria-label={`内容性质：${note.title}`} className="rounded bg-zinc-900 p-2" value={kind} onChange={(event) => setKind(event.target.value as KeeperGuideNoteV1["kind"])}><option value="source" disabled={!note.sources.length}>原文依据</option><option value="advice">主持建议</option><option value="uncertain">待核对</option></select></label><div className="flex gap-2"><Button disabled={!text.trim()} onClick={() => { onChange?.({ ...note, text: text.trim(), kind }); setEditing(false); }}>保留修正</Button><Button variant="ghost" onClick={() => setEditing(false)}>取消</Button></div></div> : <><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-zinc-300">{note.text}</p>{onChange && <button className="mt-2 text-xs text-brass" onClick={() => { setText(note.text); setKind(note.kind); setEditing(true); }}>修改这条参考</button>}</>}
    {quoteMismatch && <p className="mt-2 text-xs text-amber-300">这条参考缺少引文，或引文与本机原文不符，请核对后再使用。</p>}
    {note.sources.length > 0 && <details className="mt-3 text-xs text-zinc-400"><summary className="cursor-pointer text-brass">展开原文依据（{note.sources.length} 处）</summary>
      <p className="mt-2">{hasOriginal ? "可对照本机原文核对引文；AI 对它的解释仍可能需要修正。" : "以下引文随模组包提供，当前未附完整原文，尚未在此处复核。"}</p>
      {note.sources.map((quote, index) => {
        const canLocate = sourceText && modulePackage?.sourceDocuments.length === 1 && modulePackage.sourceDocuments[0]!.id === quote.sourceId;
        const start = canLocate ? sourceText.indexOf(quote.excerpt) : -1;
        return <div key={index} className="mt-3 border-l-2 border-brass/40 pl-3">
          <p className="mb-1 text-zinc-500">{modulePackage?.sourceDocuments.find((source) => source.id === quote.sourceId)?.name ?? "模组原文"}</p>
          <blockquote className="whitespace-pre-wrap leading-6 text-zinc-200">{quote.excerpt}</blockquote>
          {start >= 0 && <details className="mt-2"><summary className="cursor-pointer">查看前后文</summary><p className="mt-2 whitespace-pre-wrap leading-6">{sourceText!.slice(Math.max(0, start - 350), start + quote.excerpt.length + 350)}</p></details>}
        </div>;
      })}
    </details>}
  </article>;
}

function WorkflowStatus({ modulePackage, sourceText, busy }: { modulePackage: ModulePackageV1; sourceText: string; busy: boolean }) {
  const guide = modulePackage.keeperGuide!;
  const workflow = guide.workflow!;
  const [current, setCurrent] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setCurrent(false);
    const { workflow: _workflow, ...content } = guide;
    void Promise.all([
      keeperContentHash(content),
      keeperInputHash(modulePackage, sourceText, workflow.provider, workflow.model),
    ]).then(([contentHash, inputHash]) => { if (!cancelled) setCurrent(contentHash === workflow.contentHash && inputHash === workflow.inputHash); }).catch(() => {});
    return () => { cancelled = true; };
  }, [guide, modulePackage, sourceText, workflow]);
  const labels = { extract: "梳理故事与条件", plan: "整理每幕及调查路线", draft: "编写主持参考与公开稿", review: "核对本批参考", repair: "修订本批问题", audit: "核对整份参考", complete: workflow.audit ? "自动核对完成" : "主持参考已生成", "needs-review": "主持参考已生成 · 原文有待核对处" };
  const findings = unresolvedKeeperFindings(workflow);
  const uncertain = workflow.evidence?.facts.filter((fact) => fact.note.kind === "uncertain") ?? [];
  return <section aria-label="主持参考核对进度" className="grid gap-2 rounded border border-brass/30 p-3 text-sm">
    <p role="status">{busy ? `正在${labels[workflow.stage]}` : !current ? workflow.audit ? "资料已改变或当前缺少原文，旧核对结果不能代表当前内容。" : "参考已保留；资料有变动或未附原文时，请结合当前资料调整。" : labels[workflow.stage]}</p>
    <p className="text-xs text-zinc-400">供 KP 查阅和调整；原文依据、主持建议和不确定处分别标注。已完成的参考会保留，可以接着整理。</p>
    {(!sourceText.trim() || modulePackage.sourceDocuments.length !== 1) && <p className="text-xs text-amber-200">当前未附可定位的完整原文，只能依据已有摘录核对。</p>}
    {(findings.length > 0 || uncertain.length > 0) && <details open={workflow.stage === "needs-review"}><summary className="cursor-pointer text-amber-200">查看待核对事项（{findings.length + uncertain.length}）</summary><div className="mt-3 grid gap-2">{uncertain.map((fact) => <GuideNote key={fact.id} note={fact.note} modulePackage={modulePackage} sourceText={sourceText} />)}{findings.map((finding, index) => <GuideNote key={index} note={finding.note} modulePackage={modulePackage} sourceText={sourceText} />)}</div></details>}
    {workflow.evidence && <details onToggle={(event) => setShowEvidence(event.currentTarget.open)}><summary className="cursor-pointer text-zinc-400">查看已提取的条件与依据</summary>{showEvidence && <div className="mt-3 grid gap-2">{workflow.evidence.facts.map((fact) => <GuideNote key={fact.id} note={fact.note} modulePackage={modulePackage} sourceText={sourceText} />)}</div>}</details>}
  </section>;
}

export function KeeperPreparationReader({ modulePackage, sourceText = "", busy = false, error, onGenerate, onStop, onApplyOpening, onApplyClue, onChangeNote }: {
  modulePackage: ModulePackageV1;
  sourceText?: string;
  busy?: boolean;
  error?: string;
  onGenerate?: () => void;
  onStop?: () => void;
  onApplyOpening?: (sceneId: string, text: string) => void;
  onApplyClue?: (clueId: string, text: string) => void;
  onChangeNote?: (original: KeeperGuideNoteV1, next: KeeperGuideNoteV1) => void;
}) {
  const [section, setSection] = useState<"start" | "cast" | "scenes" | "trail">("start");
  const [sceneId, setSceneId] = useState(modulePackage.scenes[0]?.id ?? "");
  const guide = modulePackage.keeperGuide;
  const preparation = guide?.preparation;
  const remainingScenes = modulePackage.scenes.filter((scene) => !preparation?.scenes.some((item) => item.sceneId === scene.id)).length;
  const remainingCast = modulePackage.npcs.filter((npc) => !preparation?.cast.some((item) => item.npcId === npc.id)).length;
  const remainingPublications = preparation?.scenes.filter((scene) => !hasCompleteScenePublications(modulePackage, scene.sceneId, scene.publicEntities)).length ?? 0;
  const selected = preparation?.scenes.find((scene) => scene.sceneId === sceneId) ?? preparation?.scenes[0];
  const selectedModuleScene = modulePackage.scenes.find((scene) => scene.id === selected?.sceneId);
  const publicClues = preparation?.publicClues?.filter((clue) => selectedModuleScene?.clueIds.includes(clue.clueId)) ?? [];
  const renderNote = (note: KeeperGuideNoteV1, key: string | number) => <GuideNote key={key} note={note} modulePackage={modulePackage} sourceText={sourceText} onChange={!busy && onChangeNote ? (next) => onChangeNote(note, next) : undefined} />;
  return <section aria-label="第一次带这个模组" className="mb-6 grid gap-4 rounded-xl border border-brass/40 bg-brass/5 p-5">
    <header><p className="text-xs text-brass">KP 备团引导 · 仅你可见</p><h2 className="mt-2 font-serif text-2xl">第一次带《{modulePackage.metadata.title}》，从这里开始</h2><p className="mt-2 text-sm leading-6 text-zinc-400">先理解真相和调查途径，再准备人物与第一幕。每条建议都标明依据；需要时就地展开原文。</p></header>
    {guide?.workflow && <WorkflowStatus modulePackage={modulePackage} sourceText={sourceText} busy={busy} />}
    {busy && <p role="status" className="text-sm text-amber-200">先整理故事概况与开场，再补后续场景和人物。已经完成的参考可以先读。</p>}
    {preparation && (remainingScenes > 0 || remainingCast > 0) && <p role="status" className="text-sm text-amber-200">已保留 {preparation.scenes.length} / {modulePackage.scenes.length} 幕、{preparation.cast.length} / {modulePackage.npcs.length} 位人物参考，可以先读。{busy ? "正在继续补全。" : "可以从已完成处继续整理。"}</p>}
    {remainingPublications > 0 && <p role="status" className="text-sm text-amber-200">还有 {remainingPublications} 幕缺少完整的人物与地点登场介绍。{busy ? "将继续补全；已有主持参考可以先读。" : "可以只补缺项，保留已有主持笔记和完整介绍；也可在现场手写。"}</p>}
    {error && <p role="alert" className="text-sm text-amber-200">{error}</p>}
    {!preparation && !busy && <div className="grid gap-3 text-sm leading-6 text-zinc-300">
      <p>{guide ? "这份资料有旧版运行指引，但还没有带出处的初次主持引导。可以先读下方内容，再补全人物扮演与逐场建议。" : "场景、人物和线索已经整理好，尚缺少解释它们如何组成故事的主持引导。"}</p>
      {!sourceText && <p className="text-xs text-amber-200">这份成品没有保留完整原文。补全时只使用已有资料与引文，无法确认的内容会标成“待核对”。</p>}
    </div>}
    {onGenerate && <Button variant="secondary" disabled={busy} onClick={onGenerate}>{busy ? "正在整理主持引导…" : preparation ? remainingScenes > 0 ? `继续整理余下 ${remainingScenes} 幕` : remainingCast > 0 ? `继续整理余下 ${remainingCast} 位人物` : remainingPublications > 0 ? `补全 ${remainingPublications} 幕登场资料` : "重新整理主持引导" : "补全初次主持引导"}</Button>}
    {busy && onStop && <Button variant="ghost" onClick={onStop}>停止整理，保留已有资料</Button>}
    {preparation ? <>
      <nav aria-label="主持引导章节" className="flex flex-wrap gap-2">{([ ["start", "先读这页"], ["cast", "人物怎么演"], ["scenes", "每一幕怎么带"], ["trail", "调查途径与结局"] ] as const).map(([id, label]) => <Button key={id} variant={section === id ? "primary" : "ghost"} aria-pressed={section === id} onClick={() => setSection(id)}>{label}</Button>)}</nav>
      {section === "start" && <div className="grid gap-3">{renderNote(preparation.truth, "truth")}{renderNote(preparation.hook, "hook")}<h3 className="mt-2 font-semibold">开场前必须掌握</h3>{preparation.essentials.map(renderNote)}<h3 className="mt-2 font-semibold">玩家车卡前需要知道什么</h3>{renderNote(preparation.playerBriefing, "brief")}<p className="text-xs text-zinc-400">这是给你的备团参考，尚未发给玩家。</p></div>}
      {section === "cast" && <div className="grid gap-5">{preparation.cast.length ? preparation.cast.map((npc) => <section key={npc.npcId} className="grid gap-2"><h3 className="font-serif text-xl text-brass">{modulePackage.npcs.find((item) => item.id === npc.npcId)?.name ?? "人物"}</h3>{npc.notes.map(renderNote)}</section>) : <p className="text-sm text-zinc-400">这份引导没有单列关键人物。可在下方人物资料中查看，或补充原文后重新整理。</p>}</div>}
      {section === "scenes" && <div className="grid gap-3">
        <label className="grid gap-2 text-sm">准备哪一幕<select aria-label="主持引导场景" className="rounded border border-zinc-700 bg-zinc-950 p-2" value={selected?.sceneId ?? ""} onChange={(event) => setSceneId(event.target.value)}>{preparation.scenes.map((scene) => <option key={scene.sceneId} value={scene.sceneId}>{modulePackage.scenes.find((item) => item.id === scene.sceneId)?.name ?? scene.sceneId}</option>)}</select></label>
        {selected ? <>{renderNote(selected.purpose, "purpose")}
          {selected.openingDraft && <section className="rounded-lg border border-emerald-900/50 bg-emerald-950/15 p-4"><h3 className="font-semibold text-emerald-200">开场怎么说 · 待确认草稿</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-zinc-200">{selected.openingDraft}</p>{onApplyOpening && <Button className="mt-3" variant="secondary" disabled={busy} onClick={() => onApplyOpening(selected.sceneId, selected.openingDraft)}>采用为这一幕的玩家开场</Button>}<p className="mt-2 text-xs text-zinc-400">采用只修改备团资料；进入房间后再确认公开。</p></section>}
          {selected.publicEntities?.length ? <section aria-label="本幕人物与地点介绍" className="grid gap-3"><h3 className="font-semibold">人物与地点此时怎么介绍</h3>{selected.publicEntities.map((entry) => <article key={publicEntityVariantKey(entry)} className="grid gap-2 rounded border border-emerald-900/50 p-3"><h4 className="text-emerald-200">{(entry.kind === "npc" ? modulePackage.npcs : modulePackage.locations).find((entity) => entity.id === entry.entityId)?.name}</h4>{renderNote(entry.when, publicEntityVariantKey(entry))}{entry.name && <p className="text-sm">玩家此时知道的称呼：{entry.name}</p>}<p className="whitespace-pre-wrap text-sm leading-7">{entry.text || "此时暂不向玩家介绍。"}</p><p className="text-xs text-zinc-400">仅供本幕使用；现场可修改后公开，登场条件不会发给玩家。</p></article>)}</section> : null}
          <h3 className="mt-2 font-semibold">玩家可能怎么查</h3>{selected.actions.map((action, index) => <section key={index} className="grid gap-2"><p className="text-sm text-brass">玩家：{action.intent}</p>{renderNote(action.response, index)}</section>)}
          <h3 className="mt-2 font-semibold">信息会把调查带向哪里</h3>{selected.exits.map(renderNote)}
          {publicClues.length > 0 && <section className="grid gap-3" aria-label="本场发现的公开草稿"><h3 className="font-semibold">发现后怎么告诉玩家</h3>{publicClues.map((clue) => <section key={publicClueVariantKey(clue)} className="grid gap-2 rounded-lg border border-emerald-900/50 p-3"><h4 className="text-emerald-200">{modulePackage.clues.find((item) => item.id === clue.clueId)?.name}</h4>{renderNote(clue.when, `when:${clue.clueId}`)}<p className="whitespace-pre-wrap text-sm leading-7">{clue.text}</p><p className="text-xs text-zinc-400">以上为公开文案草稿。只在满足发现条件后交给玩家；采用不会立即公开。</p>{publicClues.filter((item) => item.clueId === clue.clueId).length > 1 && <p className="text-xs text-amber-200">同一线索有不同发现版本，请按本次调查经过采用；采用会替换这条线索当前的公开文案。</p>}{onApplyClue && <Button variant="secondary" disabled={busy} onClick={() => onApplyClue(clue.clueId, clue.text)}>采用这条线索的公开文案</Button>}</section>)}</section>}
          <h3 className="mt-2 font-semibold">容易卡住或误读的地方</h3>{selected.pitfalls.map(renderNote)}
        </> : <p className="text-sm text-zinc-400">这份引导没有逐场建议，可从下方场景资料开始。</p>}
      </div>}
      {section === "trail" && <div className="grid gap-3"><h3 className="font-semibold">调查的各条途径</h3>{preparation.scenes.map((scene) => <section key={scene.sceneId} className="grid gap-2"><h4 className="text-brass">{modulePackage.scenes.find((item) => item.id === scene.sceneId)?.name}</h4>{scene.exits.map(renderNote)}</section>)}<h3 className="mt-2 font-semibold">时间和条件如何推动事件</h3>{preparation.timeline.map(renderNote)}<h3 className="mt-2 font-semibold">结局由哪些条件决定</h3>{preparation.endings.map(renderNote)}</div>}
    </> : guide ? <LegacyKeeperGuideContent guide={guide} modulePackage={modulePackage} /> : <div className="grid gap-2"><h3 className="font-semibold">目前已知的故事概况</h3><p className="whitespace-pre-wrap text-sm leading-7 text-zinc-300">{modulePackage.overview || modulePackage.metadata.summary || "原资料尚未提供概况，需要补全主持引导。"}</p></div>}
  </section>;
}
