import { useMemo, useState } from "react";
import { Copy, Download, Send, Dices, LogOut } from "lucide-react";
import {
  exportEventsToHtml,
  exportEventsToMarkdown,
  parseDiceExpression,
  type CheckDifficulty,
  type CheckOutcome,
  type RoomEventV1,
} from "@coc-room/protocol";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { RoomSession } from "../network/RoomSession";
import { encodeInvitation } from "../lib/invitation";
import { isRoomHostAvailable } from "../lib/room-availability";
import { downloadTextInBrowser } from "../lib/browser-download";
import { useAppStore } from "../store/app-store";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";

interface RoomViewProps {
  session?: RoomSession;
  readOnly?: boolean;
  onLeave(): void;
}

export function RoomView({ session, readOnly = false, onLeave }: RoomViewProps) {
  const room = useAppStore((state) => state.currentRoom);
  const events = useAppStore((state) => state.events);
  const participants = useAppStore((state) => state.participants);
  const paths = useAppStore((state) => state.paths);
  const connectionError = useAppStore((state) => state.connectionError);
  const setConnectionError = useAppStore((state) => state.setConnectionError);
  const [message, setMessage] = useState("");
  const [dice, setDice] = useState("1d100");
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState("");
  const [difficulty, setDifficulty] = useState<CheckDifficulty>("regular");
  const [bonus, setBonus] = useState(0);
  const [penalty, setPenalty] = useState(0);
  const diceInput = useMemo(() => inspectDiceInput(dice), [dice]);

  const invitation = useMemo(() => {
    if (readOnly) return {};
    if (room?.localRole !== "host") return {};
    if (!room.joinToken) return { error: "本机没有该房间的玩家入房令牌，为避免泄露房主令牌，无法生成邀请串。" };
    try {
      return { value: encodeInvitation({
        version: 1,
        roomId: room.id,
        token: room.joinToken,
        hostPeerId: room.hostPeerId,
        relayUrl: room.relayUrl,
      }) };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [readOnly, room]);

  if (!room) return <EmptyRoom />;

  const roomPaused = !readOnly && !isRoomHostAvailable(room, participants, paths[room.hostPeerId]);
  const commandsDisabled = !session || roomPaused;

  const sendChat = async () => {
    const value = message.trim();
    if (!value || commandsDisabled || !session) return;
    try {
      await session.submit("chat.send", { message: value, format: "plain" });
      setMessage("");
      setConnectionError(undefined);
    } catch (cause) {
      setConnectionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const roll = async () => {
    if (commandsDisabled || !session) return;
    try {
      if (diceInput.error || !diceInput.parsed) {
        throw new Error(diceInput.error ?? "骰式无效");
      }
      const isPercentile = diceInput.isPercentile;
      const parsedTarget = isPercentile && target ? Number(target) : undefined;
      if (parsedTarget !== undefined && (!Number.isInteger(parsedTarget) || parsedTarget < 1 || parsedTarget > 100)) {
        throw new Error("检定目标值必须是 1 到 100 的整数");
      }
      await session.submit("dice.roll", {
        expression: diceInput.parsed.normalized,
        reason: reason.trim(),
        bonusDice: isPercentile ? bonus : 0,
        penaltyDice: isPercentile ? penalty : 0,
        ...(parsedTarget === undefined ? {} : { target: parsedTarget, requiredDifficulty: difficulty }),
      });
      setConnectionError(undefined);
    } catch (cause) {
      setConnectionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const exportTranscript = async (format: "md" | "html") => {
    try {
      const content = format === "md"
        ? exportEventsToMarkdown(events, { roomName: room.name, roomId: room.id })
        : exportEventsToHtml(events, { roomName: room.name, roomId: room.id });
      const filename = `${safeName(room.name)}-${new Date().toISOString().slice(0, 10)}.${format}`;
      if (window.__TAURI_INTERNALS__) {
        const path = await save({ defaultPath: filename, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
        if (path) await writeTextFile(path, content);
      } else {
        downloadTextInBrowser(filename, content, format === "html" ? "text/html;charset=utf-8" : "text/markdown;charset=utf-8");
      }
    } catch (cause) {
      setConnectionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_270px]">
      <section className="flex min-h-0 flex-col border-r border-zinc-800">
        <header className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <div><h1 className="font-serif text-xl text-ink">{room.name}</h1><p className="text-xs text-zinc-500">事件 #{events.at(-1)?.sequence ?? 0} · {readOnly ? "本地记录（只读）" : room.localRole === "host" ? "房主权威源" : roomPaused ? "房主离线 · 房间已暂停" : "已同步副本"}</p></div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void exportTranscript("md")}><Download className="mr-2 h-4 w-4" />Markdown</Button>
            <Button variant="secondary" onClick={() => void exportTranscript("html")}>HTML</Button>
            <Button variant="ghost" onClick={onLeave} aria-label={readOnly ? "返回大厅" : "离开房间"}><LogOut className="h-4 w-4" />{readOnly && <span className="ml-2">返回大厅</span>}</Button>
          </div>
        </header>
        {roomPaused && (
          <div role="status" className="border-b border-amber-900 bg-amber-950/30 px-5 py-3 text-sm text-amber-200">
            房主已离线，房间暂停。你仍可查看和导出本机记录；房主回来后会自动继续同步。
          </div>
        )}
        {connectionError && <div className="border-b border-amber-900 bg-amber-950/30 px-5 py-2 text-xs text-amber-300">{connectionError}</div>}
        <div className="event-scroll flex-1 overflow-y-auto p-5">
          {events.length === 0 && <div className="grid h-full place-items-center text-sm text-zinc-600">{readOnly ? "本机暂无已同步记录" : "等待第一条调查记录……"}</div>}
          <div className="mx-auto grid max-w-3xl gap-3">
            {events.map((event) => <EventCard key={event.eventId} event={event} />)}
          </div>
        </div>
        {readOnly ? (
          <div className="border-t border-zinc-800 bg-zinc-950/80 px-4 py-3 text-center text-xs text-zinc-500">
            正在查看本机保存的只读副本；不会连接中继，也不会发送任何内容。
          </div>
        ) : (
          <div className="border-t border-zinc-800 bg-zinc-950/80 p-4">
            <div className="mx-auto flex max-w-3xl gap-2">
              <Input
                disabled={commandsDisabled}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void sendChat();
                  }
                }}
                placeholder={roomPaused ? "等待房主回来……" : "说点什么……"}
                className="flex-1"
              />
              <Button aria-label="发送消息" onClick={() => void sendChat()} disabled={commandsDisabled}><Send className="h-4 w-4" /></Button>
            </div>
          </div>
        )}
      </section>

      <aside className="overflow-y-auto p-4">
        {invitation.value && <Panel className="mb-4 p-4"><h2 className="text-sm font-semibold">邀请朋友</h2><p className="my-2 break-all font-mono text-[10px] text-zinc-500">{invitation.value}</p><Button variant="secondary" className="w-full" onClick={() => void navigator.clipboard.writeText(invitation.value!)}><Copy className="mr-2 h-4 w-4" />复制邀请串</Button></Panel>}
        {invitation.error && <Panel className="mb-4 border-amber-900 p-4"><h2 className="text-sm font-semibold text-amber-300">邀请不可用</h2><p className="mt-2 text-xs leading-5 text-amber-200/80">{invitation.error}</p></Panel>}
        {readOnly ? (
          <Panel className="mb-4 p-4">
            <h2 className="text-sm font-semibold">本地副本</h2>
            <p className="mt-2 text-xs leading-5 text-zinc-500">仅包含此前实际同步到这台设备的 {events.length} 条事件。导出不会连接房主或中继节点。</p>
          </Panel>
        ) : (
          <Panel className="mb-4 p-4">
            <h2 className="mb-3 text-sm font-semibold">在线成员</h2>
            <div className="grid gap-2 text-sm">{participants.map((participant) => {
              const path = paths[participant.peerId];
              const status = participant.peerId === room.localPeerId
                ? "本机"
                : path === "direct"
                  ? "直连"
                  : path === "relay"
                    ? "中继"
                    : path === "offline"
                      ? "离线"
                      : "连接中";
              return <div key={participant.peerId} className="flex justify-between"><span>{participant.displayName}{participant.role === "host" ? "（房主）" : ""}</span><span className={path === "direct" ? "text-emerald-400" : path === "offline" ? "text-zinc-500" : "text-amber-400"}>{status}</span></div>;
            })}</div>
          </Panel>
        )}
        {!readOnly && <Panel className="grid gap-3 p-4">
          <div className="flex items-center gap-2"><Dices className="h-4 w-4 text-brass" /><h2 className="text-sm font-semibold">骰子与检定</h2></div>
          <Field label="骰式" hint={diceInput.error ?? "支持 d100、2d6、1d8+2；奖惩骰与成功检定仅适用于 1d100"}>
            <Input
              aria-label="骰式"
              aria-invalid={diceInput.error ? "true" : undefined}
              disabled={commandsDisabled}
              value={dice}
              onChange={(event) => setDice(event.target.value)}
            />
          </Field>
          <Field label="原因"><Input disabled={commandsDisabled} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="侦查旧宅" /></Field>
          <Field label="目标值（可选）" hint={diceInput.isPercentile ? undefined : "仅 1d100 可进行成功检定"}>
            <Input
              aria-label="目标值（可选）"
              disabled={commandsDisabled || !diceInput.isPercentile}
              type="number"
              min={1}
              max={100}
              value={target}
              onChange={(event) => setTarget(clampOptionalInteger(event.target.value, 1, 100))}
            />
          </Field>
          <Field label="成功难度" hint={!diceInput.isPercentile ? "仅 1d100 可用" : target ? undefined : "填写目标值后可选"}>
            <select
              aria-label="成功难度"
              className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-ink outline-none focus:border-brass disabled:opacity-40"
              disabled={commandsDisabled || !diceInput.isPercentile || !target}
              value={difficulty}
              onChange={(event) => setDifficulty(event.target.value as CheckDifficulty)}
            >
              <option value="regular">普通</option>
              <option value="hard">困难</option>
              <option value="extreme">极难</option>
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="奖励骰">
              <Input
                disabled={commandsDisabled || !diceInput.isPercentile}
                type="number"
                min={0}
                max={2}
                value={bonus}
                onChange={(event) => {
                  setBonus(clampInteger(Number(event.target.value), 0, 2));
                  setPenalty(0);
                }}
              />
            </Field>
            <Field label="惩罚骰">
              <Input
                disabled={commandsDisabled || !diceInput.isPercentile}
                type="number"
                min={0}
                max={2}
                value={penalty}
                onChange={(event) => {
                  setPenalty(clampInteger(Number(event.target.value), 0, 2));
                  setBonus(0);
                }}
              />
            </Field>
          </div>
          <Button onClick={() => void roll()} disabled={commandsDisabled}>掷骰并记录</Button>
        </Panel>}
      </aside>
    </div>
  );
}

function EventCard({ event }: { event: RoomEventV1 }) {
  let body: React.ReactNode;
  switch (event.type) {
    case "chat.message": body = <p className="whitespace-pre-wrap">{event.payload.message}</p>; break;
    case "system.notice": body = <p className="text-zinc-400">{event.payload.message}</p>; break;
    case "dice.result": {
      const { result } = event.payload;
      body = (
        <div>
          <div>
            <b className="text-brass">{result.total}</b>
            <span className="ml-2 text-zinc-400">{event.payload.reason || result.expression}</span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {result.kind === "percentile"
              ? percentileRollDetail(result.bonusDice, result.penaltyDice, result.candidates)
              : `骰式 ${result.expression} · 掷出 ${result.rolls.join("、")}${result.modifier === 0 ? "" : ` · 修正 ${signed(result.modifier)}`}`}
          </p>
          {result.kind === "percentile" && result.check && (
            <p className={result.check.success ? "mt-1 text-sm text-emerald-300" : "mt-1 text-sm text-red-300"}>
              {checkOutcomeLabels[result.check.outcome]} · 目标 {result.check.target} · {difficultyLabels[result.check.requiredDifficulty]}难度{result.check.success ? "成功" : "失败"}
            </p>
          )}
        </div>
      );
      break;
    }
    case "character.updated": body = <p>更新角色卡：<b>{event.payload.character.name}</b></p>; break;
    case "module.switched": body = <p>切换模组：<b>{event.payload.title}</b></p>; break;
    case "content.revealed": body = <div><b>{event.payload.title}</b><p className="mt-2 whitespace-pre-wrap text-zinc-300">{event.payload.body}</p></div>; break;
  }
  return <article className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4"><header className="mb-2 flex gap-2 text-xs text-zinc-500"><span>#{event.sequence}</span><span className="text-zinc-300">{event.sender.displayName}</span><time>{new Date(event.occurredAt).toLocaleTimeString()}</time></header><div className="text-sm leading-6 text-ink">{body}</div></article>;
}

function EmptyRoom() { return <div className="grid h-full place-items-center text-zinc-500">尚未加入房间</div>; }
function safeName(value: string) { return value.replace(/[<>:"/\\|?*]/g, "_"); }

const checkOutcomeLabels: Record<CheckOutcome, string> = {
  critical: "大成功",
  extreme: "极难成功",
  hard: "困难成功",
  regular: "普通成功",
  failure: "失败",
  fumble: "大失败",
};

const difficultyLabels: Record<CheckDifficulty, string> = {
  regular: "普通",
  hard: "困难",
  extreme: "极难",
};

function inspectDiceInput(expression: string) {
  try {
    const parsed = parseDiceExpression(expression);
    return {
      parsed,
      isPercentile: parsed.count === 1 && parsed.sides === 100 && parsed.modifier === 0,
    } as const;
  } catch {
    return {
      error: "骰式无效，请使用 d100、2d6 或 1d8+2 这样的格式",
      isPercentile: false,
    } as const;
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  const integer = Number.isFinite(value) ? Math.trunc(value) : minimum;
  return Math.min(maximum, Math.max(minimum, integer));
}

function clampOptionalInteger(value: string, minimum: number, maximum: number): string {
  if (value === "") return "";
  return String(clampInteger(Number(value), minimum, maximum));
}

function percentileRollDetail(bonusDice: number, penaltyDice: number, candidates: readonly number[]): string {
  const mode = bonusDice > 0
    ? `${bonusDice} 个奖励骰`
    : penaltyDice > 0
      ? `${penaltyDice} 个惩罚骰`
      : "1d100";
  return `${mode} · 候选 ${candidates.join("、")}`;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
