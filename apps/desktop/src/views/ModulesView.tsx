import { useMemo, useState } from "react";
import { BookOpen, Download, Eye, FileInput, FlaskConical, Play, Save, Trash2, Upload } from "lucide-react";
import { modulePackageSchema, type ModulePackageV1 } from "@coc-room/protocol";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { getRepository } from "../data/repository";
import { parseModule, selectModuleSource, type ParserError, type ParserProgress, type ParserResult } from "../lib/module-parser";
import type { RoomSession } from "../network/RoomSession";
import { useAppStore } from "../store/app-store";
import { Button } from "../components/ui/Button";
import { Field, Input, Textarea } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";

export function ModulesView({ session }: { session?: RoomSession }) {
  const modules = useAppStore((state) => state.modules);
  const setModules = useAppStore((state) => state.setModules);
  const model = useAppStore((state) => state.model);
  const currentRoom = useAppStore((state) => state.currentRoom);
  const [sourceName, setSourceName] = useState("新模组.md");
  const [sourceText, setSourceText] = useState("");
  const [sourcePath, setSourcePath] = useState<string>();
  const [draft, setDraft] = useState("");
  const [progress, setProgress] = useState<ParserProgress[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const parsedDraft = useMemo(() => {
    try { return modulePackageSchema.safeParse(JSON.parse(draft)); } catch { return undefined; }
  }, [draft]);

  const chooseSource = async () => {
    if (!window.__TAURI_INTERNALS__) return setError("文件选择需要桌面应用；浏览器预览可直接粘贴文字");
    try {
      const path = await selectModuleSource();
      if (path) {
        setSourceName(path.split(/[\\/]/).at(-1) ?? "module");
        if (/\.(txt|md)$/i.test(path)) {
          setSourceText(await readTextFile(path));
          setSourcePath(undefined);
        } else {
          setSourceText("");
          setSourcePath(path);
        }
      }
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const runParser = async (mock = false) => {
    if (!sourceText.trim() && !sourcePath) return setError("请粘贴文字或选择模组文件");
    setBusy(true); setError(undefined); setProgress([]); setWarnings([]);
    try {
      const messages = await parseModule({ sourceText: sourceText || undefined, sourcePath, sourceName, model, mock });
      const updates = messages.filter((message): message is ParserProgress => message.type === "progress");
      const failure = messages.find((message): message is ParserError => message.type === "error");
      const result = messages.find((message): message is ParserResult => message.type === "result");
      setProgress(updates);
      if (failure) throw new Error(`${failure.error?.code ? `${failure.error.code}: ` : ""}${failure.message}`);
      if (!result) throw new Error("解析器没有返回结构化模组");
      setWarnings(result.warnings ?? []);
      setDraft(JSON.stringify(result.module, null, 2));
      if (result.normalizedText && !sourceText) setSourceText(result.normalizedText);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const saveDraft = async () => {
    try {
      const candidate = modulePackageSchema.parse(JSON.parse(draft));
      const modulePackage = nextModuleRevision(candidate, modules);
      const repository = await getRepository();
      await repository.saveModule({ package: modulePackage, sourceText });
      setModules((await repository.listModules()).map((item) => item.package));
      setDraft(JSON.stringify(modulePackage, null, 2));
      setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const remove = async (moduleId: string) => {
    const modulePackage = modules.find((item) => item.moduleId === moduleId);
    if (!window.confirm(`确认删除本机模组“${modulePackage?.metadata.title ?? moduleId}”？此操作不会影响已同步的房间事件。`)) return;
    try {
      const repository = await getRepository();
      await repository.deleteModule(moduleId);
      setModules((await repository.listModules()).map((item) => item.package));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const importPackage = async () => {
    if (!window.__TAURI_INTERNALS__) return;
    const path = await open({ multiple: false, filters: [{ name: "CoC module", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    try {
      const candidate = modulePackageSchema.parse(JSON.parse(await readTextFile(path)));
      const modulePackage = nextModuleRevision(candidate, modules);
      const repository = await getRepository();
      await repository.saveModule({ package: modulePackage, sourceText: "" });
      setModules((await repository.listModules()).map((item) => item.package));
      setDraft(JSON.stringify(modulePackage, null, 2));
      setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const exportPackage = async (modulePackage: ModulePackageV1) => {
    try {
      const content = JSON.stringify(modulePackage, null, 2);
      if (window.__TAURI_INTERNALS__) {
        const path = await save({ defaultPath: `${safeName(modulePackage.metadata.title)}.cocmod.json`, filters: [{ name: "CoC module", extensions: ["json"] }] });
        if (path) await writeTextFile(path, content);
      } else download(`${safeName(modulePackage.metadata.title)}.cocmod.json`, content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const switchModule = async (modulePackage: ModulePackageV1) => {
    if (!session || !session.isHost) return;
    try {
      await session.submit("module.switch", { moduleId: modulePackage.moduleId, revision: modulePackage.revision, title: modulePackage.metadata.title });
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const revealContent = async (
    modulePackage: ModulePackageV1,
    content: { id: string; title: string; body: string; type: "clue" | "handout" },
  ) => {
    if (!session?.isHost) return;
    if (!content.body.trim()) {
      setError("该条目没有经过确认的玩家可见正文；请先在 JSON 编辑器填写 revealText/content");
      return;
    }
    if (!window.confirm(`确认向全房间永久公开“${content.title}”？公开事件无法撤回。`)) return;
    try {
      await session.submit("content.reveal", {
        moduleId: modulePackage.moduleId,
        revision: modulePackage.revision,
        contentId: content.id,
        contentType: content.type,
        title: content.title,
        body: content.body,
      });
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="h-full overflow-y-auto p-7">
      <div className="mx-auto grid max-w-6xl gap-6">
        <header><p className="text-xs uppercase tracking-[.3em] text-brass">Keeper's library</p><h1 className="mt-2 font-serif text-3xl text-ink">模组资料库</h1><p className="mt-2 text-sm text-zinc-400">解析和编辑独立于房间；只有主动公开的线索会发送给玩家。</p></header>
        <div className="grid gap-5 xl:grid-cols-[390px_minmax(0,1fr)]">
          <div className="grid content-start gap-5">
            <Panel className="grid gap-4">
              <div className="flex items-center gap-2"><FileInput className="text-brass" /><h2 className="font-semibold">导入原始模组</h2></div>
              <Field label="来源名称"><Input value={sourceName} onChange={(event) => setSourceName(event.target.value)} /></Field>
              <Field label="文字/Markdown" hint="也可选择 TXT、Markdown、DOCX 或只含一个文档的 ZIP">
                <Textarea value={sourceText} onChange={(event) => { setSourceText(event.target.value); setSourcePath(undefined); }} className="min-h-56" />
              </Field>
              {sourcePath && <p className="break-all text-xs text-zinc-500">已选择：{sourcePath}</p>}
              <div className="grid grid-cols-2 gap-2"><Button variant="secondary" onClick={() => void chooseSource()}><Upload className="mr-2 h-4 w-4" />选择文件</Button><Button onClick={() => void runParser(false)} disabled={busy}><Play className="mr-2 h-4 w-4" />DeepSeek 解析</Button></div>
              <Button variant="ghost" onClick={() => void runParser(true)} disabled={busy}><FlaskConical className="mr-2 h-4 w-4" />无 API 模拟结构</Button>
              {progress.map((item, index) => <div key={`${item.stage}-${index}`} className="text-xs text-zinc-400">{item.stage} · {item.message}</div>)}
              {warnings.map((warning) => <div key={warning} className="text-xs text-amber-300">{warning}</div>)}
            </Panel>
            <Panel className="grid gap-3">
              <div className="flex items-center justify-between"><h2 className="font-semibold">已保存模组</h2><Button variant="ghost" onClick={() => void importPackage()}><Upload className="h-4 w-4" /></Button></div>
              {modules.length === 0 && <p className="text-sm text-zinc-500">资料库为空。</p>}
              {modules.map((modulePackage) => (
                <div key={modulePackage.moduleId} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                  <div className="font-medium text-ink">{modulePackage.metadata.title}</div>
                  <div className="mt-1 text-xs text-zinc-500">{modulePackage.scenes.length} 场景 · {modulePackage.locations.length} 地点 · {modulePackage.npcs.length} NPC</div>
                  <div className="mt-3 flex gap-1">
                    <Button variant="secondary" className="h-8 px-2" onClick={() => setDraft(JSON.stringify(modulePackage, null, 2))}>编辑</Button>
                    <Button variant="ghost" className="h-8 px-2" onClick={() => void exportPackage(modulePackage)}><Download className="h-4 w-4" /></Button>
                    {currentRoom?.localRole === "host" && <Button variant="ghost" className="h-8 px-2" onClick={() => void switchModule(modulePackage)}><BookOpen className="h-4 w-4" /></Button>}
                    <Button variant="ghost" className="ml-auto h-8 px-2 text-red-400" onClick={() => void remove(modulePackage.moduleId)}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                  {currentRoom?.localRole === "host" && session && (modulePackage.clues.length > 0 || modulePackage.handouts.length > 0) && (
                    <details className="mt-3 border-t border-zinc-800 pt-2">
                      <summary className="cursor-pointer text-xs text-zinc-400">选择公开内容</summary>
                      <div className="mt-2 grid max-h-52 gap-1 overflow-y-auto">
                        {modulePackage.clues.map((clue) => (
                          <button
                            key={clue.id}
                            type="button"
                            disabled={!clue.revealText.trim()}
                            className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-35"
                            title={clue.revealText ? "只公开玩家可见文本" : "公开标题；此线索尚无玩家可见正文"}
                            onClick={() => void revealContent(modulePackage, { id: clue.id, title: clue.name, body: clue.revealText, type: "clue" })}
                          >
                            <Eye className="h-3.5 w-3.5 shrink-0 text-brass" />线索：{clue.name}
                          </button>
                        ))}
                        {modulePackage.handouts.map((handout) => (
                          <button
                            key={handout.id}
                            type="button"
                            disabled={!handout.content.trim()}
                            className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-35"
                            onClick={() => void revealContent(modulePackage, { id: handout.id, title: handout.title, body: handout.content, type: "handout" })}
                          >
                            <Eye className="h-3.5 w-3.5 shrink-0 text-brass" />手记：{handout.title}
                          </button>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              ))}
            </Panel>
          </div>
          <Panel className="flex min-h-[700px] flex-col gap-3">
            <div className="flex items-center justify-between"><div><h2 className="font-semibold">结构化模组编辑器</h2><p className="text-xs text-zinc-500">AI 输出必须在这里确认后保存。</p></div><Button onClick={() => void saveDraft()} disabled={!parsedDraft?.success}><Save className="mr-2 h-4 w-4" />确认保存</Button></div>
            <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="解析结果会出现在这里，也可以粘贴 ModulePackageV1 JSON。" className="min-h-0 flex-1 font-mono text-xs leading-5" spellCheck={false} />
            {draft && !parsedDraft?.success && <div className="max-h-28 overflow-auto rounded bg-red-950/40 p-2 text-xs text-red-300">结构不合法：{parsedDraft ? parsedDraft.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；") : "不是有效 JSON"}</div>}
          </Panel>
        </div>
        {error && <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">{error}</div>}
      </div>
    </div>
  );
}

function safeName(value: string) { return value.replace(/[<>:"/\\|?*]/g, "_"); }
function download(name: string, content: string) { const url = URL.createObjectURL(new Blob([content], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url); }

function nextModuleRevision(candidate: ModulePackageV1, modules: ModulePackageV1[]): ModulePackageV1 {
  const existing = modules.find((item) => item.moduleId === candidate.moduleId);
  const now = new Date().toISOString();
  return modulePackageSchema.parse({
    ...candidate,
    revision: existing ? existing.revision + 1 : Math.max(1, candidate.revision),
    metadata: {
      ...candidate.metadata,
      createdAt: existing?.metadata.createdAt ?? candidate.metadata.createdAt,
      updatedAt: now,
    },
  });
}
