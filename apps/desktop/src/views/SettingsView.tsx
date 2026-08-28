import { useEffect, useState } from "react";
import { Bot, KeyRound, RadioTower, RefreshCw, Save, Trash2 } from "lucide-react";
import { deleteDeepseekKey, getCodexStatus, hasDeepseekKey, saveDeepseekKey, type CodexStatus } from "../lib/module-parser";
import { getRepository } from "../data/repository";
import { useAppStore, type ModuleParserProvider } from "../store/app-store";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";
import { validateRelayOrigin } from "../lib/relay-url";
import { runNetworkDiagnostic, type NetworkDiagnosticMode } from "../lib/network-diagnostic";

export function SettingsView() {
  const relayUrl = useAppStore((state) => state.relayUrl);
  const savedParserProvider = useAppStore((state) => state.parserProvider);
  const savedCodexModel = useAppStore((state) => state.codexModel);
  const savedDeepseekModel = useAppStore((state) => state.deepseekModel);
  const setRelayUrl = useAppStore((state) => state.setRelayUrl);
  const commitParserProvider = useAppStore((state) => state.setParserProvider);
  const commitCodexModel = useAppStore((state) => state.setCodexModel);
  const commitDeepseekModel = useAppStore((state) => state.setDeepseekModel);
  const [parserProvider, setParserProvider] = useState<ModuleParserProvider>(savedParserProvider);
  const [codexModel, setCodexModel] = useState(savedCodexModel);
  const [deepseekModel, setDeepseekModel] = useState(savedDeepseekModel);
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [diagnosticMode, setDiagnosticMode] = useState<NetworkDiagnosticMode>();
  const [codexStatus, setCodexStatus] = useState<CodexStatus>();
  const [checkingCodex, setCheckingCodex] = useState(false);
  useEffect(() => {
    void hasDeepseekKey().then(setHasKey).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  useEffect(() => setParserProvider(savedParserProvider), [savedParserProvider]);
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
      if (parserProvider === "deepseek" && key.trim()) {
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
    setCheckingCodex(true);
    setNotice(undefined);
    setError(undefined);
    try {
      const status = await getCodexStatus();
      setCodexStatus(status);
      if (!status.installed) setError("未找到 Codex CLI。请先安装 Codex，或安装并登录 OpenAI 的 VS Code 扩展。");
      else if (!status.compatible) setError("找到了名为 Codex 的程序，但未通过 CLI 兼容性检查。请更新 Codex 后重试。");
      else if (!status.authenticated) setError("已找到 Codex CLI，但尚未登录。请在终端运行 codex login。");
      else setNotice(`Codex 已就绪${status.version ? ` · ${status.version}` : ""}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
    try {
      const result = await runNetworkDiagnostic(validateRelayOrigin(relayUrl), mode);
      setNotice(
        `${mode === "direct" ? "WebRTC 直连" : "WebSocket 中继"}自检通过：`
        + `${result.payloadBytes.toLocaleString()} 字节，${result.durationMs} ms`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiagnosticMode(undefined);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto max-w-2xl">
        <header className="mb-6">
          <p className="text-xs uppercase tracking-[.3em] text-brass">Local settings</p>
          <h1 className="mt-2 font-serif text-3xl">设置</h1>
        </header>
        <Panel className="grid gap-5">
          <Field label="公网信令/中继节点" hint="填写 Worker 的 HTTPS 根地址（本机开发可用 HTTP）；创建房间后会自动使用其 WSS 地址。">
            <Input value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)} />
          </Field>
          <Field label="模组解析服务" hint="Codex 是默认选项；DeepSeek 作为手动回退，不会自动切换或产生意外调用。">
            <select
              aria-label="模组解析服务"
              value={parserProvider}
              onChange={(event) => setParserProvider(event.target.value as ModuleParserProvider)}
              className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-ink outline-none focus:border-brass"
            >
              <option value="codex">本机 Codex CLI（复用登录）</option>
              <option value="deepseek">DeepSeek API</option>
            </select>
          </Field>
          {parserProvider === "codex" ? (
            <div className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-zinc-300"><Bot className="h-4 w-4 text-brass" />Codex 本机桥接</div>
              <p className="text-xs leading-5 text-zinc-500">应用只启动本机发现的 Codex CLI，不读取或转发登录令牌。模组正文会发送到 OpenAI；这不是离线模型，也不会开放本地 HTTP 代理。</p>
              <Field label="Codex 模型（可选）" hint="留空使用此 Codex 版本的内置默认模型，并停用持久化抽取缓存；需要反复解析时可填写固定模型名。">
                <Input value={codexModel} onChange={(event) => setCodexModel(event.target.value)} placeholder="使用 Codex 默认模型" />
              </Field>
              <div className="flex items-center gap-3">
                <Button variant="secondary" disabled={checkingCodex} onClick={() => void checkCodex()}><RefreshCw className="mr-2 h-4 w-4" />{checkingCodex ? "检测中…" : "检测 Codex"}</Button>
                {codexStatus?.authenticated && <span className="text-xs text-emerald-400">已安装并登录</span>}
              </div>
            </div>
          ) : (
            <div className="grid gap-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
              <Field label="DeepSeek 模型">
                <Input value={deepseekModel} onChange={(event) => setDeepseekModel(event.target.value)} />
              </Field>
              <Field label="DeepSeek API Key" hint={hasKey ? "已安全保存到 Windows Credential Manager；留空不会覆盖。" : "不会写入 SQLite、日志或命令行。"}>
                <Input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder={hasKey ? "••••••••••••" : "sk-…"} />
              </Field>
              {hasKey && <Button variant="danger" className="w-fit" onClick={() => void removeKey()}><Trash2 className="mr-2 h-4 w-4" />删除 Key</Button>}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void saveAll()}><Save className="mr-2 h-4 w-4" />保存设置</Button>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300">
              <RadioTower className="h-4 w-4 text-brass" />本机网络链路自检
            </div>
            <p className="mb-3 text-xs leading-5 text-zinc-500">创建一次性双端测试房间，发送约 100 KiB 中文与 emoji 内容；不会写入跑团记录。</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={diagnosticMode !== undefined} onClick={() => void runDiagnostic("direct")}>
                {diagnosticMode === "direct" ? "直连检测中…" : "检测 WebRTC 直连"}
              </Button>
              <Button variant="secondary" disabled={diagnosticMode !== undefined} onClick={() => void runDiagnostic("relay")}>
                {diagnosticMode === "relay" ? "中继检测中…" : "强制检测中继"}
              </Button>
            </div>
          </div>
          {notice && <p className="text-sm text-emerald-400">{notice}</p>}
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="rounded-lg bg-zinc-950 p-4 text-xs leading-5 text-zinc-500">
            <KeyRound className="mb-2 h-4 w-4 text-brass" />
            WebRTC DataChannel 自带 DTLS 加密；当直连失败走公共 WebSocket 中继时，首版没有应用层端到端加密，中继运营者理论上可以读取正文。
          </div>
        </Panel>
      </div>
    </div>
  );
}
