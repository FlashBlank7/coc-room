import { useEffect, useState } from "react";
import { KeyRound, Save, Trash2 } from "lucide-react";
import { deleteDeepseekKey, hasDeepseekKey, saveDeepseekKey } from "../lib/module-parser";
import { getRepository } from "../data/repository";
import { useAppStore } from "../store/app-store";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";
import { validateRelayOrigin } from "../lib/relay-url";

export function SettingsView() {
  const relayUrl = useAppStore((state) => state.relayUrl);
  const model = useAppStore((state) => state.model);
  const setRelayUrl = useAppStore((state) => state.setRelayUrl);
  const setModel = useAppStore((state) => state.setModel);
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void hasDeepseekKey().then(setHasKey).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const saveAll = async () => {
    try {
      const normalizedRelayUrl = validateRelayOrigin(relayUrl);
      const normalizedModel = model.trim();
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(normalizedModel)) throw new Error("DeepSeek 模型名只能包含字母、数字、点、下划线或连字符");
      const repository = await getRepository();
      await repository.setSetting("relayUrl", normalizedRelayUrl);
      await repository.setSetting("deepseekModel", normalizedModel);
      setRelayUrl(normalizedRelayUrl);
      setModel(normalizedModel);
      if (key.trim()) {
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

  return <div className="h-full overflow-y-auto p-8"><div className="mx-auto max-w-2xl"><header className="mb-6"><p className="text-xs uppercase tracking-[.3em] text-brass">Local settings</p><h1 className="mt-2 font-serif text-3xl">设置</h1></header><Panel className="grid gap-5"><Field label="公网信令/中继节点" hint="填写 Worker 的 HTTPS 根地址（本机开发可用 HTTP）；创建房间后会自动使用其 WSS 地址。"><Input value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)} /></Field><Field label="DeepSeek 模型"><Input value={model} onChange={(event) => setModel(event.target.value)} /></Field><Field label="DeepSeek API Key" hint={hasKey ? "已安全保存到 Windows Credential Manager；留空不会覆盖。" : "不会写入 SQLite、日志或命令行。"}><Input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder={hasKey ? "••••••••••••" : "sk-…"} /></Field><div className="flex gap-2"><Button onClick={() => void saveAll()}><Save className="mr-2 h-4 w-4" />保存设置</Button>{hasKey && <Button variant="danger" onClick={() => void removeKey()}><Trash2 className="mr-2 h-4 w-4" />删除 Key</Button>}</div>{notice && <p className="text-sm text-emerald-400">{notice}</p>}{error && <p className="text-sm text-red-400">{error}</p>}<div className="rounded-lg bg-zinc-950 p-4 text-xs leading-5 text-zinc-500"><KeyRound className="mb-2 h-4 w-4 text-brass" />WebRTC DataChannel 自带 DTLS 加密；当直连失败走公共 WebSocket 中继时，首版没有应用层端到端加密，中继运营者理论上可以读取正文。</div></Panel></div></div>;
}
