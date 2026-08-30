import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { ModulePackageV1 } from "@coc-room/protocol";
import { Button } from "../ui/Button";
import { Field, Input, Textarea } from "../ui/Field";
import { removeEntityAndReferences } from "./structured-module-editor-helpers";

export { removeEntityAndReferences } from "./structured-module-editor-helpers";

type Collection =
  | "chapters"
  | "scenes"
  | "locations"
  | "npcs"
  | "clues"
  | "handouts"
  | "suggestedChecks"
  | "keeperNotes";

type EditorProps = {
  modulePackage: ModulePackageV1;
  onChange: (modulePackage: ModulePackageV1) => void;
};

/**
 * A deliberately small, schema-shaped editor. Every update starts with the
 * original entity and only replaces fields shown here; source references,
 * relationships, extensions, and future fields therefore survive an edit.
 */
export function StructuredModuleEditor({ modulePackage, onChange }: EditorProps) {
  const [open, setOpen] = useState<Collection | "metadata" | "overview">("overview");
  const entityIds = useMemo(() => collectEntityIds(modulePackage), [modulePackage]);

  const updateMetadata = (field: string, value: string | string[]) => {
    onChange({ ...modulePackage, metadata: { ...modulePackage.metadata, [field]: value } });
  };
  const updateOverview = (overview: string) => onChange({ ...modulePackage, overview });
  const updateEntity = (collection: Collection, id: string, patch: Record<string, unknown>) => {
    const items = modulePackage[collection] as Array<{ id: string }>;
    onChange({
      ...modulePackage,
      [collection]: items.map((item) => item.id === id ? { ...item, ...patch } : item),
    } as ModulePackageV1);
  };
  const addEntity = (collection: Collection) => {
    const id = nextEntityId(collection, entityIds);
    const item = newEntity(collection, id);
    onChange({ ...modulePackage, [collection]: [...modulePackage[collection], item] } as ModulePackageV1);
    setOpen(collection);
  };
  const removeEntity = (collection: Collection, id: string) => {
    const item = (modulePackage[collection] as Array<{ id: string }>).find((candidate) => candidate.id === id);
    const label = item ? entityDisplayName(item) : "这项资料";
    if (!window.confirm(`确认删除“${label}”？场景中对它的关联也会一起移除。此操作要在保存后才会生效。`)) return;
    onChange(removeEntityAndReferences(modulePackage, collection, id));
  };

  return (
    <section aria-label="模组检查与修正" className="grid gap-3">
      <div className="rounded-xl border border-brass/30 bg-brass/5 p-4">
        <h2 className="font-semibold text-ink">检查并修正</h2>
        <p className="mt-1 text-xs text-zinc-500">
          不必逐项重写。优先检查故事真相、开场，以及地点、人物和线索中绿色标注的“玩家会看到”内容。
        </p>
        <nav aria-label="资料分类" className="mt-3 flex flex-wrap gap-1.5">
          {([
            ["chapters", "章节"],
            ["scenes", "场景"],
            ["locations", "地点"],
            ["npcs", "NPC"],
            ["clues", "线索"],
            ["handouts", "手记"],
            ["suggestedChecks", "建议检定"],
            ["keeperNotes", "主持人笔记"],
          ] as const).map(([collection, label]) => (
            <button
              key={collection}
              type="button"
              aria-label={`编辑${label}（${modulePackage[collection].length}）`}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-brass/60 hover:text-amber-200"
              onClick={() => setOpen(collection)}
            >
              {label} <span className="text-brass">{modulePackage[collection].length}</span>
            </button>
          ))}
        </nav>
      </div>

      <EditorSection title="基本信息" open={open === "metadata"} onToggle={() => setOpen(open === "metadata" ? "overview" : "metadata")}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="标题"><Input aria-label="模组标题" value={modulePackage.metadata.title} maxLength={240} onChange={(e) => updateMetadata("title", requiredText(e.target.value, modulePackage.metadata.title))} /></Field>
          <Field label="作者（每行一位）"><Textarea aria-label="模组作者" className="min-h-20" value={modulePackage.metadata.authors.join("\n")} maxLength={5_200} onChange={(e) => updateMetadata("authors", splitLines(e.target.value, 32, 160))} /></Field>
          <Field label="来源（可选）"><Input aria-label="模组来源" value={modulePackage.metadata.source ?? ""} maxLength={500} onChange={(e) => updateMetadata("source", e.target.value)} /></Field>
        </div>
        <Field label="简介"><Textarea aria-label="模组简介" value={modulePackage.metadata.summary} maxLength={8_000} onChange={(e) => updateMetadata("summary", e.target.value)} /></Field>
        <details className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-500">
          <summary className="cursor-pointer">不常用设置</summary>
          <div className="mt-3"><Field label="原文语言"><BufferedRequiredInput ariaLabel="模组语言" value={modulePackage.metadata.language} minLength={2} maxLength={35} onValidChange={(value) => updateMetadata("language", value)} /></Field></div>
        </details>
      </EditorSection>

      <EditorSection title="故事真相与整体脉络（仅 KP）" open={open === "overview"} onToggle={() => setOpen(open === "overview" ? "metadata" : "overview")}>
        <Field label="这场调查背后的真相" hint="写给你自己看：事件为何发生、关键转折与可能结局。不会自动发给玩家。"><Textarea aria-label="模组概览" className="min-h-36" value={modulePackage.overview} maxLength={50_000} onChange={(e) => updateOverview(e.target.value)} /></Field>
      </EditorSection>

      <EntitySection title="章节分组（可选）" collection="chapters" items={modulePackage.chapters} open={open === "chapters"} onToggle={() => setOpen(open === "chapters" ? "overview" : "chapters")} onAdd={() => addEntity("chapters")} onRemove={(id) => removeEntity("chapters", id)} render={(chapter) => (
        <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
          <Field label="标题"><Input aria-label={`章节 ${chapter.id} 标题`} value={chapter.title} maxLength={240} onChange={(e) => updateEntity("chapters", chapter.id, { title: requiredText(e.target.value, chapter.title) })} /></Field>
          <Field label="顺序"><Input aria-label={`章节 ${chapter.id} 顺序`} type="number" min={0} step={1} value={chapter.order} onChange={(e) => updateEntity("chapters", chapter.id, { order: nonnegativeInteger(e.target.value, chapter.order) })} /></Field>
          <fieldset className="grid gap-1 sm:col-span-2">
            <legend className="text-xs font-medium text-zinc-300">包含场景</legend>
            {modulePackage.scenes.length === 0 ? <span className="text-xs text-zinc-500">暂无场景可分组。</span> : (
              <div className="flex flex-wrap gap-2">
                {modulePackage.scenes.map((scene) => {
                  const checked = chapter.sceneIds.includes(scene.id);
                  const atLimit = !checked && chapter.sceneIds.length >= 500;
                  return (
                    <label key={scene.id} title={atLimit ? "每章最多包含 500 个场景" : undefined} className="inline-flex max-w-full items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300">
                      <input type="checkbox" aria-label={`章节 ${chapter.id} 包含场景 ${scene.id}`} checked={checked} disabled={atLimit} onChange={(e) => updateEntity("chapters", chapter.id, { sceneIds: e.target.checked ? [...chapter.sceneIds, scene.id] : chapter.sceneIds.filter((id) => id !== scene.id) })} />
                      {scene.name}
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
          <Field label="备注"><Textarea aria-label={`章节 ${chapter.id} 备注`} value={chapter.notes} maxLength={20_000} onChange={(e) => updateEntity("chapters", chapter.id, { notes: e.target.value })} /></Field>
        </div>
      )} />

      <EntitySection title="场景" collection="scenes" items={modulePackage.scenes} open={open === "scenes"} onToggle={() => setOpen(open === "scenes" ? "overview" : "scenes")} onAdd={() => addEntity("scenes")} onRemove={(id) => removeEntity("scenes", id)} render={(scene) => (
        <EntityTextFields id={scene.id} kind="场景" name={scene.name} description={scene.description} descriptionLabel="现场说明（仅 KP）" onChange={(patch) => updateEntity("scenes", scene.id, patch)} extra={<Field label="这一幕会发生什么" hint="用几句话记录进入条件、冲突与推进方向，跑团时方便快速扫一眼。"><Textarea aria-label={`场景 ${scene.id} 概要`} value={scene.synopsis} maxLength={20_000} onChange={(e) => updateEntity("scenes", scene.id, { synopsis: e.target.value })} /></Field>} />
      )} />

      <EntitySection title="地点" collection="locations" items={modulePackage.locations} open={open === "locations"} onToggle={() => setOpen(open === "locations" ? "overview" : "locations")} onAdd={() => addEntity("locations")} onRemove={(id) => removeEntity("locations", id)} render={(location) => (
        <EntityTextFields id={location.id} kind="地点" name={location.name} description={location.description} descriptionLabel="隐藏信息与主持提示（仅 KP）" onChange={(patch) => updateEntity("locations", location.id, patch)} extra={<div className="grid gap-3"><div className="rounded-lg border border-emerald-900/50 bg-emerald-950/15 p-3"><Field label="介绍给玩家时说什么" hint="只有这里的文字会随地点发到房间。不要写入尚未发现的秘密。"><Textarea aria-label={`地点 ${location.id} 玩家可见说明`} value={location.playerDescription ?? ""} maxLength={20_000} onChange={(e) => updateEntity("locations", location.id, { playerDescription: e.target.value })} /></Field></div><Field label="其他称呼（逗号分隔）"><Input aria-label={`地点 ${location.id} 别名`} value={location.aliases.join(", ")} onChange={(e) => updateEntity("locations", location.id, { aliases: splitComma(e.target.value, 50, 160) })} /></Field></div>} />
      )} />

      <EntitySection title="NPC" collection="npcs" items={modulePackage.npcs} open={open === "npcs"} onToggle={() => setOpen(open === "npcs" ? "overview" : "npcs")} onAdd={() => addEntity("npcs")} onRemove={(id) => removeEntity("npcs", id)} render={(npc) => (
        <EntityTextFields id={npc.id} kind="NPC" name={npc.name} description={npc.description} descriptionLabel="隐藏身份与主持提示（仅 KP）" onChange={(patch) => updateEntity("npcs", npc.id, patch)} extra={<div className="grid gap-3 sm:grid-cols-2"><div className="rounded-lg border border-emerald-900/50 bg-emerald-950/15 p-3 sm:col-span-2"><Field label="介绍给玩家时说什么" hint="发布人物时只会发送名称和这段说明；真实身份、动机和数值不会自动公开。"><Textarea aria-label={`NPC ${npc.id} 玩家可见说明`} value={npc.playerDescription ?? ""} maxLength={20_000} onChange={(e) => updateEntity("npcs", npc.id, { playerDescription: e.target.value })} /></Field></div><Field label="公开身份或职业"><Input aria-label={`NPC ${npc.id} 身份`} value={npc.role} maxLength={1_000} onChange={(e) => updateEntity("npcs", npc.id, { role: e.target.value })} /></Field><Field label="真实动机（仅 KP）"><Textarea aria-label={`NPC ${npc.id} 动机`} maxLength={4_000} value={npc.motivation} onChange={(e) => updateEntity("npcs", npc.id, { motivation: e.target.value })} /></Field><Field label="扮演提示（逗号分隔）"><Input aria-label={`NPC ${npc.id} 特征`} value={npc.traits.join(", ")} onChange={(e) => updateEntity("npcs", npc.id, { traits: splitComma(e.target.value, 100, 500) })} /></Field></div>} />
      )} />

      <EntitySection title="线索" collection="clues" items={modulePackage.clues} open={open === "clues"} onToggle={() => setOpen(open === "clues" ? "overview" : "clues")} onAdd={() => addEntity("clues")} onRemove={(id) => removeEntity("clues", id)} render={(clue) => (
        <EntityTextFields id={clue.id} kind="线索" name={clue.name} description={clue.description} descriptionLabel="如何发现与背后含义（仅 KP）" onChange={(patch) => updateEntity("clues", clue.id, patch)} extra={<><div className="rounded-lg border border-emerald-900/50 bg-emerald-950/15 p-3"><Field label="公布后玩家会看到的文字" hint="写观察结果本身，不要把真相或未发现的信息一起写进去。"><Textarea aria-label={`线索 ${clue.id} 玩家可见文本`} maxLength={20_000} value={clue.revealText} onChange={(e) => updateEntity("clues", clue.id, { revealText: e.target.value })} /></Field></div><label className="flex items-start gap-2 text-xs leading-5 text-zinc-300"><input className="mt-1" type="checkbox" checked={clue.isCore} onChange={(e) => updateEntity("clues", clue.id, { isCore: e.target.checked })} /><span><strong className="font-medium text-zinc-200">这是核心线索</strong><span className="block text-zinc-500">调查不能缺少它；即使检定失败，也应通过代价或其他方式让玩家得到。</span></span></label></>} />
      )} />

      <EntitySection title="手记 / 手稿" collection="handouts" items={modulePackage.handouts} open={open === "handouts"} onToggle={() => setOpen(open === "handouts" ? "overview" : "handouts")} onAdd={() => addEntity("handouts")} onRemove={(id) => removeEntity("handouts", id)} render={(handout) => (
        <EntityTextFields id={handout.id} kind="手记" name={handout.title} description={handout.description} descriptionLabel="如何获得这份手记（仅 KP）" onChange={(patch) => updateEntity("handouts", handout.id, patch)} extra={<div className="rounded-lg border border-emerald-900/50 bg-emerald-950/15 p-3"><Field label="给玩家阅读的正文" hint="这段文字会原样公开，请先删掉任何 KP 批注。"><Textarea aria-label={`手记 ${handout.id} 正文`} maxLength={50_000} value={handout.content} onChange={(e) => updateEntity("handouts", handout.id, { content: e.target.value })} /></Field></div>} nameField="标题" />
      )} />

      <EntitySection title="建议检定" collection="suggestedChecks" items={modulePackage.suggestedChecks} open={open === "suggestedChecks"} onToggle={() => setOpen(open === "suggestedChecks" ? "overview" : "suggestedChecks")} onAdd={() => addEntity("suggestedChecks")} onRemove={(id) => removeEntity("suggestedChecks", id)} render={(check) => (
        <div className="grid gap-3 sm:grid-cols-2"><Field label="技能"><Input aria-label={`检定 ${check.id} 技能`} value={check.skill} maxLength={160} onChange={(e) => updateEntity("suggestedChecks", check.id, { skill: requiredText(e.target.value, check.skill) })} /></Field><Field label="难度"><select aria-label={`检定 ${check.id} 难度`} className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-ink" value={check.difficulty} onChange={(e) => updateEntity("suggestedChecks", check.id, { difficulty: e.target.value })}><option value="regular">普通</option><option value="hard">困难</option><option value="extreme">极难</option></select></Field><Field label="用途"><Textarea aria-label={`检定 ${check.id} 用途`} maxLength={4_000} value={check.purpose} onChange={(e) => updateEntity("suggestedChecks", check.id, { purpose: e.target.value })} /></Field><Field label="成功结果"><Textarea aria-label={`检定 ${check.id} 成功结果`} maxLength={8_000} value={check.onSuccess} onChange={(e) => updateEntity("suggestedChecks", check.id, { onSuccess: e.target.value })} /></Field><Field label="失败结果"><Textarea aria-label={`检定 ${check.id} 失败结果`} maxLength={8_000} value={check.onFailure} onChange={(e) => updateEntity("suggestedChecks", check.id, { onFailure: e.target.value })} /></Field></div>
      )} />

      <EntitySection title="主持人笔记" collection="keeperNotes" items={modulePackage.keeperNotes} open={open === "keeperNotes"} onToggle={() => setOpen(open === "keeperNotes" ? "overview" : "keeperNotes")} onAdd={() => addEntity("keeperNotes")} onRemove={(id) => removeEntity("keeperNotes", id)} render={(note) => (
        <div className="grid gap-3"><Field label="标题"><Input aria-label={`主持人笔记 ${note.id} 标题`} value={note.title} maxLength={240} onChange={(e) => updateEntity("keeperNotes", note.id, { title: requiredText(e.target.value, note.title) })} /></Field><Field label="内容"><Textarea aria-label={`主持人笔记 ${note.id} 内容`} maxLength={50_000} value={note.content} onChange={(e) => updateEntity("keeperNotes", note.id, { content: e.target.value })} /></Field></div>
      )} />
    </section>
  );
}

function EntitySection<T extends { id: string }>({ title, collection, items, open, onToggle, onAdd, onRemove, render }: { title: string; collection: Collection; items: readonly T[]; open: boolean; onToggle: () => void; onAdd: () => void; onRemove: (id: string) => void; render: (item: T) => React.ReactNode }) {
  const atLimit = items.length >= collectionLimit(collection);
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left font-semibold text-ink" aria-expanded={open} onClick={onToggle}>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>{title}<span className="text-xs font-normal text-zinc-500">{items.length}</span>
        </button>
        <Button type="button" variant="secondary" className="h-8 px-2 text-xs" aria-label={`添加${title}`} title={atLimit ? "这一分类已经太多，无法继续添加" : undefined} disabled={atLimit} onClick={onAdd}>
          <Plus className="mr-1 h-3.5 w-3.5" />添加
        </Button>
      </div>
      {open && (
        <div className="grid gap-3 border-t border-zinc-800 p-3">
          {items.length === 0 && <p className="px-1 text-xs leading-5 text-zinc-500">这里还没有内容。如果 AI 有遗漏，可以手动添加一项。</p>}
          {items.map((item) => (
            <article key={item.id} className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="truncate text-xs font-medium text-zinc-400">{entityDisplayName(item)}</p>
                <Button type="button" variant="ghost" className="h-7 px-1.5 text-red-400" aria-label={`删除${title} ${item.id}`} title={`删除“${entityDisplayName(item)}”`} onClick={() => onRemove(item.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
              {render(item)}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function EditorSection({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return <section className="rounded-xl border border-zinc-800 bg-zinc-900/50"><button type="button" className="flex w-full items-center gap-2 px-4 py-3 text-left font-semibold text-ink" aria-expanded={open} onClick={onToggle}><span aria-hidden="true">{open ? "▾" : "▸"}</span>{title}</button>{open && <div className="grid gap-3 border-t border-zinc-800 p-4">{children}</div>}</section>;
}

function EntityTextFields({ id, kind, name, description, descriptionLabel = "主持提示（仅 KP）", onChange, extra, nameField = "名称" }: { id: string; kind: string; name: string; description: string; descriptionLabel?: string; onChange: (patch: Record<string, unknown>) => void; extra?: React.ReactNode; nameField?: string }) {
  return <div className="grid gap-3"><Field label={nameField}><Input aria-label={`${kind} ${id} ${nameField}`} value={name} maxLength={240} onChange={(e) => onChange(nameField === "标题" ? { title: requiredText(e.target.value, name) } : { name: requiredText(e.target.value, name) })} /></Field><Field label={descriptionLabel}><Textarea aria-label={`${kind} ${id} 描述`} value={description} maxLength={20_000} onChange={(e) => onChange({ description: e.target.value })} /></Field>{extra}</div>;
}

function entityDisplayName(item: object): string {
  const value = item as Record<string, unknown>;
  if (typeof value.title === "string" && value.title.trim()) return value.title;
  if (typeof value.name === "string" && value.name.trim()) return value.name;
  if (typeof value.skill === "string" && value.skill.trim()) return `${value.skill}检定`;
  return "未命名资料";
}

function BufferedRequiredInput({ ariaLabel, value, minLength, maxLength, onValidChange }: { ariaLabel: string; value: string; minLength: number; maxLength: number; onValidChange: (value: string) => void }) {
  const [input, setInput] = useState(value);
  useEffect(() => setInput(value), [value]);
  const valid = input.length >= minLength;
  return <Input aria-label={ariaLabel} aria-invalid={!valid} value={input} minLength={minLength} maxLength={maxLength} onChange={(event) => { const next = event.target.value; setInput(next); if (next.length >= minLength) onValidChange(next); }} onBlur={() => { if (!valid) setInput(value); }} />;
}

function splitLines(value: string, max: number, maxLength: number): string[] { return [...new Set(value.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).map((part) => part.slice(0, maxLength)))].slice(0, max); }
function splitComma(value: string, max: number, maxLength: number): string[] { return splitLines(value.replaceAll(",", "\n"), max, maxLength); }
function requiredText(value: string, previous: string): string { return value.length > 0 ? value : previous; }
function nonnegativeInteger(value: string, previous: number): number { const candidate = Number(value); return Number.isFinite(candidate) ? Math.max(0, Math.trunc(candidate)) : previous; }
function collectionLimit(collection: Collection): number { return collection === "chapters" ? 500 : collection === "scenes" || collection === "locations" ? 2_000 : 5_000; }
function collectEntityIds(modulePackage: ModulePackageV1): Set<string> { return new Set([...(modulePackage.chapters), ...modulePackage.scenes, ...modulePackage.locations, ...modulePackage.npcs, ...modulePackage.clues, ...modulePackage.handouts, ...modulePackage.suggestedChecks, ...modulePackage.keeperNotes, ...modulePackage.relations].map((item) => item.id)); }
function nextEntityId(collection: Collection, used: ReadonlySet<string>): string { const prefix = collection === "suggestedChecks" ? "check" : collection === "keeperNotes" ? "keeper-note" : collection.slice(0, -1); let candidate = `${prefix}-new`; let index = 2; while (used.has(candidate)) candidate = `${prefix}-new-${index++}`; return candidate; }

function newEntity(collection: Collection, id: string): ModulePackageV1[Collection][number] {
  if (collection === "chapters") return { id, title: "新章节", order: 0, sceneIds: [], notes: "" };
  const base = { id, sourceRefs: [] };
  if (collection === "scenes") return { ...base, name: "新场景", description: "", synopsis: "", locationIds: [], npcIds: [], clueIds: [], handoutIds: [], suggestedCheckIds: [], keeperNotes: "" };
  if (collection === "locations") return { ...base, name: "新地点", description: "", playerDescription: "", aliases: [] };
  if (collection === "npcs") return { ...base, name: "新 NPC", description: "", playerDescription: "", role: "", motivation: "", traits: [] };
  if (collection === "clues") return { ...base, name: "新线索", description: "", revealText: "", isCore: false };
  if (collection === "handouts") return { ...base, name: "新手记", title: "新手记", description: "", content: "" };
  if (collection === "suggestedChecks") return { ...base, skill: "侦查", difficulty: "regular", purpose: "", onSuccess: "", onFailure: "" };
  return { ...base, title: "新主持人笔记", content: "", relatedEntityIds: [] };
}
