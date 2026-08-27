import { useState } from "react";
import { Users, Copy, DoorOpen } from "lucide-react";
import {
  relayCreateRoomRequestSchema,
  relayCreateRoomResponseSchema,
  type RelayCreateRoomResponseV1,
} from "@coc-room/protocol";
import type { RoomRecord } from "../data/repository";
import { decodeInvitation } from "../lib/invitation";
import { useAppStore } from "../store/app-store";
import { Button } from "../components/ui/Button";
import { Field, Input, Textarea } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";

interface LobbyViewProps {
  onConnect(room: RoomRecord, nickname: string): Promise<void>;
  onOpenLocalRecord(room: RoomRecord): Promise<void>;
}

export function LobbyView({ onConnect, onOpenLocalRecord }: LobbyViewProps) {
  const relayUrl = useAppStore((state) => state.relayUrl);
  const rooms = useAppStore((state) => state.rooms);
  const [nickname, setNickname] = useState(localStorage.getItem("coc-room.nickname") ?? "");
  const [roomName, setRoomName] = useState("周末调查局");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const rememberNickname = () => localStorage.setItem("coc-room.nickname", nickname.trim());

  const createRoom = async () => {
    if (!nickname.trim() || !roomName.trim()) return setError("请填写昵称和房间名");
    setBusy(true);
    setError(undefined);
    try {
      const now = new Date().toISOString();
      const peerId = crypto.randomUUID();
      const created = await createRelayRoom(relayUrl, peerId);
      const room: RoomRecord = {
        id: created.roomId, name: roomName.trim(), localRole: "host", localPeerId: peerId,
        hostPeerId: peerId, inviteToken: created.hostToken, joinToken: created.joinToken,
        relayUrl: created.websocketUrl, lastSeq: 0, createdAt: now, updatedAt: now,
      };
      await onConnect(room, nickname.trim());
      rememberNickname();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const joinRoom = async () => {
    if (!nickname.trim()) return setError("请填写昵称");
    setBusy(true);
    setError(undefined);
    try {
      const parsed = decodeInvitation(invite);
      const now = new Date().toISOString();
      const room: RoomRecord = {
        id: parsed.roomId, name: `房间 ${parsed.roomId.slice(0, 8)}`, localRole: "player",
        localPeerId: crypto.randomUUID(), hostPeerId: parsed.hostPeerId, inviteToken: parsed.token,
        relayUrl: parsed.relayUrl, lastSeq: 0, createdAt: now, updatedAt: now,
      };
      await onConnect(room, nickname.trim());
      rememberNickname();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const reconnectRoom = async (room: RoomRecord) => {
    const displayName = nickname.trim() || "调查员";
    setBusy(true);
    setError(undefined);
    try {
      await onConnect(room, displayName);
      localStorage.setItem("coc-room.nickname", displayName);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const openLocalRecord = async (room: RoomRecord) => {
    setBusy(true);
    setError(undefined);
    try {
      await onOpenLocalRecord(room);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 p-8">
      <header>
        <p className="text-xs uppercase tracking-[.3em] text-brass">Miskatonic relay terminal</p>
        <h1 className="mt-2 font-serif text-4xl text-ink">开始一次调查</h1>
        <p className="mt-2 max-w-2xl text-zinc-400">房主保存权威事件日志，朋友经 WebRTC 直连；连接受阻时自动通过文字中继继续。</p>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel className="grid content-start gap-4">
          <div className="flex items-center gap-3"><Users className="text-brass" /><h2 className="text-xl font-semibold">创建房间</h2></div>
          <Field label="你的昵称"><Input value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={40} /></Field>
          <Field label="房间名"><Input value={roomName} onChange={(event) => setRoomName(event.target.value)} maxLength={120} /></Field>
          <Button onClick={() => void createRoom()} disabled={busy}>创建并连接</Button>
        </Panel>

        <Panel className="grid content-start gap-4">
          <div className="flex items-center gap-3"><DoorOpen className="text-brass" /><h2 className="text-xl font-semibold">加入朋友的房间</h2></div>
          <Field label="你的昵称"><Input value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={40} /></Field>
          <Field label="邀请串" hint="完整粘贴房主复制的 coc-room:v1:…">
            <Textarea value={invite} onChange={(event) => setInvite(event.target.value)} className="font-mono text-xs" />
          </Field>
          <Button onClick={() => void joinRoom()} disabled={busy || !invite.trim()}><Copy className="mr-2 h-4 w-4" />解析邀请并加入</Button>
        </Panel>
      </div>

      {error && <div className="rounded-md border border-red-900 bg-red-950/50 p-3 text-sm text-red-300">{error}</div>}

      {rooms.length > 0 && (
        <Panel>
          <h2 className="mb-3 font-semibold">本机房间记录</h2>
          <div className="grid gap-2">
            {rooms.map((room) => (
              <div key={`${room.id}-${room.localPeerId}`} className="flex items-center justify-between rounded-md bg-zinc-900 px-4 py-3">
                <div><div className="font-medium">{room.name}</div><div className="text-xs text-zinc-500">{room.localRole === "host" ? "房主" : "玩家"} · #{room.lastSeq}</div></div>
                <div className="flex gap-2">
                  <Button variant="ghost" disabled={busy} onClick={() => void openLocalRecord(room)}>查看本地记录</Button>
                  <Button variant="secondary" disabled={busy} onClick={() => void reconnectRoom(room)}>重新连接</Button>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <p className="text-center text-xs text-zinc-600">当前中继：{relayUrl}</p>
    </div>
  );
}

async function createRelayRoom(baseUrl: string, hostPeerId: string): Promise<RelayCreateRoomResponseV1> {
  const request = relayCreateRoomRequestSchema.parse({ hostPeerId });
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`中继节点创建房间失败（HTTP ${response.status}）`);
  const value = relayCreateRoomResponseSchema.parse(await response.json());
  if (value.hostPeerId !== hostPeerId) throw new Error("中继节点未正确预留房主身份");
  return value;
}
