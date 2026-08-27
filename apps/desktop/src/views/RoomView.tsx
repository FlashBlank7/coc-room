import { useMemo, useState } from "react";
import { Copy, Download, Send, Dices, LogOut } from "lucide-react";
import { exportEventsToHtml, exportEventsToMarkdown, type RoomEventV1 } from "@coc-room/protocol";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { RoomSession } from "../network/RoomSession";
import { encodeInvitation } from "../lib/invitation";
import { useAppStore } from "../store/app-store";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";

export function RoomView({ session, onLeave }: { session?: RoomSession; onLeave: () => void }) {
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
  const [bonus, setBonus] = useState(0);
  const [penalty, setPenalty] = useState(0);

  const invitation = useMemo(() => {
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
  }, [room]);

  if (!room) return <EmptyRoom />;

  const sendChat = async () => {
    const value = message.trim();
    if (!value || !session) return;
    try {
      await session.submit("chat.send", { message: value, format: "plain" });
      setMessage("");
      setConnectionError(undefined);
    } catch (cause) {
      setConnectionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const roll = async () => {
    if (!session) return;
    try {
      await session.submit("dice.roll", {
        expression: dice, reason: reason.trim(), bonusDice: bonus, penaltyDice: penalty,
        ...(target ? { target: Number(target), requiredDifficulty: "regular" as const } : {}),
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
        download(filename, content, format === "html" ? "text/html" : "text/markdown");
      }
    } catch (cause) {
      setConnectionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_270px]">
      <section className="flex min-h-0 flex-col border-r border-zinc-800">
        <header className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <div><h1 className="font-serif text-xl text-ink">{room.name}</h1><p className="text-xs text-zinc-500">事件 #{events.at(-1)?.sequence ?? 0} · {room.localRole === "host" ? "房主权威源" : "已同步副本"}</p></div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void exportTranscript("md")}><Download className="mr-2 h-4 w-4" />Markdown</Button>
            <Button variant="secondary" onClick={() => void exportTranscript("html")}>HTML</Button>
            <Button variant="ghost" onClick={onLeave}><LogOut className="h-4 w-4" /></Button>
          </div>
        </header>
        {connectionError && <div className="border-b border-amber-900 bg-amber-950/30 px-5 py-2 text-xs text-amber-300">{connectionError}</div>}
        <div className="event-scroll flex-1 overflow-y-auto p-5">
          {events.length === 0 && <div className="grid h-full place-items-center text-sm text-zinc-600">等待第一条调查记录……</div>}
          <div className="mx-auto grid max-w-3xl gap-3">
            {events.map((event) => <EventCard key={event.eventId} event={event} />)}
          </div>
        </div>
        <div className="border-t border-zinc-800 bg-zinc-950/80 p-4">
          <div className="mx-auto flex max-w-3xl gap-2">
            <Input value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) void sendChat(); }} placeholder="说点什么……" className="flex-1" />
            <Button onClick={() => void sendChat()} disabled={!session}><Send className="h-4 w-4" /></Button>
          </div>
        </div>
      </section>

      <aside className="overflow-y-auto p-4">
        {invitation.value && <Panel className="mb-4 p-4"><h2 className="text-sm font-semibold">邀请朋友</h2><p className="my-2 break-all font-mono text-[10px] text-zinc-500">{invitation.value}</p><Button variant="secondary" className="w-full" onClick={() => void navigator.clipboard.writeText(invitation.value!)}><Copy className="mr-2 h-4 w-4" />复制邀请串</Button></Panel>}
        {invitation.error && <Panel className="mb-4 border-amber-900 p-4"><h2 className="text-sm font-semibold text-amber-300">邀请不可用</h2><p className="mt-2 text-xs leading-5 text-amber-200/80">{invitation.error}</p></Panel>}
        <Panel className="mb-4 p-4">
          <h2 className="mb-3 text-sm font-semibold">在线成员</h2>
          <div className="grid gap-2 text-sm">{participants.map((participant) => <div key={participant.peerId} className="flex justify-between"><span>{participant.displayName}{participant.role === "host" ? "（房主）" : ""}</span><span className={paths[participant.peerId] === "direct" ? "text-emerald-400" : "text-amber-400"}>{participant.peerId === room.localPeerId ? "本机" : paths[participant.peerId] === "direct" ? "直连" : paths[participant.peerId] === "relay" ? "中继" : "连接中"}</span></div>)}</div>
        </Panel>
        <Panel className="grid gap-3 p-4">
          <div className="flex items-center gap-2"><Dices className="h-4 w-4 text-brass" /><h2 className="text-sm font-semibold">骰子与检定</h2></div>
          <Field label="骰式"><Input value={dice} onChange={(event) => setDice(event.target.value)} /></Field>
          <Field label="原因"><Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="侦查旧宅" /></Field>
          <Field label="目标值（可选）"><Input type="number" min={1} max={100} value={target} onChange={(event) => setTarget(event.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-2"><Field label="奖励骰"><Input type="number" min={0} max={2} value={bonus} onChange={(event) => { setBonus(Number(event.target.value)); setPenalty(0); }} /></Field><Field label="惩罚骰"><Input type="number" min={0} max={2} value={penalty} onChange={(event) => { setPenalty(Number(event.target.value)); setBonus(0); }} /></Field></div>
          <Button onClick={() => void roll()} disabled={!session}>掷骰并记录</Button>
        </Panel>
      </aside>
    </div>
  );
}

function EventCard({ event }: { event: RoomEventV1 }) {
  let body: React.ReactNode;
  switch (event.type) {
    case "chat.message": body = <p className="whitespace-pre-wrap">{event.payload.message}</p>; break;
    case "system.notice": body = <p className="text-zinc-400">{event.payload.message}</p>; break;
    case "dice.result": body = <div><b className="text-brass">{event.payload.result.total}</b><span className="ml-2 text-zinc-400">{event.payload.reason || event.payload.result.expression}</span>{event.payload.result.kind === "percentile" && event.payload.result.check && <span className="ml-2">· {event.payload.result.check.outcome} {event.payload.result.check.success ? "成功" : "失败"}</span>}</div>; break;
    case "character.updated": body = <p>更新角色卡：<b>{event.payload.character.name}</b></p>; break;
    case "module.switched": body = <p>切换模组：<b>{event.payload.title}</b></p>; break;
    case "content.revealed": body = <div><b>{event.payload.title}</b><p className="mt-2 whitespace-pre-wrap text-zinc-300">{event.payload.body}</p></div>; break;
  }
  return <article className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4"><header className="mb-2 flex gap-2 text-xs text-zinc-500"><span>#{event.sequence}</span><span className="text-zinc-300">{event.sender.displayName}</span><time>{new Date(event.occurredAt).toLocaleTimeString()}</time></header><div className="text-sm leading-6 text-ink">{body}</div></article>;
}

function EmptyRoom() { return <div className="grid h-full place-items-center text-zinc-500">尚未加入房间</div>; }
function safeName(value: string) { return value.replace(/[<>:"/\\|?*]/g, "_"); }
function download(name: string, content: string, type: string) { const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); }
