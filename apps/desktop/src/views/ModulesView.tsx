import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { BookOpen, Check, Code2, Download, Eye, FlaskConical, History, LayoutList, Loader2, Play, Save, Square, Trash2, Upload } from "lucide-react";
import {
  deriveRoomWorldState,
  modulePackageSchema,
  type AudienceV2,
  type ModulePackageV1,
  type PlayerVisibleLocationV1,
  type RoomEntityV2,
} from "@coc-room/protocol";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, readTextFile, writeFile } from "@tauri-apps/plugin-fs";
import { getRepository, type StoredModule, type StoredModuleDraft } from "../data/repository";
import { describeParserFailure, describeParserProgress, getModuleParserProvenance, parseModule, renderPdfPages, selectModuleSource, type ParserError, type ParserProgress, type ParserResult, type PdfVisualPage } from "../lib/module-parser";
import type { RoomSession } from "../network/RoomSession";
import { RoomSessionV2 } from "../network/RoomSessionV2";
import { useAppStore } from "../store/app-store";
import { KeeperPreparationReader } from "../components/modules/KeeperPreparationReader";
import { prepareKeeperGuide } from "../ai/keeper-preparation";
import { hasCompleteScenePublications } from "../lib/scene-publications";
import { guideNotes } from "../ai/keeper-guide-context";
import { Button } from "../components/ui/Button";
import { Field, Input, Textarea } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";
import { ModuleEntityBrowser } from "../components/module/ModuleEntityBrowser";
import { ModuleSourceAssetsPanel } from "../components/module/ModuleSourceAssetsPanel";
import { StructuredModuleEditor } from "../components/module/StructuredModuleEditor";
import { downloadBytesInBrowser } from "../lib/browser-download";
import {
  createCocmodPackage,
  parseCocmodPackage,
  parseLegacyCocmodJson,
  storedCocmodContents,
  withStoredCocmodContents,
} from "../lib/cocmod-package";
import {
  addManagedAssetReference,
  hasManagedAssetStore,
  importReceivedManagedAsset,
  readManagedAssetChunk,
} from "../lib/asset-store";
import { canExecuteLocalAi, getLocalAiRuntime } from "../lib/runtime-capabilities";
import { SOURCE_ATTACHMENTS_NAMESPACE, moduleSourceImages } from "../lib/module-source-assets";
import {
  buildPublishedModuleArtifactV2,
  buildPublishedModuleEntityV2,
  findPublishedModuleEntityV2,
} from "../lib/module-room-publishing-v2";

type ModuleRoomSession = RoomSession | RoomSessionV2;
type PreparationStage = "source" | "parse" | "review" | "saved" | "room";
type PreparationMode = "play-aid" | "keeper-reference";
type WorkflowError = { step: Exclude<PreparationStage, "saved">; message: string };
type ActiveParseTask = { id: number; controller: AbortController; stopped: boolean; hasParsedResult?: boolean };
type SwitchModuleOptions = { returnToRoom?: boolean };
const ACTIVE_MODULE_DRAFT_ID = "active-module-editor";
type RetainedParserPreparation = {
  preparationMode: PreparationMode;
  sourceName: string;
  sourceText: string;
  sourcePath?: string;
  sourceFile?: File;
  sourcePending: boolean;
  pdfPageSelection: string;
  pdfVisualPages: PdfVisualPage[];
  workflowError?: WorkflowError;
};

// Opening Settings unmounts this view. Keep only the in-progress parser input in
// memory so the explicit recovery action can make a safe round trip without
// persisting scenario text or uploaded files anywhere.
let retainedParserPreparation: RetainedParserPreparation | undefined;

