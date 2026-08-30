import { useEffect, useState } from "react";
import { Bot, KeyRound, RadioTower, RefreshCw, Save, Trash2 } from "lucide-react";
import { deleteDeepseekKey, getCodexStatus, hasDeepseekKey, saveDeepseekKey } from "../lib/module-parser";
import { clearWebDevelopmentData, getRepository } from "../data/repository";
import { useAppStore, type ModuleParserProvider } from "../store/app-store";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";
import { validateRelayOrigin } from "../lib/relay-url";
import { runNetworkDiagnostic, type NetworkDiagnosticMode } from "../lib/network-diagnostic";
import { clearWebDevelopmentAssetData } from "../lib/asset-store";
import { clearWebDevelopmentSeatCredentialData } from "../lib/seat-credentials";
import { canExecuteLocalAi, getLocalAiRuntime } from "../lib/runtime-capabilities";

interface DiagnosticFeedback {
  kind: "success" | "error";
  summary: string;
  detail: string;
}

interface CodexFeedback {
  kind: "success" | "error";
  summary: string;
  detail?: string;
}

export function SettingsView() {
  const localAiRuntime = getLocalAiRuntime();
  const isWebDevelopment = localAiRuntime !== "native";
  const localAiAvailable = canExecuteLocalAi(localAiRuntime);
  const savedRelayUrl = useAppStore((state) => state.relayUrl);
  const savedParserProvider = useAppStore((state) => state.parserProvider);
  const savedCodexModel = useAppStore((state) => state.codexModel);
  const savedDeepseekModel = useAppStore((state) => state.deepseekModel);
  const setRelayUrl = useAppStore((state) => state.setRelayUrl);
  const commitParserProvider = useAppStore((state) => state.setParserProvider);
  const commitCodexModel = useAppStore((state) => state.setCodexModel);
  const commitDeepseekModel = useAppStore((state) => state.setDeepseekModel);
  const [relayUrl, setRelayUrlDraft] = useState(savedRelayUrl);
  const [parserProvider, setParserProvider] = useState<ModuleParserProvider>(savedParserProvider);
  const [codexModel, setCodexModel] = useState(savedCodexModel);
  const [deepseekModel, setDeepseekModel] = useState(savedDeepseekModel);
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [diagnosticMode, setDiagnosticMode] = useState<NetworkDiagnosticMode>();
  const [diagnosticFeedback, setDiagnosticFeedback] = useState<DiagnosticFeedback>();
  const [codexFeedback, setCodexFeedback] = useState<CodexFeedback>();
  const [checkingCodex, setCheckingCodex] = useState(false);
  useEffect(() => {
    if (!localAiAvailable) {
      setHasKey(false);
      return;
    }
    void hasDeepseekKey().then(setHasKey).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [localAiAvailable]);
  useEffect(() => setParserProvider(savedParserProvider), [savedParserProvider]);
  useEffect(() => setRelayUrlDraft(savedRelayUrl), [savedRelayUrl]);
  useEffect(() => setCodexModel(savedCodexModel), [savedCodexModel]);
  useEffect(() => setDeepseekModel(savedDeepseekModel), [savedDeepseekModel]);

  const saveAll = async () => {
    try {
      const normalizedRelayUrl = validateRelayOrigin(relayUrl);
      const normalizedCodexModel = codexModel.trim();
      const normalizedDeepseekModel = deepseekModel.trim();
      if (normalizedCodexModel && !/^[A-Za-z0-9._-]{1,100}$/.test(normalizedCodexModel)) throw new Error("Codex 模型名只能包含字母、数字、点、下划线或连字符");
      if (parserProvider === "deepseek" && !/^[A-Za-z0-9._-]{1,100}$/.test(normalizedDeepseekModel)) throw new Error("DeepSeek 模型名只能包含字母、数字、点、下划线或连字符");
      const repository = await getRepository();
      await repository.setSetting("relayUrl", normalizedRelayUrl);
      await repository.setSetting("moduleParserProvider", parserProvider);
      await repository.setSetting("codexModel", normalizedCodexModel);
      await repository.setSetting("deepseekModel", normalizedDeepseekModel);
      setRelayUrl(normalizedRelayUrl);
      commitParserProvider(parserProvider);
      commitCodexModel(normalizedCodexModel);
      commitDeepseekModel(normalizedDeepseekModel);
      if (!isWebDevelopment && parserProvider === "deepseek" && key.trim()) {
        await saveDeepseekKey(key.trim());
        setKey("");
        setHasKey(true);
      }
      setError(undefined);
      setNotice("设置已保存");
    } catch (cause) {
      setNotice(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const checkCodex = async () => {
    if (!localAiAvailable) {
      setCodexFeedback({
        kind: "error",
        summary: "这个网页会话没有本地 AI 执行能力。",
        detail: "它仍可用于联机与界面调试。需要在本机整理模组时，请打开带安全桥的 KP 开发页。",
      });
      return;
    }
    setCheckingCodex(true);
    setCodexFeedback(undefined);
    try {
      const status = await getCodexStatus();
      if (!status.installed) {
        setCodexFeedback({
          kind: "error",
          summary: "这台电脑还不能使用 Codex。",
          detail: "请先安装 Codex，或安装并登录 OpenAI 的 VS Code 扩展，然后重新检测。",
        });
      } else if (!status.compatible) {
        setCodexFeedback({
          kind: "error",
          summary: "Codex 需要更新后才能使用。",
          detail: "当前程序没有通过兼容性检查；更新 Codex 后重新检测。",
        });
      } else if (!status.authenticated) {
        setCodexFeedback({
          kind: "error",
          summary: "Codex 已安装，但还没有登录。",
          detail: "请在终端运行 codex login，完成后回到这里重新检测。",
        });
      } else {
        setCodexFeedback({
          kind: "success",
          summary: `文字整理与草稿功能已就绪${status.version ? ` · ${status.version}` : ""}`,
        });
      }
    } catch (cause) {
      setCodexFeedback({
        kind: "error",
        summary: "没有完成 Codex 检测，请稍后重试。",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setCheckingCodex(false);
    }
  };

  const removeKey = async () => {
    try {
      await deleteDeepseekKey();
      setHasKey(false);
      setKey("");
      setError(undefined);
      setNotice("API Key 已从凭据管理器移除");
    } catch (cause) {
      setNotice(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const runDiagnostic = async (mode: NetworkDiagnosticMode) => {
    setDiagnosticMode(mode);
    setNotice(undefined);
    setError(undefined);
    setDiagnosticFeedback(undefined);
    try {
      const result = await runNetworkDiagnostic(validateRelayOrigin(relayUrl), mode);
      setDiagnosticFeedback({
        kind: "success",
        summary: mode === "direct"
          ? "直连可用。跑团时会优先使用这条连接。"
          : "备用连接可用。直连失败时仍可继续联机。",
        detail: `本次完整传输了 ${formatDataSize(result.payloadBytes)}，用时 ${formatDuration(result.durationMs)}。`,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setDiagnosticFeedback({
        kind: "error",
        summary: humanizeDiagnosticFailure(detail, mode),
        detail,
      });
    } finally {
      setDiagnosticMode(undefined);
    }
  };

  const clearBrowserDevelopmentData = async () => {
    if (window.__TAURI_INTERNALS__) return;
    if (!window.confirm("确认清空这个浏览器源中的 CoC Room 开发数据？房间、记录、模组、角色、资源和开发席位凭据都会删除，桌面端 SQLite 不受影响。")) return;
    setNotice(undefined);
    setError(undefined);
    try {
      await clearWebDevelopmentData();
      await clearWebDevelopmentAssetData();
      await clearWebDevelopmentSeatCredentialData();
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto max-w-2xl">
        <header className="mb-6">
          <p className="text-xs uppercase tracking-[.3em] text-brass">偏好与故障排查</p>
          <h1 className="mt-2 font-serif text-3xl">设置</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-400">通常不需要来这里。更换 AI 文字服务或联机遇到问题时再调整。</p>
        </header>
        <Panel className="grid gap-5">
          {!localAiAvailable && (
            <div role="status" aria-label="本地 AI 在当前网页不可用" className="rounded-lg border border-sky-900/70 bg-sky-950/20 p-4 text-sm leading-6 text-sky-100">
              <p className="font-medium">当前页面可以联机和调试界面，但不能直接运行本机 AI。</p>
              <p className="mt-1 text-xs text-sky-100/70">双端联调时这是玩家页的预期安全边界；KP 页或 <code className="select-all text-sky-200">pnpm dev</code> 启动的页面才会连接本地安全桥。玩家在房间里申请角色草稿时，仍可由 KP 代为执行。</p>
            </div>
          )}
          <Field label="AI 文字服务" hint="同一选择用于模组整理、角色草稿和 NPC 文字辅助；只有你主动改成 DeepSeek 时才会调用 DeepSeek。">
            <select
              aria-label="AI 文字服务"
              value={parserProvider}
              onChange={(event) => setParserProvider(event.target.value as ModuleParserProvider)}
              className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-ink outline-none focus:border-brass"
            >
              <option value="codex">使用已登录的 Codex（推荐）</option>
              <option value="deepseek">使用 DeepSeek</option>
            </select>
          </Field>
          {parserProvider === "codex" ? (
            <div className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-zinc-300"><Bot className="h-4 w-4 text-brass" />Codex 是否可以使用</div>
              <p className="text-xs leading-5 text-zinc-500">这项准备状态也会影响角色草稿和 NPC 文字辅助；各入口仍在对应页面，跑团时不用回到设置。检测不会要求你把登录凭据粘贴进应用。</p>
              <div className="flex items-center gap-3">
                <Button variant="secondary" disabled={checkingCodex || !localAiAvailable} onClick={() => void checkCodex()}><RefreshCw className="mr-2 h-4 w-4" />{checkingCodex ? "检测中…" : "检测 Codex"}</Button>
              </div>
              {!localAiAvailable && <p className="text-xs leading-5 text-zinc-500">当前页面未连接本地安全桥，因此不会伪装成“Codex 未安装”或尝试读取登录状态。</p>}
              {codexFeedback && (
                <div
                  role={codexFeedback.kind === "success" ? "status" : "alert"}
                  className={`rounded-md border p-3 text-sm ${codexFeedback.kind === "success"
                    ? "border-emerald-900/70 bg-emerald-950/20 text-emerald-300"
                    : "border-amber-900/70 bg-amber-950/20 text-amber-200"}`}
                >
                  <p>{codexFeedback.summary}</p>
                  {codexFeedback.detail && <p className="mt-1 text-xs leading-5 text-zinc-400">{codexFeedback.detail}</p>}
                </div>
              )}
              <details className="rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-xs text-zinc-500">
                <summary className="cursor-pointer text-zinc-400">高级：指定模型与查看数据流向</summary>
                <div className="mt-3 grid gap-3">
                  <Field label="Codex 模型（可选）" hint="留空使用 Codex 当前默认模型；通常不需要填写。">
                    <Input value={codexModel} onChange={(event) => setCodexModel(event.target.value)} placeholder="使用 Codex 默认模型" />
                  </Field>
                  <p className="leading-5">
                    {localAiRuntime === "web-bridge"
                      ? "网页把固定的解析任务交给当前本地开发进程，再复用 Codex CLI 登录。模组正文会发送到 OpenAI，但网页拿不到登录令牌。"
                      : localAiRuntime === "native"
                        ? "应用只启动本机发现的 Codex CLI，不读取或转发登录令牌。模组正文会发送到 OpenAI。"
                        : "当前页面没有本地 AI 执行通道；这里保存的只是下次在 KP/桌面环境使用的偏好。"}
                  </p>
                </div>
              </details>
            </div>
          ) : (
            <div className="grid gap-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
              <Field label="DeepSeek 模型">
                <Input value={deepseekModel} onChange={(event) => setDeepseekModel(event.target.value)} />
              </Field>
              {isWebDevelopment ? (
                <div className="rounded-md border border-sky-900/70 bg-sky-950/20 p-3 text-xs leading-5 text-sky-100/80">
                  {localAiAvailable
                    ? <>网页不会读取或接收 API Key。本地桥只从 Windows Credential Manager 注入凭据；请在终端运行 <code className="select-all text-sky-200">pnpm ai:key:set</code>，然后刷新本页。
                      <span className={`mt-2 block ${hasKey ? "text-emerald-400" : "text-amber-300"}`}>{hasKey ? "已检测到本机凭据" : "尚未检测到本机凭据"}</span></>
                    : <>当前页面没有本地安全桥，因此不会探测、读取或显示这台电脑的凭据状态。需要使用 DeepSeek 时，请先在终端运行 <code className="select-all text-sky-200">pnpm ai:key:set</code>，再打开 KP 开发页。</>}
                </div>
              ) : (
                <>
                  <Field label="DeepSeek API Key" hint={hasKey ? "已安全保存到 Windows Credential Manager；留空不会覆盖。" : "不会写入 SQLite、日志或命令行。"}>
                    <Input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder={hasKey ? "••••••••••••" : "sk-…"} />
                  </Field>
                  {hasKey && <Button variant="danger" className="w-fit" onClick={() => void removeKey()}><Trash2 className="mr-2 h-4 w-4" />删除 Key</Button>}
                </>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void saveAll()}><Save className="mr-2 h-4 w-4" />保存设置</Button>
          </div>
          <details className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            <summary className="cursor-pointer text-sm font-medium text-zinc-300">房间连接设置（通常不用改）</summary>
            <div className="mt-4">
              <Field label="公网信令/中继节点" hint="只有自建服务器或开发调试时才需要修改。">
                <Input aria-label="公网信令/中继节点" value={relayUrl} onChange={(event) => setRelayUrlDraft(event.target.value)} />
              </Field>
            </div>
          </details>
          <details className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            <summary className="cursor-pointer text-sm font-medium text-zinc-300">联机遇到问题？运行连接检查</summary>
            <div className="mt-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300">
                <RadioTower className="h-4 w-4 text-brass" />检查这台电脑的联机路径
              </div>
              <p className="mb-3 text-xs leading-5 text-zinc-500">会创建一个临时测试房间并发送测试内容，不会写入跑团记录。</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" disabled={diagnosticMode !== undefined} onClick={() => void runDiagnostic("direct")}>
                  {diagnosticMode === "direct" ? "直连检测中…" : "检测直连"}
                </Button>
                <Button variant="secondary" disabled={diagnosticMode !== undefined} onClick={() => void runDiagnostic("relay")}>
                  {diagnosticMode === "relay" ? "备用连接检测中…" : "检测备用连接"}
                </Button>
              </div>
              {diagnosticFeedback && (
                <div
                  role={diagnosticFeedback.kind === "success" ? "status" : "alert"}
                  className={`mt-4 rounded-md border p-3 text-sm ${diagnosticFeedback.kind === "success"
                    ? "border-emerald-900/70 bg-emerald-950/20 text-emerald-300"
                    : "border-red-900/70 bg-red-950/20 text-red-300"}`}
                >
                  <p>{diagnosticFeedback.summary}</p>
                  <details className="mt-2 text-xs text-zinc-400">
                    <summary className="cursor-pointer">查看本次检查详情</summary>
                    <p className="mt-2 whitespace-pre-wrap break-words">{diagnosticFeedback.detail}</p>
                  </details>
                </div>
              )}
            </div>
          </details>
          {!window.__TAURI_INTERNALS__ && (
            <details className="rounded-lg border border-amber-900/70 bg-amber-950/20 p-4">
              <summary className="cursor-pointer text-sm font-medium text-amber-200">开发调试：重置网页数据</summary>
              <p className="mb-3 text-xs leading-5 text-amber-100/60">
                当前网页里的房间、记录、模组、角色和资源都会删除；桌面端数据不受影响。
              </p>
              <Button variant="danger" onClick={() => void clearBrowserDevelopmentData()}>
                <Trash2 className="mr-2 h-4 w-4" />清空网页开发数据
              </Button>
            </details>
          )}
          {notice && <p className="text-sm text-emerald-400">{notice}</p>}
          {error && <p className="text-sm text-red-400">{error}</p>}
          <details className="rounded-lg bg-zinc-950 p-4 text-xs leading-5 text-zinc-500">
            <summary className="cursor-pointer text-zinc-400"><KeyRound className="mr-2 inline h-4 w-4 text-brass" />联机隐私说明</summary>
            <p className="mt-3">直连内容会加密传输；直连失败改用公共备用节点时，节点运营者理论上可以读取经过它转发的正文。当前版本尚未提供应用层端到端加密。</p>
          </details>
        </Panel>
      </div>
    </div>
  );
}

function formatDataSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  return `${(bytes / 1_024).toFixed(bytes < 10 * 1_024 ? 1 : 0)} KB`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return "不到 1 秒";
  return `约 ${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} 秒`;
}

function humanizeDiagnosticFailure(detail: string, mode: NetworkDiagnosticMode): string {
  if (mode === "direct" && /WebRTC|DataChannel|直连|ICE/iu.test(detail)) {
    return "这台电脑目前无法直连。房间仍可使用备用连接，请继续检测备用连接。";
  }
  if (/HTTP|fetch|network|中继节点|会合|Failed to fetch|连接被拒绝/iu.test(detail)) {
    return "没有连上备用节点。请检查网络和上面的节点地址，然后重试。";
  }
  return `${mode === "direct" ? "直连" : "备用连接"}检查没有完成，请稍后重试。`;
}
