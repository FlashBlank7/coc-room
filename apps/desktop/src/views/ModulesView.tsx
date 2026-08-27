import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { BookOpen, Code2, Download, Eye, FileInput, FlaskConical, History, LayoutList, Play, Save, Trash2, Upload } from "lucide-react";
import { modulePackageSchema, type ModulePackageV1 } from "@coc-room/protocol";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { getRepository, type StoredModule } from "../data/repository";
import { parseModule, selectModuleSource, type ParserError, type ParserProgress, type ParserResult } from "../lib/module-parser";
import type { RoomSession } from "../network/RoomSession";
import { useAppStore } from "../store/app-store";
import { Button } from "../components/ui/Button";
import { Field, Input, Textarea } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";
import { ModuleEntityBrowser } from "../components/module/ModuleEntityBrowser";
import { StructuredModuleEditor } from "../components/module/StructuredModuleEditor";

export function ModulesView({ session }: { session?: RoomSession }) {
  const modules = useAppStore((state) => state.modules);
  const setModules = useAppStore((state) => state.setModules);
  const events = useAppStore((state) => state.events);
  const model = useAppStore((state) => state.model);
  const currentRoom = useAppStore((state) => state.currentRoom);
  const [sourceName, setSourceName] = useState("新模组.md");
  const [sourceText, setSourceText] = useState("");
  const [sourcePath, setSourcePath] = useState<string>();
  const [draft, setDraft] = useState("");
  const [draftSourceText, setDraftSourceText] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [selectedModuleId, setSelectedModuleId] = useState<string>();
  const [selectedRevision, setSelectedRevision] = useState<number>();
  const [moduleHistories, setModuleHistories] = useState<Record<string, StoredModule[]>>({});
  const [workspaceMode, setWorkspaceMode] = useState<"browse" | "structured" | "json">("browse");
  const [progress, setProgress] = useState<ParserProgress[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const browserImportRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const canManageRoomModule = currentRoom?.localRole === "host" && session?.isHost === true;
  const parsedDraft = useMemo(() => {
    try { return modulePackageSchema.safeParse(JSON.parse(draft)); } catch { return undefined; }
  }, [draft]);
  const activeRoomModule = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === "module.switched") return event.payload;
    }
    return undefined;
  }, [events]);
  const isActiveRoomModule = useCallback((modulePackage: ModulePackageV1) => (
    activeRoomModule?.moduleId === modulePackage.moduleId
      && activeRoomModule.revision === modulePackage.revision
  ), [activeRoomModule]);

  const rememberHistory = useCallback((moduleId: string, history: StoredModule[]) => {
    setModuleHistories((current) => ({ ...current, [moduleId]: history }));
  }, []);

  const refreshLibrary = useCallback(async () => {
    const repository = await getRepository();
    const latest = await repository.listModules();
    setModules(latest.map((item) => item.package));
    const all = await repository.listModules({ latestOnly: false });
    const grouped = all.reduce<Record<string, StoredModule[]>>((history, item) => {
      (history[item.package.moduleId] ??= []).push(item);
      return history;
    }, {});
    setModuleHistories(grouped);
    return latest;
  }, [setModules]);

  const showStoredModule = useCallback((stored: StoredModule) => {
    setSelectedModuleId(stored.package.moduleId);
    setSelectedRevision(stored.package.revision);
    setDraft(JSON.stringify(stored.package, null, 2));
    setDraftSourceText(stored.sourceText);
    setDraftDirty(false);
    setWorkspaceMode("browse");
    setError(undefined);
  }, []);

  const openModule = useCallback(async (modulePackage: ModulePackageV1) => {
    try {
      const repository = await getRepository();
      const stored = await repository.getModule(modulePackage.moduleId, modulePackage.revision)
        ?? { package: modulePackage, sourceText: "" };
      showStoredModule(stored);
      rememberHistory(
        modulePackage.moduleId,
        await repository.listModules({ moduleId: modulePackage.moduleId, latestOnly: false }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rememberHistory, showStoredModule]);

  useEffect(() => {
    let cancelled = false;
    void getRepository().then(async (repository) => {
      const entries = await Promise.all(modules.map(async (modulePackage) => [
        modulePackage.moduleId,
        await repository.listModules({ moduleId: modulePackage.moduleId, latestOnly: false }),
      ] as const));
      if (!cancelled) setModuleHistories(Object.fromEntries(entries));
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [modules]);

  useEffect(() => {
    if (selectedModuleId || draft.trim() || modules.length === 0) return;
    void openModule(modules[0]!);
  }, [draft, modules, openModule, selectedModuleId]);

  useEffect(() => {
    if (!draft || !selectedModuleId) return;
    // The library and import panels can be taller than a compact window. Put
    // the newly opened workbench in view so a successful import is apparent.
    const frame = window.requestAnimationFrame(() => {
      const workspace = workspaceRef.current;
      if (workspace && typeof workspace.scrollIntoView === "function") workspace.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [draft, selectedModuleId, selectedRevision]);

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
      const messages = await parseModule(
        { sourceText: sourceText || undefined, sourcePath, sourceName, model, mock },
        (update) => setProgress((current) => [...current, update]),
      );
      const updates = messages.filter((message): message is ParserProgress => message.type === "progress");
      const failure = messages.find((message): message is ParserError => message.type === "error");
      const result = messages.find((message): message is ParserResult => message.type === "result");
      setProgress(updates);
      if (failure) throw new Error(`${failure.error?.code ? `${failure.error.code}: ` : ""}${failure.message}`);
      if (!result) throw new Error("解析器没有返回结构化模组");
      setWarnings(result.warnings ?? []);
      setDraft(JSON.stringify(result.module, null, 2));
      setDraftSourceText(result.normalizedText ?? sourceText);
      setDraftDirty(true);
      setSelectedModuleId(result.module.moduleId);
      setSelectedRevision(result.module.revision);
      setWorkspaceMode("browse");
      if (result.normalizedText && !sourceText) setSourceText(result.normalizedText);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const saveDraft = async () => {
    try {
      const candidate = modulePackageSchema.parse(JSON.parse(draft));
      const repository = await getRepository();
      const storedModules = await repository.listModules();
      const modulePackage = nextModuleRevision(candidate, storedModules.map((item) => item.package));
      await repository.saveModule({ package: modulePackage, sourceText: draftSourceText });
      await refreshLibrary();
      setDraft(JSON.stringify(modulePackage, null, 2));
      setDraftDirty(false);
      setSelectedModuleId(modulePackage.moduleId);
      setSelectedRevision(modulePackage.revision);
      setWorkspaceMode("browse");
      setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const removeModule = async (moduleId: string) => {
    const modulePackage = modules.find((item) => item.moduleId === moduleId);
    const revisionCount = moduleHistories[moduleId]?.length ?? 1;
    if (!window.confirm(`确认删除本机模组“${modulePackage?.metadata.title ?? moduleId}”的全部 ${revisionCount} 个修订？房间事件仍会保留，但本机将无法再打开其中引用的模组版本。`)) return;
    try {
      const repository = await getRepository();
      await repository.deleteModule(moduleId);
      const storedRemaining = await refreshLibrary();
      if (selectedModuleId === moduleId) {
        const next = storedRemaining[0];
        if (next) showStoredModule(next);
        else {
          setSelectedModuleId(undefined);
          setSelectedRevision(undefined);
          setDraft("");
          setDraftSourceText("");
          setDraftDirty(false);
          setWorkspaceMode("browse");
        }
      }
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const removeRevision = async (modulePackage: ModulePackageV1) => {
    if (!window.confirm(`确认只删除“${modulePackage.metadata.title}”的 v${modulePackage.revision}？其他修订和房间事件会保留，但本机将无法再打开这个版本。`)) return;
    try {
      const repository = await getRepository();
      await repository.deleteModuleRevision(modulePackage.moduleId, modulePackage.revision);
      const storedRemaining = await refreshLibrary();
      if (selectedModuleId === modulePackage.moduleId && selectedRevision === modulePackage.revision) {
        const next = await repository.getModule(modulePackage.moduleId) ?? storedRemaining[0];
        if (next) showStoredModule(next);
        else {
          setSelectedModuleId(undefined);
          setSelectedRevision(undefined);
          setDraft("");
          setDraftSourceText("");
          setDraftDirty(false);
          setWorkspaceMode("browse");
        }
      }
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const importPackageContent = async (content: string) => {
    try {
      const candidate = modulePackageSchema.parse(JSON.parse(content));
      const repository = await getRepository();
      const storedModules = await repository.listModules();
      const existing = await repository.getModule(candidate.moduleId);
      const modulePackage = nextModuleRevision(candidate, storedModules.map((item) => item.package));
      await repository.saveModule({ package: modulePackage, sourceText: existing?.sourceText ?? "" });
      await refreshLibrary();
      setDraft(JSON.stringify(modulePackage, null, 2));
      setDraftSourceText(existing?.sourceText ?? "");
      setDraftDirty(false);
      setSelectedModuleId(modulePackage.moduleId);
      setSelectedRevision(modulePackage.revision);
      setWorkspaceMode("browse");
      setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const importPackage = async () => {
    if (!window.__TAURI_INTERNALS__) {
      browserImportRef.current?.click();
      return;
    }
    try {
      const path = await open({ multiple: false, filters: [{ name: "CoC module", extensions: ["json"] }] });
      if (typeof path !== "string") return;
      await importPackageContent(await readTextFile(path));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const importBrowserPackage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) {
      setError("模组包超过 16 MiB，已拒绝导入");
      return;
    }
    try {
      await importPackageContent(await file.text());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const exportPackage = async (modulePackage: ModulePackageV1) => {
    try {
      const content = JSON.stringify(modulePackage, null, 2);
      const fileName = `${safeName(modulePackage.metadata.title)}-v${modulePackage.revision}.cocmod.json`;
      if (window.__TAURI_INTERNALS__) {
        const path = await save({ defaultPath: fileName, filters: [{ name: "CoC module", extensions: ["json"] }] });
        if (path) await writeTextFile(path, content);
      } else download(fileName, content);
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
              <input
                ref={browserImportRef}
                type="file"
                accept=".json,.cocmod.json,application/json"
                className="hidden"
                onChange={(event) => void importBrowserPackage(event)}
              />
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-semibold">已保存模组</h2>
                <Button variant="secondary" className="h-8 px-2 text-xs" onClick={() => void importPackage()}>
                  <Upload className="mr-1.5 h-3.5 w-3.5" />导入 cocmod
                </Button>
              </div>
              {modules.length === 0 && <p className="text-sm text-zinc-500">资料库为空。</p>}
              {modules.map((modulePackage) => {
                const history = moduleHistories[modulePackage.moduleId]
                  ?? [{ package: modulePackage, sourceText: "" }];
                const activeLatest = isActiveRoomModule(modulePackage);
                return (
                  <div
                    key={modulePackage.moduleId}
                    aria-label={`已保存模组：${modulePackage.metadata.title}`}
                    aria-current={selectedModuleId === modulePackage.moduleId ? "true" : undefined}
                    className={`rounded-lg border bg-zinc-900 p-3 ${selectedModuleId === modulePackage.moduleId ? "border-brass/60" : "border-zinc-800"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-medium text-ink">{modulePackage.metadata.title}</div>
                      <div className="flex shrink-0 flex-wrap justify-end gap-1">
                        {activeLatest && <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] text-emerald-300">房间使用中</span>}
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-brass">最新 v{modulePackage.revision}</span>
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">{modulePackage.scenes.length} 场景 · {modulePackage.locations.length} 地点 · {modulePackage.npcs.length} NPC</div>
                    <div className="mt-3 flex gap-1">
                      <Button variant="secondary" className="h-8 px-2" onClick={() => void openModule(modulePackage)}>
                        <BookOpen className="mr-1.5 h-3.5 w-3.5" />打开
                      </Button>
                      <Button aria-label={`导出${modulePackage.metadata.title} v${modulePackage.revision}`} variant="ghost" className="h-8 px-2" onClick={() => void exportPackage(modulePackage)}><Download className="h-4 w-4" /></Button>
                      {canManageRoomModule && !activeLatest && <Button aria-label={`切换房间模组：${modulePackage.metadata.title}`} variant="ghost" className="h-8 px-2 text-xs" onClick={() => void switchModule(modulePackage)}><Play className="mr-1 h-3.5 w-3.5" />设为房间模组</Button>}
                      <Button aria-label={`删除整个模组：${modulePackage.metadata.title}`} variant="ghost" className="ml-auto h-8 px-2 text-red-400" onClick={() => void removeModule(modulePackage.moduleId)}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                    <details aria-label={`${modulePackage.metadata.title}修订历史`} className="mt-3 border-t border-zinc-800 pt-2">
                      <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
                        <History className="h-3.5 w-3.5" />修订历史 · {history.length} 个版本
                      </summary>
                      <div className="mt-2 grid gap-1.5">
                        {history.map((stored) => {
                          const revision = stored.package.revision;
                          const selected = selectedModuleId === modulePackage.moduleId && selectedRevision === revision;
                          const active = isActiveRoomModule(stored.package);
                          return (
                            <div key={revision} className={`flex items-center gap-1 rounded border px-2 py-1.5 ${selected ? "border-brass/40 bg-brass/5" : "border-zinc-800 bg-zinc-950"}`}>
                              <div className="min-w-0 flex-1">
                                <div className="text-xs text-zinc-300">v{revision}{revision === modulePackage.revision ? " · 最新" : ""}{active ? " · 房间使用中" : ""}</div>
                                <div className="truncate text-[10px] text-zinc-600">{stored.package.metadata.updatedAt}</div>
                              </div>
                              <Button aria-label={`打开${stored.package.metadata.title} v${revision}`} variant="ghost" className="h-7 px-1.5" onClick={() => void openModule(stored.package)}><BookOpen className="h-3.5 w-3.5" /></Button>
                              {canManageRoomModule && !active && <Button aria-label={`切换房间模组版本：${stored.package.metadata.title} v${revision}`} variant="ghost" className="h-7 px-1.5" onClick={() => void switchModule(stored.package)}><Play className="h-3.5 w-3.5" /></Button>}
                              <Button aria-label={`导出${stored.package.metadata.title} v${revision}`} variant="ghost" className="h-7 px-1.5" onClick={() => void exportPackage(stored.package)}><Download className="h-3.5 w-3.5" /></Button>
                              <Button aria-label={`删除${stored.package.metadata.title} v${revision}`} variant="ghost" className="h-7 px-1.5 text-red-400" onClick={() => void removeRevision(stored.package)}><Trash2 className="h-3.5 w-3.5" /></Button>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  </div>
                );
              })}
            </Panel>
          </div>
          <Panel ref={workspaceRef} tabIndex={-1} className="flex min-h-[700px] flex-col gap-4 xl:h-[calc(100vh-10rem)]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3">
              <div>
                <h2 className="font-semibold">模组工作台</h2>
                <p className="text-xs text-zinc-500">
                  {selectedModuleId && selectedRevision
                    ? `当前打开 v${selectedRevision}；修改后会另存为新的修订。`
                    : "先浏览 AI 抽取结果；需要修正时再切换 JSON 编辑。"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-md border border-zinc-800 bg-zinc-950 p-1" role="tablist" aria-label="模组工作台模式">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={workspaceMode === "browse"}
                    disabled={!parsedDraft?.success}
                    onClick={() => setWorkspaceMode("browse")}
                    className={`flex h-8 items-center gap-1.5 rounded px-2.5 text-xs transition disabled:opacity-30 ${workspaceMode === "browse" ? "bg-zinc-800 text-brass" : "text-zinc-500 hover:text-zinc-200"}`}
                  >
                    <LayoutList className="h-3.5 w-3.5" />资料浏览
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={workspaceMode === "structured"}
                    disabled={!parsedDraft?.success}
                    onClick={() => setWorkspaceMode("structured")}
                    className={`flex h-8 items-center gap-1.5 rounded px-2.5 text-xs transition disabled:opacity-30 ${workspaceMode === "structured" ? "bg-zinc-800 text-brass" : "text-zinc-500 hover:text-zinc-200"}`}
                  >
                    <LayoutList className="h-3.5 w-3.5" />缁撴瀯缂栬緫
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={workspaceMode === "json"}
                    title="高级 JSON"
                    onClick={() => setWorkspaceMode("json")}
                    className={`flex h-8 items-center gap-1.5 rounded px-2.5 text-xs transition ${workspaceMode === "json" ? "bg-zinc-800 text-brass" : "text-zinc-500 hover:text-zinc-200"}`}
                  >
                    <Code2 className="h-3.5 w-3.5" />JSON 编辑
                  </button>
                </div>
                <Button onClick={() => void saveDraft()} disabled={!parsedDraft?.success || !draftDirty}>
                  <Save className="mr-2 h-4 w-4" />{draftDirty ? "保存更改" : "已保存"}
                </Button>
              </div>
            </div>

            {!draft && (
              <div className="grid min-h-96 flex-1 place-items-center rounded-xl border border-dashed border-zinc-800 text-center text-sm text-zinc-500">
                <div><BookOpen className="mx-auto mb-3 h-8 w-8 text-zinc-700" /><p>导入、解析或打开一个模组后，这里会显示人物、地点与线索。</p></div>
              </div>
            )}

            {draft && workspaceMode === "browse" && parsedDraft?.success && (
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                <ModuleEntityBrowser key={`${parsedDraft.data.moduleId}-${parsedDraft.data.revision}`} modulePackage={parsedDraft.data} />
                {canManageRoomModule && (parsedDraft.data.clues.length > 0 || parsedDraft.data.handouts.length > 0) && (
                  isActiveRoomModule(parsedDraft.data) ? (
                    <RoomContentPublishing modulePackage={parsedDraft.data} onReveal={revealContent} />
                  ) : (
                    <div className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3 text-xs text-amber-200">
                      当前打开的 v{parsedDraft.data.revision} 不是房间正在使用的精确版本。先在左侧将它设为房间模组，才能公开线索或手记。
                    </div>
                  )
                )}
              </div>
            )}

            {draft && workspaceMode === "structured" && parsedDraft?.success && (
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                <StructuredModuleEditor
                  modulePackage={parsedDraft.data}
                  onChange={(next) => {
                    setDraft(JSON.stringify(next, null, 2));
                    setDraftDirty(true);
                  }}
                />
              </div>
            )}

            {draft && workspaceMode === "json" && (
              <Textarea
                value={draft}
                onChange={(event) => { setDraft(event.target.value); setDraftDirty(true); }}
                placeholder="解析结果会出现在这里，也可以粘贴 ModulePackageV1 JSON。"
                className="min-h-0 flex-1 font-mono text-xs leading-5"
                spellCheck={false}
              />
            )}

            {draft && !parsedDraft?.success && (
              <div className="max-h-28 overflow-auto rounded bg-red-950/40 p-2 text-xs text-red-300">
                结构不合法：{parsedDraft ? parsedDraft.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；") : "不是有效 JSON"}
              </div>
            )}
          </Panel>
        </div>
        {error && <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">{error}</div>}
      </div>
    </div>
  );
}

function RoomContentPublishing({
  modulePackage,
  onReveal,
}: {
  modulePackage: ModulePackageV1;
  onReveal: (
    modulePackage: ModulePackageV1,
    content: { id: string; title: string; body: string; type: "clue" | "handout" },
  ) => Promise<void>;
}) {
  return (
    <section aria-label="房间内容公开" className="mt-4 rounded-xl border border-emerald-900/50 bg-emerald-950/15 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-emerald-200">向房间公开内容</h3>
          <p className="mt-1 text-xs text-zinc-500">当前房间正在使用此模组的 v{modulePackage.revision}；公开事件无法撤回。</p>
        </div>
        <span className="rounded bg-emerald-950 px-2 py-1 text-[10px] text-emerald-300">精确版本已匹配</span>
      </div>
      <div className="mt-3 grid max-h-52 gap-1 overflow-y-auto">
        {modulePackage.clues.map((clue) => (
          <button
            key={clue.id}
            type="button"
            aria-label={`公开线索：${clue.name}`}
            disabled={!clue.revealText.trim()}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-35"
            title={clue.revealText ? "只公开玩家可见文本" : "此线索尚无玩家可见正文"}
            onClick={() => void onReveal(modulePackage, { id: clue.id, title: clue.name, body: clue.revealText, type: "clue" })}
          >
            <Eye className="h-3.5 w-3.5 shrink-0 text-brass" />线索：{clue.name}
          </button>
        ))}
        {modulePackage.handouts.map((handout) => (
          <button
            key={handout.id}
            type="button"
            aria-label={`公开手记：${handout.title}`}
            disabled={!handout.content.trim()}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-35"
            onClick={() => void onReveal(modulePackage, { id: handout.id, title: handout.title, body: handout.content, type: "handout" })}
          >
            <Eye className="h-3.5 w-3.5 shrink-0 text-brass" />手记：{handout.title}
          </button>
        ))}
      </div>
    </section>
  );
}

function safeName(value: string) { return value.replace(/[<>:"/\\|?*]/g, "_"); }
function download(name: string, content: string) { const url = URL.createObjectURL(new Blob([content], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url); }

function nextModuleRevision(candidate: ModulePackageV1, modules: ModulePackageV1[]): ModulePackageV1 {
  const existing = modules.find((item) => item.moduleId === candidate.moduleId);
  const now = new Date().toISOString();
  return modulePackageSchema.parse({
    ...candidate,
    revision: existing ? Math.max(candidate.revision, existing.revision + 1) : candidate.revision,
    metadata: {
      ...candidate.metadata,
      createdAt: existing?.metadata.createdAt ?? candidate.metadata.createdAt,
      updatedAt: now,
    },
  });
}