export function ModulesView({ session }: { session?: ModuleRoomSession }) {
  const localAiRuntime = getLocalAiRuntime();
  const localAiAvailable = canExecuteLocalAi(localAiRuntime);
  const restoredPreparationRef = useRef(retainedParserPreparation);
  const restoredPreparation = restoredPreparationRef.current;
  const modules = useAppStore((state) => state.modules);
  const setModules = useAppStore((state) => state.setModules);
  const events = useAppStore((state) => state.events);
  const parserProvider = useAppStore((state) => state.parserProvider);
  const setParserProvider = useAppStore((state) => state.setParserProvider);
  const codexModel = useAppStore((state) => state.codexModel);
  const deepseekModel = useAppStore((state) => state.deepseekModel);
  const model = parserProvider === "codex" ? codexModel : deepseekModel;
  const currentRoom = useAppStore((state) => state.currentRoom);
  const pendingRoomModule = useAppStore((state) => state.pendingRoomModule);
  const setPendingRoomModule = useAppStore((state) => state.setPendingRoomModule);
  const setActiveView = useAppStore((state) => state.setActiveView);
  const [sourceName, setSourceName] = useState(() => restoredPreparation?.sourceName ?? "新模组.md");
  const [preparationMode, setPreparationMode] = useState<PreparationMode>(() => restoredPreparation?.preparationMode ?? "play-aid");
  const [sourceText, setSourceText] = useState(() => restoredPreparation?.sourceText ?? "");
  const [sourcePath, setSourcePath] = useState<string | undefined>(() => restoredPreparation?.sourcePath);
  const [sourceFile, setSourceFile] = useState<File | undefined>(() => restoredPreparation?.sourceFile);
  const [sourcePending, setSourcePending] = useState(() => restoredPreparation?.sourcePending ?? false);
  const [pdfPageSelection, setPdfPageSelection] = useState(() => restoredPreparation?.pdfPageSelection ?? "1");
  const [pdfVisualPages, setPdfVisualPages] = useState<PdfVisualPage[]>(() => restoredPreparation?.pdfVisualPages ?? []);
  const [draft, setDraft] = useState("");
  const draftValueRef = useRef(draft);
  draftValueRef.current = draft;
  const guideTaskRef = useRef<AbortController>();
  const [guideBusy, setGuideBusy] = useState(false);
  const [guideError, setGuideError] = useState<string>();
  const [draftSourceText, setDraftSourceText] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [draftOrigin, setDraftOrigin] = useState<"parsed" | "mock" | "stored">("stored");
  const [recoveryDraft, setRecoveryDraft] = useState<StoredModuleDraft>();
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [draftRecoveryNotice, setDraftRecoveryNotice] = useState<string>();
  const [selectedModuleId, setSelectedModuleId] = useState<string>();
  const [selectedRevision, setSelectedRevision] = useState<number>();
  const [moduleHistories, setModuleHistories] = useState<Record<string, StoredModule[]>>({});
  const [workspaceMode, setWorkspaceMode] = useState<"browse" | "structured" | "json">("browse");
  const [progress, setProgress] = useState<ParserProgress[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [error, setError] = useState<string>();
  const [workflowError, setWorkflowError] = useState<WorkflowError | undefined>(() => restoredPreparation?.workflowError);
  const [parserNotice, setParserNotice] = useState<string>();
  const [parseStopping, setParseStopping] = useState(false);
  const browserSourceRef = useRef<HTMLInputElement>(null);
  const browserImportRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const parseTaskIdRef = useRef(0);
  const activeParseTaskRef = useRef<ActiveParseTask>();
  const draftRecoveryGenerationRef = useRef(0);
  const draftRecoveryWriteRef = useRef<Promise<void>>(Promise.resolve());
  const sessionV2 = session instanceof RoomSessionV2 ? session : undefined;
  const sessionV1 = session && !(session instanceof RoomSessionV2) ? session : undefined;
  const canManageRoomModule = currentRoom?.localRole === "host" && session?.isHost === true;
  const canManageV2RoomModule = canManageRoomModule && Boolean(sessionV2);
  const hasPdfSource = Boolean(
    sourcePath?.toLowerCase().endsWith(".pdf") || sourceFile?.name.toLowerCase().endsWith(".pdf"),
  );
  const hasSource = Boolean(sourceText.trim() || sourcePath || sourceFile);
  const alternateParserProvider = parserProvider === "codex" ? "deepseek" : "codex";
  const canSwitchParserProvider = alternateParserProvider === "codex" || !hasPdfSource;
  const hasUnsavedWork = draftDirty || parsing || guideBusy || (sourcePending && hasSource);
  const unsavedWorkRef = useRef(hasUnsavedWork);
  const unsavedWorkMessageRef = useRef("");
  const parsedDraft = useMemo(() => {
    try { return modulePackageSchema.safeParse(JSON.parse(draft)); } catch { return undefined; }
  }, [draft]);
  const isMockDraft = draftOrigin === "mock" || Boolean(
    parsedDraft?.success && getModuleParserProvenance(parsedDraft.data)?.provider === "mock",
  );
  const pendingModulePackage = parsedDraft?.success
    && parsedDraft.data.moduleId === pendingRoomModule?.moduleId
    && parsedDraft.data.revision === pendingRoomModule.revision
      ? parsedDraft.data
      : modules.find((modulePackage) => (
          modulePackage.moduleId === pendingRoomModule?.moduleId
          && modulePackage.revision === pendingRoomModule.revision
        ));
  const activeRoomModuleV1 = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === "module.switched") return event.payload;
    }
    return undefined;
  }, [events]);
  const activeRoomModule = sessionV2?.world.activeModule ?? activeRoomModuleV1;
  const roomWorld = useMemo(() => deriveRoomWorldState(events), [events]);
  const publishedLocations = useMemo<ReadonlyMap<string, PlayerVisibleLocationV1>>(() => {
    if (!sessionV2) return roomWorld.locations;
    return new Map([...sessionV2.world.entities.values()]
      .filter((entity) => entity.kind === "location")
      .map((entity) => [entity.entityId, {
        id: entity.entityId,
        name: entity.name,
        description: entity.description,
      }]));
  }, [roomWorld.locations, sessionV2, sessionV2?.world]);
  const isActiveRoomModule = useCallback((modulePackage: ModulePackageV1) => (
    activeRoomModule?.moduleId === modulePackage.moduleId
      && activeRoomModule.revision === modulePackage.revision
  ), [activeRoomModule]);
  const preparationStage: PreparationStage = (() => {
    if (parsing) return "parse";
    if (draftDirty) return "review";
    if (sourcePending && hasSource) return "parse";
    if (draft && parsedDraft?.success) {
      return isActiveRoomModule(parsedDraft.data) ? "room" : "saved";
    }
    return hasSource ? "parse" : "source";
  })();

  const rememberHistory = useCallback((moduleId: string, history: StoredModule[]) => {
    setModuleHistories((current) => ({ ...current, [moduleId]: history }));
  }, []);

  useEffect(() => {
    if (retainedParserPreparation === restoredPreparationRef.current) {
      retainedParserPreparation = undefined;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getRepository()
      .then((repository) => repository.getModuleDraft(ACTIVE_MODULE_DRAFT_ID))
      .then((stored) => {
        if (!cancelled) setRecoveryDraft(stored);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setRecoveryChecked(true);
      });
    return () => { cancelled = true; };
  }, []);

  const confirmReplaceDraft = useCallback((nextAction: string) => (
    !draftDirty || window.confirm(`你还有尚未保存的模组修改。${nextAction}会丢失这些修改，确认继续吗？`)
  ), [draftDirty]);

  const persistDraftRecovery = useCallback((value: StoredModuleDraft) => {
    const generation = draftRecoveryGenerationRef.current;
    const write = draftRecoveryWriteRef.current.then(async () => {
      if (generation !== draftRecoveryGenerationRef.current) return;
      const repository = await getRepository();
      if (generation !== draftRecoveryGenerationRef.current) return;
      await repository.saveModuleDraft(value);
    });
    // Keep later saves usable after a failed write, but let the caller report it.
    draftRecoveryWriteRef.current = write.catch(() => undefined);
    return write;
  }, []);

  const invalidateDraftRecovery = useCallback(async () => {
    const generation = ++draftRecoveryGenerationRef.current;
    // A save already in progress must settle before deletion. Queued snapshots
    // from the previous generation are skipped, so they cannot revive a draft.
    const remove = draftRecoveryWriteRef.current.then(async () => {
      const repository = await getRepository();
      await repository.deleteModuleDraft(ACTIVE_MODULE_DRAFT_ID);
    });
    draftRecoveryWriteRef.current = remove.catch(() => undefined);
    await remove;
    if (generation === draftRecoveryGenerationRef.current) {
      setRecoveryDraft(undefined);
      setDraftRecoveryNotice(undefined);
    }
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
    setDraftOrigin("stored");
    setSourcePending(false);
    setWorkspaceMode("browse");
    setWarnings(moduleSourceWarnings(stored.package));
    setError(undefined);
    setWorkflowError(undefined);
    setGuideError(undefined);
  }, []);

  const openModule = useCallback(async (modulePackage: ModulePackageV1) => {
    if (!confirmReplaceDraft("打开其他备团资料")) return;
    try {
      const repository = await getRepository();
      const stored = await repository.getModule(modulePackage.moduleId, modulePackage.revision)
        ?? { package: modulePackage, sourceText: "" };
      // An unrestored recovery draft may be the only copy of hours of unsaved
      // work; browsing other saved material must never delete it. The slot is
      // only cleared when it holds the autosave of the dirty draft the keeper
      // just confirmed to drop.
      if (draftDirty && !recoveryDraft) await invalidateDraftRecovery();
      showStoredModule(stored);
      rememberHistory(
        modulePackage.moduleId,
        await repository.listModules({ moduleId: modulePackage.moduleId, latestOnly: false }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [confirmReplaceDraft, draftDirty, invalidateDraftRecovery, recoveryDraft, rememberHistory, showStoredModule]);

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
    unsavedWorkRef.current = hasUnsavedWork;
    unsavedWorkMessageRef.current = draftDirty
      ? draftRecoveryNotice?.startsWith("草稿恢复点已保存")
        ? "这份草稿已在本机留下恢复点，但还没有进入正式模组库。现在离开后可回来恢复，确定暂时离开吗？"
        : "AI 整理结果或模组修改还没有正式保存，本机恢复点也可能尚未写完。现在离开可能丢失最近修改，确定继续吗？"
      : guideBusy
        ? "主持引导仍在整理中。现在离开会中断引导，已有资料保留，确定继续吗？"
      : parsing
        ? "模组仍在整理中。现在离开会中断本次整理，确定继续吗？"
        : "已经放入的模组原文还没有整理或保存。离开会丢失本次准备，确定继续吗？";
  }, [draftDirty, draftRecoveryNotice, hasUnsavedWork, parsing, guideBusy]);

  useEffect(() => {
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        previous.activeView === "modules"
        && state.activeView !== "modules"
        && unsavedWorkRef.current
        && !window.confirm(unsavedWorkMessageRef.current)
      ) {
        useAppStore.getState().setActiveView("modules");
      }
    });
    const preventAccidentalClose = (event: BeforeUnloadEvent) => {
      if (!unsavedWorkRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventAccidentalClose);
    return () => {
      unsubscribe();
      window.removeEventListener("beforeunload", preventAccidentalClose);
    };
  }, []);

  useEffect(() => () => {
    guideTaskRef.current?.abort();
    const task = activeParseTaskRef.current;
    if (!task) return;
    activeParseTaskRef.current = undefined;
    task.stopped = true;
    task.controller.abort();
    // The leave guard promises that leaving interrupts the run. On desktop the
    // sidecar keeps billing unless the native side is told to terminate it.
    if (window.__TAURI_INTERNALS__) void invoke("cancel_module_parse").catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!recoveryChecked || recoveryDraft || selectedModuleId || draft.trim() || modules.length === 0) return;
    if (!pendingRoomModule) {
      void openModule(modules[0]!);
      return;
    }
    void getRepository().then(async (repository) => {
      const stored = await repository.getModule(pendingRoomModule.moduleId, pendingRoomModule.revision);
      if (stored) showStoredModule(stored);
      else await openModule(modules[0]!);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [draft, modules, openModule, pendingRoomModule, recoveryChecked, recoveryDraft, selectedModuleId, showStoredModule]);

  useEffect(() => {
    if (!recoveryChecked || !draftDirty || !parsedDraft?.success) return;
    if (recoveryDraft) {
      // The single recovery slot still holds an unrestored draft. Overwriting
      // it here would silently destroy the keeper's only copy, so keep it and
      // say plainly that the current edits have no recovery point yet.
      setDraftRecoveryNotice("本机恢复点仍保留着上次未恢复的草稿；当前修改不会自动留恢复点，请尽快正式保存。");
      return;
    }
    const modulePackage = parsedDraft.data;
    const recoveryGeneration = draftRecoveryGenerationRef.current;
    const timer = globalThis.setTimeout(() => {
      if (recoveryGeneration !== draftRecoveryGenerationRef.current) return;
      void persistDraftRecovery({
          draftId: ACTIVE_MODULE_DRAFT_ID,
          package: modulePackage,
          sourceText: draftSourceText,
          sourceName,
          warnings,
          updatedAt: new Date().toISOString(),
        })
        .then(() => {
          if (recoveryGeneration === draftRecoveryGenerationRef.current) {
            setDraftRecoveryNotice("草稿恢复点已保存到本机");
          }
        })
        .catch(() => {
          if (recoveryGeneration === draftRecoveryGenerationRef.current) {
            setDraftRecoveryNotice("草稿恢复点暂时未能保存；请尽快确认并保存备团资料");
          }
        });
    }, 500);
    return () => globalThis.clearTimeout(timer);
  }, [draftDirty, draftSourceText, isMockDraft, parsedDraft, persistDraftRecovery, recoveryChecked, recoveryDraft, sourceName, warnings]);

  const restoreRecoveryDraft = () => {
    if (!recoveryDraft) return;
    setDraft(JSON.stringify(recoveryDraft.package, null, 2));
    setDraftSourceText(recoveryDraft.sourceText);
    setSourceName(recoveryDraft.sourceName || "恢复的模组");
    setWarnings([...recoveryDraft.warnings]);
    setDraftDirty(true);
    setDraftOrigin("parsed");
    setSourcePending(false);
    setSelectedModuleId(recoveryDraft.package.moduleId);
    setSelectedRevision(recoveryDraft.package.revision);
    setWorkspaceMode("browse");
    setWorkflowError(undefined);
    setRecoveryDraft(undefined);
    setDraftRecoveryNotice("已恢复上次未保存的草稿；它仍未进入正式模组库");
  };

  const discardRecoveryDraft = async () => {
    try {
      await invalidateDraftRecovery();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    if (!selectedModuleId || pendingRoomModule) return;
    // The library and import panels can be taller than a compact window. Put
    // the newly opened workbench in view so a successful import is apparent.
    // During new-room handoff, keep the explicit confirmation banner visible.
    const frame = window.requestAnimationFrame(() => {
      const workspace = workspaceRef.current;
      if (workspace && typeof workspace.scrollIntoView === "function") workspace.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingRoomModule, selectedModuleId, selectedRevision]);

  const chooseSource = async () => {
    if (!window.__TAURI_INTERNALS__) {
      browserSourceRef.current?.click();
      return;
    }
    if (!confirmReplaceDraft("选择新的原文")) return;
    try {
      const path = await selectModuleSource();
      if (path) {
        setPdfVisualPages([]);
        setSourceFile(undefined);
        setSourceName(path.split(/[\\/]/).at(-1) ?? "module");
        if (/\.(txt|md)$/i.test(path)) {
          setSourceText(await readTextFile(path));
          setSourcePath(undefined);
        } else {
          setSourceText("");
          setSourcePath(path);
        }
        setSourcePending(true);
      }
      setWorkflowError(undefined);
    } catch (cause) {
      setWorkflowError({ step: "source", message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const chooseBrowserSource = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!confirmReplaceDraft("选择新的原文")) return;
    try {
      if (!/\.(txt|md|markdown|docx|pdf|zip)$/i.test(file.name)) {
        throw new Error("仅支持 TXT、Markdown、DOCX、PDF 或安全 ZIP");
      }
      const maximum = /\.pdf$/i.test(file.name) ? 200 * 1024 * 1024 : 100 * 1024 * 1024;
      if (file.size < 1 || file.size > maximum) throw new Error(`文件为空或超过 ${maximum / 1024 / 1024} MiB 上限`);
      setPdfVisualPages([]);
      setSourceName(file.name);
      if (/\.(txt|md|markdown)$/i.test(file.name)) {
        setSourceText(await file.text());
        setSourceFile(undefined);
      } else {
        setSourceText("");
        setSourceFile(file);
      }
      setSourcePath(undefined);
      setSourcePending(true);
      setWorkflowError(undefined);
    } catch (cause) {
      setWorkflowError({ step: "source", message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const inspectPdfPages = async () => {
    if (!localAiAvailable) {
      setWorkflowError({ step: "source", message: "当前网页没有本地 AI 安全桥，不能渲染 PDF 页面。请改用 KP 开发页或桌面端。" });
      return;
    }
    const pdfSource = sourcePath ?? sourceFile;
    if (!pdfSource || !/\.pdf$/i.test(typeof pdfSource === "string" ? pdfSource : pdfSource.name)) return;
    const pageNumbers = [...new Set(pdfPageSelection.split(/[，,\s]+/).filter(Boolean).map(Number))];
    if (!pageNumbers.length || pageNumbers.length > 4 || pageNumbers.some((value) => !Number.isInteger(value) || value < 1)) {
      return setWorkflowError({ step: "source", message: "请输入 1–4 个有效页码，用逗号分隔" });
    }
    setBusy(true); setWorkflowError(undefined);
    try { setPdfVisualPages(await renderPdfPages(pdfSource, pageNumbers)); }
    catch (cause) { setWorkflowError({ step: "source", message: cause instanceof Error ? cause.message : String(cause) }); }
    finally { setBusy(false); }
  };

  const openParserSettings = () => {
    retainedParserPreparation = {
      preparationMode,
      sourceName,
      sourceText,
      sourcePath,
      sourceFile,
      sourcePending,
      pdfPageSelection,
      pdfVisualPages: [...pdfVisualPages],
      workflowError,
    };
    // This is an explicit recovery route, so the normal destructive-navigation
    // guard must not claim that the preparation will be discarded.
    unsavedWorkRef.current = false;
    setActiveView("settings");
  };

  const switchParserProvider = async () => {
    if (!canSwitchParserProvider) return;
    try {
      const repository = await getRepository();
      await repository.setSetting("moduleParserProvider", alternateParserProvider);
      setParserProvider(alternateParserProvider);
      setWorkflowError(undefined);
      setProgress([]);
      setParserNotice(
        `已改用 ${alternateParserProvider === "codex" ? "Codex" : "DeepSeek"}；原文和已选页仍保留，请点击“开始整理模组”重试。`,
      );
    } catch (cause) {
      setWorkflowError({ step: "parse", message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const runParser = async (mock = false) => {
    if (activeParseTaskRef.current || guideTaskRef.current) return;
    if (!mock && !localAiAvailable) {
      return setWorkflowError({ step: "parse", message: "当前网页没有本地 AI 安全桥，不能执行真实模组整理。你仍可导入已整理的 .cocmod，或使用下面的模拟结果检查界面。" });
    }
    if (!sourceText.trim() && !sourcePath && !sourceFile) {
      return setWorkflowError({ step: "source", message: "请粘贴文字或选择模组文件" });
    }
    if (!confirmReplaceDraft("重新整理模组")) return;
    if (recoveryDraft && !window.confirm(
      `本机还保留着一份未恢复的备团草稿“${recoveryDraft.package.metadata.title}”。整理成功后会用新草稿覆盖它的恢复点，之后无法再找回，确认继续吗？`,
    )) return;
    const task: ActiveParseTask = {
      id: ++parseTaskIdRef.current,
      controller: new AbortController(),
      stopped: false,
    };
    activeParseTaskRef.current = task;
    setBusy(true); setParsing(true); setParseStopping(false); setParserNotice(undefined); setWorkflowError(undefined); setProgress([]); setWarnings([]); setGuideError(undefined);
    try {
      const messages = await parseModule(
        {
          sourceText: sourceText || undefined,
          sourcePath,
          sourceFile,
          sourceName,
          provider: parserProvider,
          model,
          pdfVisualPageNumbers: pdfVisualPages.length
            ? pdfVisualPages.map((page) => page.pageNumber)
            : undefined,
          mock,
        },
        (update) => {
          if (activeParseTaskRef.current === task && !task.stopped) {
            setProgress((current) => [...current, update]);
          }
        },
        task.controller.signal,
      );
      if (activeParseTaskRef.current !== task) return;
      if (task.stopped || task.controller.signal.aborted) {
        setProgress([]);
        setParserNotice("已停止本次整理；没有生成或保存新草稿，已选择的原文仍保留在这里。");
        return;
      }
      const updates = messages.filter((message): message is ParserProgress => message.type === "progress");
      const failure = messages.find((message): message is ParserError => message.type === "error");
      const result = messages.find((message): message is ParserResult => message.type === "result");
      setProgress(updates);
      if (failure) throw new Error(describeParserFailure(failure));
      if (!result) throw new Error("解析器没有返回结构化模组");
      const sourceAttachments = (result.sourceAttachments ?? []).filter((attachment) => (
        attachment.kind === "image"
          && /^[a-f0-9]{64}$/iu.test(attachment.sha256)
          && Number.isInteger(attachment.byteLength) && attachment.byteLength > 0
          && Number.isInteger(attachment.width) && attachment.width > 0
          && Number.isInteger(attachment.height) && attachment.height > 0
          && /^image\/(?:png|jpeg|webp|gif)$/u.test(attachment.mediaType)
      ));
      const moduleWithVisualSelection = {
        ...result.module,
        extensions: {
          ...result.module.extensions,
          ...(result.visualPages?.length ? { "org.coc-room.pdf-visual-selection.v1": {
            status: "visually_parsed",
            pages: result.visualPages.map(({ pageNumber, sha256, byteLength, width, height }) => ({ pageNumber, sha256, byteLength, width, height })),
          } } : {}),
          ...(sourceAttachments.length ? { [SOURCE_ATTACHMENTS_NAMESPACE]: {
            status: "detected_not_imported",
            items: sourceAttachments,
          } } : {}),
        },
      };
      await invalidateDraftRecovery();
      setWarnings(moduleSourceWarnings(moduleWithVisualSelection, result.warnings ?? []));
      setDraft(JSON.stringify(moduleWithVisualSelection, null, 2));
      setDraftSourceText(result.normalizedText ?? sourceText);
      setDraftDirty(true);
      setDraftOrigin(mock ? "mock" : "parsed");
      setSourcePending(false);
      setSelectedModuleId(result.module.moduleId);
      setSelectedRevision(result.module.revision);
      setWorkspaceMode("browse");
      task.hasParsedResult = true;
      if (!mock && preparationMode === "keeper-reference" && (!moduleWithVisualSelection.keeperGuide?.preparation || moduleWithVisualSelection.keeperGuide.preparation.scenes.length < moduleWithVisualSelection.scenes.length || moduleWithVisualSelection.keeperGuide.preparation.cast.length < moduleWithVisualSelection.npcs.length || moduleWithVisualSelection.scenes.some((scene) => !hasCompleteScenePublications(moduleWithVisualSelection, scene.id, moduleWithVisualSelection.keeperGuide?.preparation?.scenes.find((entry) => entry.sceneId === scene.id)?.publicEntities)))) {
        const normalizedText = result.normalizedText ?? sourceText;
        // Keep the successful extraction recoverable before the second AI task starts.
        await persistDraftRecovery({
          draftId: ACTIVE_MODULE_DRAFT_ID, package: moduleWithVisualSelection,
          sourceText: normalizedText, sourceName, warnings: result.warnings ?? [], updatedAt: new Date().toISOString(),
        });
        if (task.stopped || activeParseTaskRef.current !== task) return;
        setGuideBusy(true);
        try {
          let expectedDraft = JSON.stringify(moduleWithVisualSelection, null, 2);
          await prepareKeeperGuide({ modulePackage: moduleWithVisualSelection, sourceText: normalizedText, provider: parserProvider, model, signal: task.controller.signal,
            onPartial: async (guide) => {
              if (task.stopped || activeParseTaskRef.current !== task) throw new Error("主持引导已停止");
              if (draftValueRef.current !== expectedDraft) throw new Error("资料在生成期间已改变，请基于当前内容继续整理；你的修改没有被覆盖。");
              const prepared = { ...moduleWithVisualSelection, keeperGuide: guide };
              expectedDraft = JSON.stringify(prepared, null, 2);
              draftValueRef.current = expectedDraft;
              setDraft(expectedDraft);
              await persistDraftRecovery({ draftId: ACTIVE_MODULE_DRAFT_ID, package: prepared, sourceText: normalizedText, sourceName, warnings: result.warnings ?? [], updatedAt: new Date().toISOString() });
            },
          });
        } catch (cause) {
          if (activeParseTaskRef.current === task) setGuideError(task.stopped
            ? "主持引导已停止；提取完成的资料与原文已保留，可以稍后补全。"
            : `资料已保留，主持引导未完成：${cause instanceof Error ? cause.message : String(cause)}`);
        } finally { if (activeParseTaskRef.current === task) setGuideBusy(false); }
      }
    } catch (cause) {
      if (activeParseTaskRef.current !== task) return;
      if (task.stopped || task.controller.signal.aborted) {
        setProgress([]);
        setWorkflowError(undefined);
        setParserNotice(task.hasParsedResult
          ? "已停止主持引导；提取完成的资料和原文仍保留在这里。"
          : "已停止本次整理；没有生成或保存新草稿，已选择的原文仍保留在这里。");
      } else {
        setWorkflowError({ step: "parse", message: cause instanceof Error ? cause.message : String(cause) });
      }
    } finally {
      if (activeParseTaskRef.current === task) {
        if (task.stopped && task.hasParsedResult) setParserNotice("已停止主持引导；提取完成的资料和原文仍保留在这里。");
        activeParseTaskRef.current = undefined;
        setBusy(false);
        setParsing(false);
        setParseStopping(false);
      }
    }
  };

  const prepareCurrentModule = async () => {
    if (!parsedDraft?.success || busy || guideTaskRef.current) return;
    setPreparationMode("keeper-reference");
    const originalDraft = draft;
    const modulePackage = parsedDraft.data;
    const controller = new AbortController();
    guideTaskRef.current = controller;
    setGuideBusy(true);
    setGuideError(undefined);
    try {
      let expectedDraft = originalDraft;
      await prepareKeeperGuide({ modulePackage, sourceText: draftSourceText, provider: parserProvider, model, signal: controller.signal,
        onPartial: async (keeperGuide) => {
          if (controller.signal.aborted) throw new Error("主持引导已停止");
          if (draftValueRef.current !== expectedDraft) throw new Error("资料在生成期间已改变，请基于当前内容继续整理；你的修改没有被覆盖。");
          const prepared = { ...modulePackage, keeperGuide };
          expectedDraft = JSON.stringify(prepared, null, 2);
          draftValueRef.current = expectedDraft;
          setDraft(expectedDraft);
          setDraftDirty(true);
          if (!recoveryDraft) await persistDraftRecovery({ draftId: ACTIVE_MODULE_DRAFT_ID, package: prepared, sourceText: draftSourceText, sourceName, warnings, updatedAt: new Date().toISOString() });
        },
      });
    } catch (cause) {
      if (!controller.signal.aborted) setGuideError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (guideTaskRef.current === controller) { guideTaskRef.current = undefined; setGuideBusy(false); }
    }
  };

  const stopParser = () => {
    const task = activeParseTaskRef.current;
    if (!task || task.stopped) return;
    task.stopped = true;
    setParseStopping(true);
    setWorkflowError(undefined);
    setParserNotice("正在停止本次整理并清理本地 AI 任务…");
    task.controller.abort();
    // On desktop the parse runs in a native sidecar that ignores the fetch
    // signal; ask the backend to terminate it. Even if that request fails,
    // this task is already marked stopped, so its late result is discarded.
    if (window.__TAURI_INTERNALS__) void invoke("cancel_module_parse").catch(() => undefined);
  };

  const saveDraft = async () => {
    setSavingDraft(true);
    setWorkflowError(undefined);
    try {
      const candidate = modulePackageSchema.parse(JSON.parse(draft));
      const repository = await getRepository();
      const storedModules = await repository.listModules();
      const modulePackage = nextModuleRevision(candidate, storedModules.map((item) => item.package));
      if (hasManagedAssetStore()) {
        for (const item of moduleSourceImages(modulePackage).items) {
          if (!item.importedAsset) continue;
          await addManagedAssetReference({
            assetId: item.importedAsset.assetId,
            ownerType: "module",
            ownerId: modulePackage.moduleId,
            ownerRevision: modulePackage.revision,
            slot: `source-image:${item.sha256}`,
          });
        }
      }
      await repository.saveModule({ package: modulePackage, sourceText: draftSourceText });
      // Only clear the recovery slot when it belongs to the draft that was
      // just saved; a pending, unrestored recovery draft must survive.
      if (!recoveryDraft) await invalidateDraftRecovery();
      await refreshLibrary();
      setDraft(JSON.stringify(modulePackage, null, 2));
      setDraftDirty(false);
      setDraftOrigin("stored");
      setSelectedModuleId(modulePackage.moduleId);
      setSelectedRevision(modulePackage.revision);
      setWorkspaceMode("browse");
      setWorkflowError(undefined);
    } catch (cause) {
      setWorkflowError({ step: "review", message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSavingDraft(false);
    }
  };

  const removeModule = async (moduleId: string) => {
    const modulePackage = modules.find((item) => item.moduleId === moduleId);
    const revisionCount = moduleHistories[moduleId]?.length ?? 1;
    if (!window.confirm(`确认删除本机的“${modulePackage?.metadata.title ?? moduleId}”以及全部 ${revisionCount} 个历史版本？已经发给玩家的内容和跑团记录不会消失，但以后无法再从本机打开这份备团资料。`)) return;
    try {
      const repository = await getRepository();
      await repository.deleteModule(moduleId);
      if (useAppStore.getState().pendingRoomModule?.moduleId === moduleId) setPendingRoomModule(undefined);
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
          setDraftOrigin("stored");
          setWorkspaceMode("browse");
        }
      }
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const removeRevision = async (modulePackage: ModulePackageV1) => {
    if (!window.confirm(`确认只删除“${modulePackage.metadata.title}”的第 ${modulePackage.revision} 版？其他历史版本和跑团记录都会保留。`)) return;
    try {
      const repository = await getRepository();
      await repository.deleteModuleRevision(modulePackage.moduleId, modulePackage.revision);
      const pending = useAppStore.getState().pendingRoomModule;
      if (pending?.moduleId === modulePackage.moduleId && pending.revision === modulePackage.revision) setPendingRoomModule(undefined);
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
          setDraftOrigin("stored");
          setWorkspaceMode("browse");
        }
      }
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const saveImportedModule = async (
    candidate: ModulePackageV1,
    beforeSave?: (prepared: ModulePackageV1) => Promise<void>,
  ) => {
    const repository = await getRepository();
    const storedModules = await repository.listModules();
    const existing = await repository.getModule(candidate.moduleId);
    const modulePackage = nextModuleRevision(candidate, storedModules.map((item) => item.package));
    await beforeSave?.(modulePackage);
    await repository.saveModule({ package: modulePackage, sourceText: existing?.sourceText ?? "" });
    // Importing other material must not delete an unrestored recovery draft;
    // the slot is only cleared alongside the dirty draft the keeper agreed to
    // replace in the import confirmation.
    if (draftDirty && !recoveryDraft) await invalidateDraftRecovery();
    await refreshLibrary();
    setDraft(JSON.stringify(modulePackage, null, 2));
    setDraftSourceText(existing?.sourceText ?? "");
    setDraftDirty(false);
    setDraftOrigin("stored");
    setSourcePending(false);
    setSelectedModuleId(modulePackage.moduleId);
    setSelectedRevision(modulePackage.revision);
    setWorkspaceMode("browse");
    setWorkflowError(undefined);
    return modulePackage;
  };

  const importLegacyPackageContent = async (content: string) => {
    try {
      await saveImportedModule(parseLegacyCocmodJson(content));
      setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const importCocmodBytes = async (bytes: Uint8Array) => {
    try {
      const imported = await parseCocmodPackage(bytes);
      const enriched = withStoredCocmodContents(imported.module, {
        boards: imported.boards,
        assets: imported.assets.map(({ bytes: _bytes, ...asset }) => asset),
      });
      await saveImportedModule(enriched, async (storedModule) => {
        if (!hasManagedAssetStore()) return;
        for (const [index, packaged] of imported.assets.entries()) {
          const { bytes: assetBytes, extension: _extension, ...descriptor } = packaged;
          const managed = await importReceivedManagedAsset(descriptor, [assetBytes]);
          await addManagedAssetReference({
            assetId: managed.asset.assetId,
            ownerType: "module",
            ownerId: storedModule.moduleId,
            ownerRevision: storedModule.revision,
            slot: `package:${index}`,
          });
        }
      });
      setWarnings(moduleSourceWarnings(enriched));
      setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const importPackage = async () => {
    if (!window.__TAURI_INTERNALS__) {
      browserImportRef.current?.click();
      return;
    }
    if (!confirmReplaceDraft("导入另一份备团资料")) return;
    try {
      const path = await open({ multiple: false, filters: [{ name: "CoC module", extensions: ["cocmod", "json"] }] });
      if (typeof path !== "string") return;
      if (/\.cocmod$/i.test(path)) await importCocmodBytes(await readFile(path));
      else await importLegacyPackageContent(await readTextFile(path));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const importBrowserPackage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!confirmReplaceDraft("导入另一份备团资料")) return;
    const binaryPackage = /\.cocmod$/i.test(file.name);
    const maximumBytes = binaryPackage ? 512 * 1024 * 1024 : 16 * 1024 * 1024;
    if (file.size > maximumBytes) {
      setError(`模组包超过 ${binaryPackage ? "512 MiB" : "16 MiB"}，已拒绝导入`);
      return;
    }
    try {
      if (binaryPackage) await importCocmodBytes(new Uint8Array(await file.arrayBuffer()));
      else await importLegacyPackageContent(await file.text());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const exportPackage = async (modulePackage: ModulePackageV1) => {
    try {
      const stored = storedCocmodContents(modulePackage);
      if (stored.assets.length > 0 && !hasManagedAssetStore()) {
        throw new Error("该模组包含本地资源，请在桌面应用中导出完整 .cocmod 包");
      }
      const assets = await Promise.all(stored.assets.map(async (asset) => ({
        ...asset,
        bytes: await readCompleteManagedAsset(asset.assetId, asset.byteLength),
      })));
      const content = await createCocmodPackage(modulePackage, { boards: stored.boards, assets });
      const fileName = `${safeName(modulePackage.metadata.title)}-v${modulePackage.revision}.cocmod`;
      if (window.__TAURI_INTERNALS__) {
        const path = await save({ defaultPath: fileName, filters: [{ name: "CoC module", extensions: ["cocmod"] }] });
        if (path) await writeFile(path, content);
      } else downloadBytesInBrowser(fileName, content, "application/vnd.coc-room.module+zip");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const startNewRoomWithModule = (modulePackage: ModulePackageV1) => {
    if (currentRoom || hasUnsavedWork) return;
    setPendingRoomModule({
      moduleId: modulePackage.moduleId,
      revision: modulePackage.revision,
      title: modulePackage.metadata.title,
    });
    setActiveView("lobby");
  };

  const switchModule = async (
    modulePackage: ModulePackageV1,
    options: SwitchModuleOptions = {},
  ) => {
    if (!session || !session.isHost) return;
    try {
      if (sessionV2) {
        await sessionV2.submit({
          type: "module.switched",
          audience: { kind: "room" },
          payload: {
            moduleId: modulePackage.moduleId,
            revision: modulePackage.revision,
            title: modulePackage.metadata.title,
          },
        });
      } else if (sessionV1) {
        await sessionV1.submit("module.switch", { moduleId: modulePackage.moduleId, revision: modulePackage.revision, title: modulePackage.metadata.title });
      }
      const pending = useAppStore.getState().pendingRoomModule;
      if (pending?.moduleId === modulePackage.moduleId && pending.revision === modulePackage.revision) {
        setPendingRoomModule(undefined);
        setActiveView("room");
      } else if (options.returnToRoom && sessionV2) {
        // A V2 host submission resolves only after the host has accepted and
        // persisted the authoritative event. Do not leave the workbench on an
        // optimistic click: a rejected switch must remain here with its error.
        setActiveView("room");
      }
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const revealContent = async (
    modulePackage: ModulePackageV1,
    content: {
      id: string;
      title: string;
      body: string;
      type: "clue" | "handout";
      locationId?: string;
    },
  ) => {
    if (!session?.isHost) return;
    if (!content.body.trim()) {
      setError("该条目没有经过确认的玩家可见正文；请先在结构化编辑中填写玩家可见文本或手记正文");
      return;
    }
    if (!window.confirm(`确认向全房间永久公开“${content.title}”？公开事件无法撤回。`)) return;
    try {
      if (sessionV2) {
        const audience = { kind: "room" as const };
        const artifact = buildPublishedModuleArtifactV2(
          sessionV2.world.artifacts,
          modulePackage,
          {
            sourceId: content.id,
            kind: content.type,
            title: content.title,
            body: content.body,
            audience,
          },
          () => crypto.randomUUID(),
        );
        await sessionV2.submit({
          type: "artifact.upserted",
          audience,
          payload: { artifact },
        });
      } else if (sessionV1) {
        await sessionV1.submit("content.reveal", {
          moduleId: modulePackage.moduleId,
          revision: modulePackage.revision,
          contentId: content.id,
          contentType: content.type,
          title: content.title,
          body: content.body,
          ...(content.locationId === undefined ? {} : { locationId: content.locationId }),
        });
      }
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const publishEntityV2 = async (
    modulePackage: ModulePackageV1,
    input: { sourceId: string; kind: "location" | "npc"; name: string; playerDescription?: string },
    audience: AudienceV2 = { kind: "room" },
  ) => {
    if (!sessionV2?.isHost) return;
    const description = input.playerDescription?.trim();
    if (!description) {
      setError(`“${input.name}”尚未填写玩家可见描述；为避免泄漏 KP 内容，已拒绝发布。`);
      return;
    }
    if (!window.confirm(`确认把“${input.name}”的玩家可见介绍发到房间？请先确认文字中没有尚未揭晓的秘密；发送后无法收回。`)) return;
    const entity = buildPublishedModuleEntityV2(
      sessionV2.world.entities,
      modulePackage,
      { ...input, description, audience },
      () => crypto.randomUUID(),
    );
    try {
      await sessionV2.submit({ type: "entity.upserted", audience, payload: { entity } });
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="h-full overflow-y-auto p-7">
      <div className="mx-auto grid max-w-6xl gap-6">
        <header>
          <p className="text-xs uppercase tracking-[.3em] text-brass">开团前准备</p>
          <h1 className="mt-2 font-serif text-3xl text-ink">把模组变成随手可查的备团资料</h1>
          <p className="mt-2 text-sm text-zinc-400">选中原文后，AI 会帮你整理场景、地点、人物和线索。你检查并保存，再把它用于本次跑团；完整模组始终只留在 KP 本机。</p>
        </header>
        {pendingRoomModule && (
          <section aria-label="新房间模组交接" className="rounded-xl border border-brass/50 bg-brass/5 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[.18em] text-brass">{currentRoom ? "房间已经建好 · 还差最后确认" : "新团备团计划"}</p>
                <h2 className="mt-1 font-semibold text-ink">{pendingRoomModule.title} · 第 {pendingRoomModule.revision} 版</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-400">
                  {!currentRoom
                    ? "这份模组已经预选，但房间还没创建。继续建房不会公开任何模组正文。"
                    : currentRoom.localRole !== "host"
                      ? "当前进入的是玩家房间，不能把 KP 模组带入；你可以取消这次预选，模组本身仍会留在资料库。"
                      : !pendingModulePackage
                        ? "房间已经创建，但正在读取预选的模组版本；在确认前，房间尚未使用任何模组。"
                        : canManageRoomModule
                          ? "房间已经连接，但这份模组尚未带入。请确认后再进入现场；只会发布模组名称和版本，不会公开正文。"
                          : "房间已经创建，但连接尚未准备好。连接恢复后再确认；现在不会把模组标记为房间使用中。"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {!currentRoom && <Button onClick={() => setActiveView("lobby")}><Play className="mr-2 h-4 w-4" />继续创建房间</Button>}
                {currentRoom?.localRole === "host" && pendingModulePackage && (
                  <Button disabled={!canManageRoomModule} onClick={() => void switchModule(pendingModulePackage)}>
                    <Play className="mr-2 h-4 w-4" />确认使用并进入现场
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setPendingRoomModule(undefined)}>{currentRoom ? "稍后再决定" : "取消预选"}</Button>
              </div>
            </div>
          </section>
        )}
        {recoveryDraft && !draftDirty && (
          <section aria-label="可恢复的模组草稿" className="rounded-xl border border-amber-700/60 bg-amber-950/20 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[.18em] text-amber-300">发现未保存的备团草稿</p>
                <h2 className="mt-1 font-semibold text-ink">{recoveryDraft.package.metadata.title}</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-400">
                  上次整理停在确认前（{new Date(recoveryDraft.updatedAt).toLocaleString("zh-CN", { hour12: false })}）。恢复只会重新打开草稿，不会把它自动用于房间。
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  {recoveryDraft.package.scenes.length} 场景 · {recoveryDraft.package.locations.length} 地点 · {recoveryDraft.package.npcs.length} NPC · {recoveryDraft.package.clues.length} 线索
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={restoreRecoveryDraft}><BookOpen className="mr-2 h-4 w-4" />恢复并继续检查</Button>
                <Button variant="ghost" onClick={() => void discardRecoveryDraft()}>放弃这份草稿</Button>
              </div>
            </div>
          </section>
        )}
        <PreparationSteps stage={preparationStage} />
        <div className="grid gap-5 xl:grid-cols-[390px_minmax(0,1fr)]">
          <div className="grid content-start gap-5">
            <Panel aria-label="模组解析步骤" className="grid gap-4">
              <fieldset aria-label="整理模式" disabled={busy || guideBusy} className="grid gap-2">
                <legend className="mb-2 text-sm font-semibold">整理模式</legend>
                <label className={`cursor-pointer rounded-lg border p-3 ${preparationMode === "play-aid" ? "border-brass bg-brass/5" : "border-zinc-800"}`}>
                  <span className="flex items-center gap-2 text-sm font-medium"><input type="radio" name="preparation-mode" aria-label="跑团辅助" checked={preparationMode === "play-aid"} onChange={() => setPreparationMode("play-aid")} />跑团辅助</span>
                  <p className="mt-1 text-xs leading-5 text-zinc-400">整理委托与调查目标、场景、人物、线索和地图资料，供熟悉模组的 KP 查阅和使用。</p>
                </label>
                <label className={`cursor-pointer rounded-lg border p-3 ${preparationMode === "keeper-reference" ? "border-brass bg-brass/5" : "border-zinc-800"}`}>
                  <span className="flex items-center gap-2 text-sm font-medium"><input type="radio" name="preparation-mode" aria-label="主持参考" checked={preparationMode === "keeper-reference"} onChange={() => setPreparationMode("keeper-reference")} />主持参考</span>
                  <p className="mt-1 text-xs leading-5 text-zinc-400">包含跑团辅助的全部资料，再补真相、开场、人物扮演和逐幕建议，帮助不熟悉模组的 KP 备团。</p>
                </label>
              </fieldset>
              <input
                ref={browserSourceRef}
                type="file"
                aria-label="选择原始模组文本"
                accept=".txt,.md,.markdown,.docx,.pdf,.zip,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,application/zip"
                className="hidden"
                onChange={(event) => void chooseBrowserSource(event)}
              />
              <div>
                <div className="flex items-center gap-2"><span className="grid h-7 w-7 place-items-center rounded-full bg-brass text-sm font-bold text-zinc-950">1</span><div><h2 className="font-semibold">放入模组原文</h2><p className="text-xs text-zinc-500">选择文件，或直接粘贴正文。</p></div></div>
              </div>
              <Button variant="secondary" onClick={() => void chooseSource()}>
                <Upload className="mr-2 h-4 w-4" />导入模组原文
              </Button>
              <Field label="或直接粘贴文字 / Markdown">
                <Textarea
                  aria-label="粘贴原始模组文本"
                  value={sourceText}
                  onChange={(event) => {
                    setSourceText(event.target.value);
                    setSourcePath(undefined);
                    setSourceFile(undefined);
                    setPdfVisualPages([]);
                    setSourcePending(Boolean(event.target.value.trim()));
                    setWorkflowError(undefined);
                  }}
                  className="min-h-40"
                  placeholder="把模组正文粘贴到这里……"
                />
              </Field>
              {sourcePath && <p className="break-all text-xs text-zinc-500">已选择：{sourceName}</p>}
              {sourceFile && <p className="break-all text-xs text-zinc-500">已选择：{sourceFile.name}（只在本次整理中使用）</p>}
              {sourceText.trim() && !sourcePath && !sourceFile && (
                <p className="rounded-md border border-emerald-900/40 bg-emerald-950/15 px-3 py-2 text-xs text-emerald-200">已准备 {sourceText.trim().length.toLocaleString()} 个字符，可以开始解析。</p>
              )}
              {workflowError?.step === "source" && <WorkflowErrorNotice message={workflowError.message} />}

              <div className="mt-1 grid gap-3 border-t border-zinc-800 pt-4">
                <div className="flex items-center gap-2"><span className="grid h-7 w-7 place-items-center rounded-full bg-zinc-800 text-sm font-bold text-zinc-300">2</span><div><h2 className="font-semibold">让 AI 整理备团资料</h2><p className="text-xs text-zinc-500">结果只进入待检查草稿；原文较长时会分段调用，可以随时停止。</p></div></div>
                {!localAiAvailable && <div role="status" aria-label="当前页面不能运行真实模组整理" className="rounded-md border border-sky-900/70 bg-sky-950/20 px-3 py-2 text-xs leading-5 text-sky-100/80">
                  这是没有本地安全桥的网页会话，只提供房间与界面调试。请在 KP 开发页或桌面端运行真实 Codex/DeepSeek；也可以继续导入已整理的模组包。
                </div>}
                {localAiAvailable && <div role="note" aria-label="本次模组整理使用的 AI" className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs leading-5 text-zinc-400">
                  点击后将使用 <span className="font-medium text-zinc-200">{parserProvider === "codex" ? "本机登录的 Codex" : "本机保存凭据的 DeepSeek"}</span>。只有点击按钮才会开始远端模型调用；解析完成后仍需由 KP 检查并明确保存。
                </div>}
                <Button onClick={() => void runParser(false)} disabled={busy || !hasSource || !localAiAvailable}>
                  {parsing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                  {parsing ? "正在整理，请稍候" : localAiAvailable ? "开始整理模组" : "当前页面不能运行真实整理"}
                </Button>
                <div aria-live="polite">
                  {parsing && (
                    <div className="rounded-md border border-brass/30 bg-brass/5 px-3 py-2 text-xs text-zinc-300">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-medium text-brass">{parseStopping ? "正在停止整理" : "正在整理模组"}</p>
                          <p className="mt-1">{parseStopping ? "正在终止本地 AI 任务；已选择的原文不会丢失。" : progress.at(-1) ? describeParserProgress(progress.at(-1)!) : "正在启动本地安全桥……"}</p>
                        </div>
                        <Button type="button" variant="secondary" className="h-8 shrink-0 px-2 text-xs" disabled={parseStopping} onClick={stopParser}>
                          <Square className="mr-1.5 h-3.5 w-3.5" />{parseStopping ? "正在停止…" : "停止整理"}
                        </Button>
                      </div>
                    </div>
                  )}
                  {!parsing && parserNotice && <p role="status" className="rounded-md border border-zinc-700 bg-zinc-900/70 px-3 py-2 text-xs leading-5 text-zinc-300">{parserNotice}</p>}
                  {!parsing && progress.length > 0 && draftDirty && (
                    <p className="flex items-center gap-1.5 text-xs text-emerald-300"><Check className="h-3.5 w-3.5" />整理完成，请到右侧检查关键资料。</p>
                  )}
                </div>
                {workflowError?.step === "parse" && <WorkflowErrorNotice
                  message={workflowError.message}
                  onRetry={() => void runParser(false)}
                  onOpenSettings={openParserSettings}
                  onSwitchProvider={canSwitchParserProvider ? () => void switchParserProvider() : undefined}
                  switchProviderLabel={`改用 ${alternateParserProvider === "codex" ? "Codex" : "DeepSeek"}`}
                />}
                {progress.length > 0 && (
                  <details className="text-xs text-zinc-500">
                    <summary className="cursor-pointer hover:text-zinc-300">查看处理过程（{progress.length} 步）</summary>
                    <div className="mt-2 grid gap-1 border-l border-zinc-800 pl-3">
                      {progress.map((item, index) => <div key={`${item.stage}-${index}`}>{describeParserProgress(item)}</div>)}
                    </div>
                  </details>
                )}
              </div>

              <details className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-500">
                <summary className="cursor-pointer font-medium text-zinc-400 hover:text-zinc-200">高级设置与测试工具</summary>
                <div className="mt-3 grid gap-3">
                  <Field label="来源名称"><Input value={sourceName} onChange={(event) => setSourceName(event.target.value)} /></Field>
                  {hasPdfSource && <div className="grid gap-2 rounded-md border border-zinc-800 p-3"><Field label="视觉解析页（最多 4 页）"><Input aria-label="视觉检查页" value={pdfPageSelection} onChange={(event) => setPdfPageSelection(event.target.value)} placeholder="例如 1, 3, 8" /></Field><Button variant="secondary" disabled={busy || !localAiAvailable} onClick={() => void inspectPdfPages()}><Eye className="mr-2 h-4 w-4" />预览并选中</Button>{pdfVisualPages.length > 0 && <><div className="grid grid-cols-2 gap-2">{pdfVisualPages.map((page) => <figure key={page.pageNumber} className="rounded border border-zinc-800 bg-zinc-950 p-1"><img src={`data:${page.mediaType};base64,${page.dataBase64}`} alt={`PDF 第 ${page.pageNumber} 页`} className="aspect-[3/4] w-full object-contain" /><figcaption className="text-center text-[11px] text-zinc-400">第 {page.pageNumber} 页</figcaption></figure>)}</div><p className="text-xs text-amber-300">所选页会在下一次 Codex 解析中作为受限视觉输入；页面只写入临时目录，完成后即销毁。</p></>}</div>}
                  <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
                    当前解析服务：<span className="text-brass">{parserProvider === "codex" ? "Codex CLI" : "DeepSeek API"}</span>
                    <span className="mt-1 block text-zinc-600">
                      {localAiRuntime === "native"
                        ? "桌面端只把任务交给受控 sidecar，凭据不会进入模组、命令行参数或日志。"
                        : localAiRuntime === "web-bridge"
                          ? "网页只把任务交给同源本地安全桥，凭据不会进入页面、模组或日志。"
                          : "当前页面没有本地 AI 执行通道；真实整理按钮已停用。"}
                    </span>
                    {parserProvider === "codex" && <span className="mt-1 block text-zinc-600">复用本机 Codex 登录；模型在 OpenAI 云端运行，并非离线推理。</span>}
                    {hasPdfSource && <span className="mt-1 block text-amber-300">PDF 将受限提取文字；若未手选，自动视觉解析前 4 个低文本页。单次最多 4 页、长边 1600px。</span>}
                  </div>
                  <Button variant="ghost" onClick={() => void runParser(true)} disabled={busy || !hasSource}><FlaskConical className="mr-2 h-4 w-4" />使用模拟结果测试流程</Button>
                </div>
              </details>
            </Panel>
            <Panel className="grid gap-3">
              <input
                ref={browserImportRef}
                type="file"
                aria-label="导入模组包文件"
                accept=".cocmod,.json,.cocmod.json,application/json,application/zip"
                className="hidden"
                onChange={(event) => void importBrowserPackage(event)}
              />
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-semibold">我的备团资料</h2>
                <Button variant="secondary" className="h-8 px-2 text-xs" onClick={() => void importPackage()}>
                  <Upload className="mr-1.5 h-3.5 w-3.5" />导入已整理的模组包
                </Button>
              </div>
              {modules.length === 0 && <p className="text-sm leading-6 text-zinc-500">这里还没有备团资料。请从上方选择原文，让 AI 先帮你整理；如果同伴发来了模组包，也可以直接导入。</p>}
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
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">{modulePackage.scenes.length} 场景 · {modulePackage.locations.length} 地点 · {modulePackage.npcs.length} NPC</div>
                    <ModuleLibraryEntityDirectory modulePackage={modulePackage} />
                    <div className="mt-3 flex flex-wrap gap-1">
                      <Button variant="secondary" className="h-8 px-2" onClick={() => void openModule(modulePackage)}>
                        <BookOpen className="mr-1.5 h-3.5 w-3.5" />查看资料
                      </Button>
                      {!currentRoom && !hasUnsavedWork && <Button aria-label={`用这份模组开新团：${modulePackage.metadata.title}`} className="h-8 px-2 text-xs" onClick={() => startNewRoomWithModule(modulePackage)}><Play className="mr-1 h-3.5 w-3.5" />用它开新团</Button>}
                      {canManageRoomModule && !activeLatest && (canManageV2RoomModule ? <>
                        <Button aria-label={`用于本次跑团并回到现场：${modulePackage.metadata.title}`} className="h-8 px-2 text-xs" onClick={() => void switchModule(modulePackage, { returnToRoom: true })}><Play className="mr-1 h-3.5 w-3.5" />用于本次跑团并回到现场</Button>
                        <Button aria-label={`用于本次跑团，继续备团：${modulePackage.metadata.title}`} variant="ghost" className="h-8 px-2 text-xs" onClick={() => void switchModule(modulePackage)}><Save className="mr-1 h-3.5 w-3.5" />用于本次跑团，继续备团</Button>
                      </> : <Button aria-label={`用于本次跑团：${modulePackage.metadata.title}`} className="h-8 px-2 text-xs" onClick={() => void switchModule(modulePackage)}><Play className="mr-1 h-3.5 w-3.5" />用于本次跑团</Button>)}
                    </div>
                    <details aria-label={`${modulePackage.metadata.title}历史与管理`} className="mt-3 border-t border-zinc-800 pt-2">
                      <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300">
                        <History className="h-3.5 w-3.5" />历史版本、导出与删除
                      </summary>
                      <div className="mt-2 grid gap-1.5">
                        {history.map((stored) => {
                          const revision = stored.package.revision;
                          const selected = selectedModuleId === modulePackage.moduleId && selectedRevision === revision;
                          const active = isActiveRoomModule(stored.package);
                          return (
                            <div key={revision} className={`flex items-center gap-1 rounded border px-2 py-1.5 ${selected ? "border-brass/40 bg-brass/5" : "border-zinc-800 bg-zinc-950"}`}>
                              <div className="min-w-0 flex-1">
                                <div className="text-xs text-zinc-300">第 {revision} 版{revision === modulePackage.revision ? " · 最新" : ""}{active ? " · 房间使用中" : ""}</div>
                                <div className="truncate text-[10px] text-zinc-600">{new Date(stored.package.metadata.updatedAt).toLocaleString("zh-CN", { hour12: false })}</div>
                              </div>
                              <Button aria-label={`打开${stored.package.metadata.title} v${revision}`} title="打开这一版" variant="ghost" className="h-7 px-1.5" onClick={() => void openModule(stored.package)}><BookOpen className="h-3.5 w-3.5" /></Button>
                              {canManageRoomModule && !active && <Button aria-label={`切换房间模组版本：${stored.package.metadata.title} v${revision}`} title="用于本次跑团" variant="ghost" className="h-7 px-1.5" onClick={() => void switchModule(stored.package)}><Play className="h-3.5 w-3.5" /></Button>}
                              <Button aria-label={`导出${stored.package.metadata.title} v${revision}`} title="导出这一版" variant="ghost" className="h-7 px-1.5" onClick={() => void exportPackage(stored.package)}><Download className="h-3.5 w-3.5" /></Button>
                              <Button aria-label={`删除${stored.package.metadata.title} v${revision}`} title="删除这一版" variant="ghost" className="h-7 px-1.5 text-red-400" onClick={() => void removeRevision(stored.package)}><Trash2 className="h-3.5 w-3.5" /></Button>
                            </div>
                          );
                        })}
                        <Button aria-label={`删除整个模组：${modulePackage.metadata.title}`} variant="ghost" className="mt-1 justify-start text-xs text-red-400" onClick={() => void removeModule(modulePackage.moduleId)}><Trash2 className="mr-1.5 h-3.5 w-3.5" />删除这份模组及全部历史版本</Button>
                      </div>
                    </details>
                  </div>
                );
              })}
            </Panel>
          </div>
          <Panel ref={workspaceRef} tabIndex={-1} className="flex min-h-[700px] flex-col gap-4 xl:h-[calc(100vh-10rem)]">
            {draftDirty && (
              <section
                aria-label={isMockDraft ? "模拟解析草稿" : draftOrigin === "parsed" ? "未保存的解析草稿" : "未保存的模组修改"}
                className="rounded-xl border border-amber-700/60 bg-amber-950/25 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="grid h-7 w-7 place-items-center rounded-full bg-amber-300 text-sm font-bold text-zinc-950">3</span>
                      <h2 className="font-semibold text-amber-100">
                        {isMockDraft ? "模拟结果 · 未调用 Codex 或 DeepSeek" : guideBusy ? "资料提取完成 · 正在整理主持引导" : guideError ? "资料已保留 · 主持参考尚未完成" : parsedDraft?.success && parsedDraft.data.keeperGuide?.workflow?.stage === "needs-review" ? "主持参考已生成 · 有待核对项" : draftOrigin === "parsed" ? "AI 已整理完成 · 等你确认" : "修改尚未保存"}
                      </h2>
                    </div>
                    <p className="mt-2 text-sm text-zinc-300">
                      {isMockDraft
                        ? "这是离线模拟结果（未调用 Codex 或 DeepSeek）。可以直接保存使用，也可以返回左侧做真实整理。"
                        : draftOrigin === "parsed"
                          ? "先读下方的“第一次带这个模组”，理解故事和第一幕怎么开；再按“开团前检查”核对关键资料，有问题可直接修正。"
                          : "确认这次修改没有误删内容，再保存。旧内容会自动保留，可以随时找回。"}
                    </p>
                    {parsedDraft?.success && (
                      <p className="mt-2 text-xs text-zinc-500">
                        {parsedDraft.data.scenes.length} 场景 · {parsedDraft.data.locations.length} 地点 · {parsedDraft.data.npcs.length} NPC · {parsedDraft.data.clues.length} 线索
                      </p>
                    )}
                    {!isMockDraft && draftRecoveryNotice && <p role="status" className="mt-2 text-xs text-emerald-300">{draftRecoveryNotice}</p>}
                  </div>
                  <Button onClick={() => void saveDraft()} disabled={!parsedDraft?.success || savingDraft || guideBusy}>
                    {savingDraft ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    {savingDraft ? "正在保存" : draftOrigin === "parsed" ? "确认并保存备团资料" : "保存修改"}
                  </Button>
                </div>
                {warnings.length > 0 && (
                  <div aria-label="解析提醒" className="mt-3 grid gap-1 rounded-md border border-amber-900/60 bg-zinc-950/35 p-3">
                    <p className="text-xs font-medium text-amber-200">保存前请留意</p>
                    {warnings.map((warning) => <p key={warning} className="text-xs text-amber-300">{warning}</p>)}
                  </div>
                )}
              </section>
            )}
            {!draftDirty && !sourcePending && draft && parsedDraft?.success && (
              <div aria-label="模组已保存" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-900/50 bg-emerald-950/15 px-3 py-3 text-xs text-emerald-200">
                <div className="flex min-w-0 items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-medium">备团资料已保存</p>
                    <p className="mt-1 leading-5 text-zinc-400">
                      {isActiveRoomModule(parsedDraft.data)
                        ? "本次跑团正在使用它。进入房间后，KP 可以随时查阅并公开其中的场景、地点、人物和线索。"
                        : canManageRoomModule
                        ? "最后一步：把它用于当前房间，进入房间后就能直接查阅和公开内容。"
                        : currentRoom?.localRole === "host"
                        ? "连接回你的房间后，即可把它用于本次跑团。"
                        : "可以直接用这份资料开新团；建房成功后仍会让你最后确认一次。"}
                    </p>
                  </div>
                </div>
                {canManageRoomModule && !isActiveRoomModule(parsedDraft.data) && (canManageV2RoomModule ? <div className="flex flex-wrap gap-2">
                  <Button aria-label={`用于本次跑团并回到现场：${parsedDraft.data.metadata.title}`} onClick={() => void switchModule(parsedDraft.data, { returnToRoom: true })}>
                    <Play className="mr-2 h-4 w-4" />用于本次跑团并回到现场
                  </Button>
                  <Button aria-label={`用于本次跑团，继续备团：${parsedDraft.data.metadata.title}`} variant="secondary" onClick={() => void switchModule(parsedDraft.data)}>
                    <Save className="mr-2 h-4 w-4" />用于本次跑团，继续备团
                  </Button>
                </div> : (
                  <Button aria-label={`用于本次跑团：${parsedDraft.data.metadata.title}`} onClick={() => void switchModule(parsedDraft.data)}>
                    <Play className="mr-2 h-4 w-4" />用于本次跑团
                  </Button>
                ))}
                {currentRoom?.localRole === "host" && isActiveRoomModule(parsedDraft.data) && (
                  <Button onClick={() => setActiveView("room")}><Play className="mr-2 h-4 w-4" />回到现场</Button>
                )}
                {!currentRoom && (
                  <Button aria-label={`用这份模组开新团：${parsedDraft.data.metadata.title}`} onClick={() => startNewRoomWithModule(parsedDraft.data)}>
                    <Play className="mr-2 h-4 w-4" />用这份模组开新团
                  </Button>
                )}
              </div>
            )}
            {!draftDirty && warnings.length > 0 && (
              <div aria-label="模组处理提醒" className="grid gap-1 rounded-md border border-amber-900/60 bg-amber-950/20 p-3">
                {warnings.map((warning) => <p key={warning} className="text-xs text-amber-300">{warning}</p>)}
              </div>
            )}
            {workflowError?.step === "review" && <WorkflowErrorNotice message={workflowError.message} />}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3">
              <div>
                <h2 className="font-semibold">检查整理结果</h2>
                <p className="text-xs text-zinc-500">
                  {draftDirty && isMockDraft
                    ? "当前是离线模拟数据，可以保存后直接使用。"
                    : draftDirty && draftOrigin === "parsed"
                    ? "这还是草稿。先确认关键场景、人物和线索，再保存。"
                    : selectedModuleId && selectedRevision
                    ? "你正在查看已经保存的备团资料；修改后会保留原来的内容作为历史版本。"
                    : "先阅读 AI 整理的内容；发现遗漏或写错时，切换到“检查并修正”。"}
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
                    <LayoutList className="h-3.5 w-3.5" />阅读备团资料
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={workspaceMode === "structured"}
                    disabled={!parsedDraft?.success}
                    onClick={() => setWorkspaceMode("structured")}
                    className={`flex h-8 items-center gap-1.5 rounded px-2.5 text-xs transition disabled:opacity-30 ${workspaceMode === "structured" ? "bg-zinc-800 text-brass" : "text-zinc-500 hover:text-zinc-200"}`}
                  >
                    <LayoutList className="h-3.5 w-3.5" />检查并修正
                  </button>
                </div>
                <details className="relative rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-500">
                  <summary className="cursor-pointer select-none hover:text-zinc-200">高级数据</summary>
                  <button
                    type="button"
                    aria-pressed={workspaceMode === "json"}
                    onClick={() => setWorkspaceMode("json")}
                    className={`mt-2 flex h-8 items-center gap-1.5 rounded px-2.5 text-xs transition ${workspaceMode === "json" ? "bg-zinc-800 text-brass" : "text-zinc-500 hover:text-zinc-200"}`}
                  >
                    <Code2 className="h-3.5 w-3.5" />编辑底层 JSON
                  </button>
                </details>
              </div>
            </div>

            {!draft && (
              <div className="grid min-h-96 flex-1 place-items-center rounded-xl border border-dashed border-zinc-800 text-center text-sm text-zinc-500">
                <div><BookOpen className="mx-auto mb-3 h-8 w-8 text-zinc-700" /><p>导入、解析或打开一个模组后，这里会显示人物、地点与线索。</p></div>
              </div>
            )}

            {draft && workspaceMode === "browse" && parsedDraft?.success && (
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                {parsedDraft.data.keeperGuide || preparationMode === "keeper-reference" || guideBusy ? <KeeperPreparationReader
                  key={parsedDraft.data.moduleId}
                  modulePackage={parsedDraft.data} sourceText={draftSourceText} busy={guideBusy} error={guideError}
                  onGenerate={() => void prepareCurrentModule()}
                  onStop={() => {
                    if (guideTaskRef.current) {
                      guideTaskRef.current.abort();
                      setGuideError("主持引导已停止；已完成的参考仍保留，可稍后继续整理。");
                    } else stopParser();
                  }}
                  onChangeNote={(original, next) => {
                    const currentGuide = parsedDraft.data.keeperGuide;
                    if (!currentGuide) return;
                    const index = guideNotes(currentGuide).indexOf(original);
                    const updated = JSON.parse(JSON.stringify(parsedDraft.data)) as ModulePackageV1;
                    const target = guideNotes(updated.keeperGuide!)[index];
                    if (!target) return;
                    Object.assign(target, next);
                    if (original === currentGuide.preparation?.truth) updated.keeperGuide!.truth = next.text;
                    if (original === currentGuide.preparation?.hook) updated.keeperGuide!.hook = next.text;
                    setDraft(JSON.stringify(updated, null, 2));
                    setDraftDirty(true);
                  }}
                  onApplyOpening={(sceneId, text) => {
                    setDraft(JSON.stringify({ ...parsedDraft.data, scenes: parsedDraft.data.scenes.map((scene) => scene.id === sceneId ? { ...scene, playerDescription: text } : scene) }, null, 2));
                    setDraftDirty(true);
                  }}
                  onApplyClue={(clueId, text) => {
                    setDraft(JSON.stringify({ ...parsedDraft.data, clues: parsedDraft.data.clues.map((clue) => clue.id === clueId ? { ...clue, revealText: text } : clue) }, null, 2));
                    setDraftDirty(true);
                  }}
                /> : <section aria-label="补充主持参考" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 p-4">
                  <p className="text-sm text-zinc-400">跑团资料已就绪。需要真相梳理和逐幕建议时，可直接在这些资料上补充。</p>
                  <Button variant="secondary" disabled={busy || guideBusy || isMockDraft || !localAiAvailable} onClick={() => void prepareCurrentModule()}>补充主持参考</Button>
                </section>}
                <ModuleSourceAssetsPanel
                  modulePackage={parsedDraft.data}
                  sourceFile={sourceFile}
                  onChange={(next) => {
                    setDraft(JSON.stringify(next, null, 2));
                    setDraftDirty(true);
                    setWarnings((current) => moduleSourceWarnings(next, current));
                  }}
                />
                <ModuleEntityBrowser key={`${parsedDraft.data.moduleId}-${parsedDraft.data.revision}`} modulePackage={parsedDraft.data} />
                {sessionV2?.isHost && isActiveRoomModule(parsedDraft.data) && (
                  <RoomEntityPublishingV2
                    modulePackage={parsedDraft.data}
                    publishedEntities={sessionV2.world.entities}
                    onPublish={publishEntityV2}
                  />
                )}
                {canManageRoomModule && (parsedDraft.data.clues.length > 0 || parsedDraft.data.handouts.length > 0) && (
                  isActiveRoomModule(parsedDraft.data) ? (
                    <RoomContentPublishing
                      modulePackage={parsedDraft.data}
                      publishedLocations={publishedLocations}
                      allowLocationAssociation={Boolean(sessionV1)}
                      onReveal={revealContent}
                    />
                  ) : (
                    <div className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3 text-xs text-amber-200">
                      房间当前没有使用你正在查看的这份资料。请先点击上方“用于本次跑团”，再公开线索或手记。
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
                placeholder="高级：在这里查看或编辑模组的底层 JSON 数据。"
                className="min-h-0 flex-1 font-mono text-xs leading-5"
                spellCheck={false}
              />
            )}

            {draft && !parsedDraft?.success && (
              <div className="max-h-28 overflow-auto rounded bg-red-950/40 p-2 text-xs text-red-300">
                底层数据无法保存：{parsedDraft ? parsedDraft.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；") : "不是有效 JSON"}
              </div>
            )}
          </Panel>
        </div>
        {/* Errors can fire from actions anywhere on this long page; keep the
            notice fixed to the viewport so it is visible without scrolling. */}
        {error && (
          <div
            role="alert"
            className="fixed bottom-6 left-1/2 z-50 w-[min(92vw,40rem)] -translate-x-1/2 rounded-md border border-red-900 bg-red-950 p-3 text-sm text-red-300 shadow-[0_18px_50px_rgba(0,0,0,.45)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">这一步没有完成</p>
                <p className="mt-1 break-words text-xs leading-5">{error}</p>
              </div>
              <Button variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={() => setError(undefined)}>知道了</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PreparationSteps({ stage }: { stage: PreparationStage }) {
  const steps: Array<{ id: PreparationStage; label: string }> = [
    { id: "source", label: "放入原文" },
    { id: "parse", label: "AI 整理" },
    { id: "review", label: "检查资料" },
    { id: "saved", label: "保存" },
    { id: "room", label: "用于跑团" },
  ];
  const activeIndex = steps.findIndex((step) => step.id === stage);
  return (
    <ol aria-label="模组准备进度" className="grid grid-cols-2 gap-2 rounded-xl border border-zinc-800 bg-zinc-900/55 p-3 sm:grid-cols-5">
      {steps.map((step, index) => {
        const complete = index < activeIndex || stage === "room";
        const active = index === activeIndex;
        return (
          <li
            key={step.id}
            aria-current={active ? "step" : undefined}
            className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs ${active ? "bg-brass/10 text-brass" : complete ? "text-emerald-300" : "text-zinc-600"}`}
          >
            <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold ${active ? "border-brass" : complete ? "border-emerald-700" : "border-zinc-700"}`}>
              {complete ? <Check className="h-3 w-3" /> : index + 1}
            </span>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

function WorkflowErrorNotice({
  message,
  onRetry,
  onOpenSettings,
  onSwitchProvider,
  switchProviderLabel,
}: {
  message: string;
  onRetry?: () => void;
  onOpenSettings?: () => void;
  onSwitchProvider?: () => void;
  switchProviderLabel?: string;
}) {
  const readable = humanModuleWorkflowError(message);
  return (
    <div role="alert" className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
      <p className="font-medium">这一步没有完成</p>
      <p className="mt-1 text-xs leading-5">{readable}</p>
      {(onRetry || onOpenSettings || onSwitchProvider) && <div className="mt-3 flex flex-wrap gap-2">
        {onRetry && <Button className="h-8 text-xs" variant="secondary" onClick={onRetry}>重试整理</Button>}
        {onSwitchProvider && switchProviderLabel && <Button className="h-8 text-xs" variant="secondary" onClick={onSwitchProvider}>{switchProviderLabel}</Button>}
        {onOpenSettings && <Button className="h-8 text-xs" variant="ghost" onClick={onOpenSettings}>打开 AI 设置</Button>}
      </div>}
      {readable !== message && <details className="mt-2 text-red-300/70"><summary className="cursor-pointer">查看失败原因</summary><p className="mt-1 break-words">{message}</p></details>}
    </div>
  );
}

function humanModuleWorkflowError(message: string): string {
  if (/codex|login|auth|登录|凭据/i.test(message)) return "Codex 还没有准备好。原文和已选 PDF 页都保留着；完成安装或登录后可以直接重试。";
  if (/deepseek|api.?key|key|密钥/i.test(message)) return "DeepSeek 凭据还没有准备好。原文仍保留着；在设置中完成本机凭据配置后可以直接重试。";
  if (/timeout|timed out|network|fetch|connect|连接|网络/i.test(message)) return "AI 服务暂时没有响应。原文和已选页没有丢失；检查网络后可以直接重试。";
  if (/json|schema|empty|truncat|结构|截断|空白|没有返回/i.test(message)) return "AI 返回的草稿不完整，因此没有保存空白模组。原文仍保留着，可以直接重试。";
  return "AI 没能完成这次整理。原文和已选页仍保留在这里，可以重试或先检查 AI 设置。";
}

function RoomContentPublishing({
  modulePackage,
  publishedLocations,
  allowLocationAssociation,
  onReveal,
}: {
  modulePackage: ModulePackageV1;
  publishedLocations: ReadonlyMap<string, PlayerVisibleLocationV1>;
  allowLocationAssociation: boolean;
  onReveal: (
    modulePackage: ModulePackageV1,
    content: {
      id: string;
      title: string;
      body: string;
      type: "clue" | "handout";
      locationId?: string;
    },
  ) => Promise<void>;
}) {
  const [locationId, setLocationId] = useState("");
  const locationList = [...publishedLocations.values()];
  return (
    <section aria-label="房间内容公开" className="mt-4 rounded-xl border border-emerald-900/50 bg-emerald-950/15 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-emerald-200">向房间公开内容</h3>
          <p className="mt-1 text-xs text-zinc-500">这里展示的只有玩家会看到的文字。公开后无法收回，请在点击前再看一眼正文。</p>
        </div>
        <span className="rounded bg-emerald-950 px-2 py-1 text-[10px] text-emerald-300">本次跑团正在使用</span>
      </div>
      {allowLocationAssociation && <Field
        label="关联到地点（可选）"
        hint={locationList.length === 0 ? "先在房间中公开地点，之后才能把内容放入地点舞台。" : "关联后，内容会同时出现在该地点舞台和总事件记录中。"}
      >
        <select
          aria-label="公开内容关联地点"
          className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-ink outline-none focus:border-brass disabled:opacity-40"
          value={locationId}
          disabled={locationList.length === 0}
          onChange={(event) => setLocationId(event.target.value)}
        >
          <option value="">不关联地点</option>
          {locationList.map((location) => (
            <option key={location.id} value={location.id}>{location.name}</option>
          ))}
        </select>
      </Field>}
      <div className="mt-3 grid max-h-52 gap-1 overflow-y-auto">
        {modulePackage.clues.map((clue) => (
          <button
            key={clue.id}
            type="button"
            aria-label={`公开线索：${clue.name}`}
            disabled={!clue.revealText.trim()}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-35"
            title={clue.revealText ? "只公开玩家可见文本" : "此线索尚无玩家可见正文"}
            onClick={() => void onReveal(modulePackage, {
              id: clue.id,
              title: clue.name,
              body: clue.revealText,
              type: "clue",
              ...(allowLocationAssociation && locationId ? { locationId } : {}),
            })}
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
            onClick={() => void onReveal(modulePackage, {
              id: handout.id,
              title: handout.title,
              body: handout.content,
              type: "handout",
              ...(allowLocationAssociation && locationId ? { locationId } : {}),
            })}
          >
            <Eye className="h-3.5 w-3.5 shrink-0 text-brass" />手记：{handout.title}
          </button>
        ))}
      </div>
    </section>
  );
}

function RoomEntityPublishingV2({
  modulePackage,
  publishedEntities,
  onPublish,
}: {
  modulePackage: ModulePackageV1;
  publishedEntities: ReadonlyMap<string, RoomEntityV2>;
  onPublish: (
    modulePackage: ModulePackageV1,
    input: { sourceId: string; kind: "location" | "npc"; name: string; playerDescription?: string },
  ) => Promise<void>;
}) {
  const entries = [
    ...modulePackage.locations.map((location) => ({
      sourceId: location.id,
      kind: "location" as const,
      name: location.name,
      playerDescription: location.playerDescription,
    })),
    ...modulePackage.npcs.map((npc) => ({
      sourceId: npc.id,
      kind: "npc" as const,
      name: npc.name,
      playerDescription: npc.playerDescription,
    })),
  ];
  if (entries.length === 0) return null;
  return (
    <section aria-label="地点和人物公开" className="mt-4 rounded-xl border border-sky-900/50 bg-sky-950/15 p-4">
      <h3 className="text-sm font-semibold text-sky-200">向玩家介绍地点或人物</h3>
      <p className="mt-1 text-xs text-zinc-500">
        点击后只会发送绿色的“玩家可见说明”，不会带上 KP 私密笔记。人物以后仍可以出现在不同场景或地图上。
      </p>
      <div className="mt-3 grid max-h-64 gap-1 overflow-y-auto">
        {entries.map((entry) => {
          const published = Boolean(findPublishedModuleEntityV2(
            publishedEntities,
            modulePackage,
            entry.sourceId,
            entry.kind,
            { kind: "room" },
          ));
          const publishable = Boolean(entry.playerDescription?.trim());
          return (
            <button
              key={`${entry.kind}:${entry.sourceId}`}
              type="button"
              disabled={!publishable}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-35"
              title={publishable ? "把玩家可见说明发到房间" : "请先在“检查并修正”中填写玩家可见说明"}
              onClick={() => void onPublish(modulePackage, entry)}
            >
              <Eye className="h-3.5 w-3.5 shrink-0 text-sky-300" />
              <span className="min-w-0 flex-1 truncate">{entry.kind === "location" ? "地点" : "NPC"}：{entry.name}</span>
              <span className={published ? "text-emerald-300" : "text-zinc-600"}>{published ? "玩家已经看过 · 可再次更新" : "玩家还没看过"}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ModuleLibraryEntityDirectory({ modulePackage }: { modulePackage: ModulePackageV1 }) {
  const groups = [
    {
      label: "地点",
      items: modulePackage.locations.map((location) => ({ id: location.id, name: location.name })),
    },
    {
      label: "人物",
      items: modulePackage.npcs.map((npc) => ({ id: npc.id, name: npc.name })),
    },
  ];

  return (
    <section
      aria-label={`${modulePackage.metadata.title}人物与地点`}
      className="mt-3 grid gap-2 rounded-md border border-zinc-800 bg-zinc-950/45 p-2.5"
    >
      {groups.map(({ label, items }) => (
        <div key={label} className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-2">
          <div className="pt-1 text-[11px] font-medium text-brass">{label} {items.length}</div>
          {items.length === 0 ? (
            <div className="pt-1 text-[11px] text-zinc-600">尚未抽取</div>
          ) : (
            <div className="flex max-h-20 flex-wrap gap-1 overflow-y-auto pr-1">
              {items.map((item) => (
                <span
                  key={item.id}
                  title={item.id}
                  className="rounded bg-zinc-900 px-1.5 py-1 text-[11px] leading-none text-zinc-300"
                >
                  {item.name}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

async function readCompleteManagedAsset(assetId: string, byteLength: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const { bytes: chunk, eof } = await readManagedAssetChunk(
      assetId,
      offset,
      Math.min(64 * 1024, byteLength - offset),
    );
    if (chunk.byteLength === 0) throw new Error(`资源 ${assetId} 在读取完成前返回空分块`);
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
    if (eof && offset !== byteLength) throw new Error(`资源 ${assetId} 长度与模组描述符不一致`);
  }
  return bytes;
}

function safeName(value: string) { return value.replace(/[<>:"/\\|?*]/g, "_"); }

function moduleSourceWarnings(modulePackage: ModulePackageV1, parserWarnings: readonly string[] = []): string[] {
  const retained = parserWarnings.filter((warning) => (
    !/^Archive includes \d+ validated static image attachment\(s\)/iu.test(warning)
    && !/^源压缩包中检测到 \d+ 张安全图片/iu.test(warning)
    && !/^源压缩包的 \d+ 张图片已收入备团素材/iu.test(warning)
    && !/^模组包带有 \d+ 个场景画面或地图/iu.test(warning)
    && !/^模组包引用 \d+ 个图片或音频资源/iu.test(warning)
  ));
  let sourceImages = { items: [] as ReturnType<typeof moduleSourceImages>["items"], importedCount: 0, pendingCount: 0 };
  try {
    sourceImages = moduleSourceImages(modulePackage);
  } catch {
    retained.push("源图片清单格式有误；请在高级数据中修正或删除 org.coc-room.source-attachments.v1 扩展。");
  }
  const warnings = [
    ...retained,
  ];
  if (sourceImages.pendingCount > 0) {
    warnings.push(`源压缩包中检测到 ${sourceImages.items.length} 张安全图片，其中 ${sourceImages.pendingCount} 张尚未进入模组资源库。请先在下方预览，需要时再收入备团素材。`);
  } else if (sourceImages.importedCount > 0) {
    warnings.push(`源压缩包的 ${sourceImages.importedCount} 张图片已收入备团素材，但没有自动绑定或公开；进入房间后仍由 KP 选择、预览并确认。`);
  }
  const packaged = storedCocmodContents(modulePackage);
  if (packaged.boards.length > 0) {
    warnings.push(`模组包带有 ${packaged.boards.length} 个场景画面或地图，已保存在这份备团资料中；启用模组时不会自动复制到房间或公开，再次导出时会原样保留。`);
  }
  if (packaged.assets.length > 0) {
    warnings.push(hasManagedAssetStore()
      ? `模组包引用 ${packaged.assets.length} 个图片或音频资源；启用模组时不会自动绑定或公开。`
      : `模组包引用 ${packaged.assets.length} 个图片或音频资源；网页开发模式只保留描述供检查，不会声称资源已经写入本机或公开。`);
  }
  return warnings;
}

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
