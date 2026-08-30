import { useRef, useState } from "react";
import { ArrowLeft, BookOpen, DoorOpen, History, Play, Users } from "lucide-react";
import {
  relayCreateRoomRequestSchema,
  relayCreateRoomResponseSchema,
  type RelayCreateRoomResponseV1,
} from "@coc-room/protocol";
import type { RoomRecord } from "../data/repository";
import { decodeInvitation } from "../lib/invitation";
import { saveLocalSeatSecret } from "../lib/seat-credentials";
import { useAppStore } from "../store/app-store";
import { Button } from "../components/ui/Button";
import { Field, Input, Textarea } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";

interface LobbyViewProps {
  onConnect(room: RoomRecord, nickname: string): Promise<void>;
  onOpenLocalRecord(room: RoomRecord): Promise<void>;
}

interface LobbyError {
  message: string;
  detail?: string;
}

function technicalMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isSupersededConnection(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

function ErrorNotice({ error }: { error?: LobbyError }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-md border border-red-900 bg-red-950/50 p-3 text-sm text-red-200">
      <p className="leading-6">{error.message}</p>
      {error.detail && (
        <details className="mt-2 text-xs text-red-300/70">
          <summary className="cursor-pointer">查看技术信息</summary>
          <p className="mt-1 break-words font-mono">{error.detail}</p>
        </details>
      )}
    </div>
  );
}

export function LobbyView({ onConnect, onOpenLocalRecord }: LobbyViewProps) {
  const relayUrl = useAppStore((state) => state.relayUrl);
  const rooms = useAppStore((state) => state.rooms);
  const currentRoom = useAppStore((state) => state.currentRoom);
  const connectionPhase = useAppStore((state) => state.connectionPhase);
  const pendingRoomModule = useAppStore((state) => state.pendingRoomModule);
  const setPendingRoomModule = useAppStore((state) => state.setPendingRoomModule);
  const setActiveView = useAppStore((state) => state.setActiveView);
  const [intent, setIntent] = useState<"choose" | "host" | "join">(pendingRoomModule && !currentRoom ? "host" : "choose");
  const [nickname, setNickname] = useState(localStorage.getItem("coc-room.nickname") ?? "");
  const [roomName, setRoomName] = useState("周末调查局");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LobbyError>();
  const [joinRecoveryRoom, setJoinRecoveryRoom] = useState<RoomRecord>();
  const nicknameInputRef = useRef<HTMLInputElement>(null);
  const roomNameInputRef = useRef<HTMLInputElement>(null);
  const inviteInputRef = useRef<HTMLTextAreaElement>(null);
  const operationBusy = busy || connectionPhase === "connecting";

  const savedRooms = currentRoom
    ? rooms.filter((room) => room.id !== currentRoom.id)
    : rooms;

  const hasPreviousInvestigation = Boolean(currentRoom || rooms.length > 0);
  const rememberNickname = () => localStorage.setItem("coc-room.nickname", nickname.trim());
  const clearError = () => setError(undefined);

  const confirmLeavingCurrentRoom = (nextAction: string) => {
    if (!currentRoom || connectionPhase !== "live") return true;
    return window.confirm(
      `你仍连接在“${currentRoom.name}”的调查现场。\n\n${nextAction}会离开当前连接；已经同步到本机的记录不会丢失。确定继续吗？`,
    );
  };

  const createRoom = async () => {
    if (!nickname.trim()) {
      setError({ message: "还差一步：请填写大家在团里怎么称呼你。" });
      nicknameInputRef.current?.focus();
      return;
    }
    if (!roomName.trim()) {
      setError({ message: "还差一步：请给这次调查起个名字。" });
      roomNameInputRef.current?.focus();
      return;
    }
    if (!confirmLeavingCurrentRoom("创建并进入新房间")) return;
    setBusy(true);
    setError(undefined);
    const moduleForNewRoom = pendingRoomModule;
    try {
      const now = new Date().toISOString();
      const peerId = crypto.randomUUID();
      const hostSeatId = crypto.randomUUID();
      const created = await createRelayRoom(relayUrl, peerId);
      const room: RoomRecord = {
        id: created.roomId, name: roomName.trim(), localRole: "host", localPeerId: peerId,
        hostPeerId: peerId, inviteToken: created.hostToken, joinToken: created.joinToken,
        relayUrl: created.websocketUrl, lastSeq: 0, createdAt: now, updatedAt: now,
        protocolVersion: 2, localSeatId: hostSeatId, hostSeatId, seatCredentialVersion: 1,
      };
      await onConnect(room, nickname.trim());
      rememberNickname();
      if (moduleForNewRoom) useAppStore.getState().setActiveView("modules");
    } catch (cause) {
      if (isSupersededConnection(cause)) return;
      setError({
        message: "暂时没能创建房间。请检查网络后再试一次；本机已有的调查记录不会受影响。",
        detail: technicalMessage(cause),
      });
    } finally {
      setBusy(false);
    }
  };

  const joinRoom = async () => {
    setJoinRecoveryRoom(undefined);
    if (!nickname.trim()) {
      setError({ message: "还差一步：请填写大家在团里怎么称呼你。" });
      nicknameInputRef.current?.focus();
      return;
    }
    if (!invite.trim()) {
      setError({ message: "请把 KP 发给你的整段邀请粘贴到这里。" });
      inviteInputRef.current?.focus();
      return;
    }
    setError(undefined);
    let parsed: ReturnType<typeof decodeInvitation>;
    try {
      parsed = decodeInvitation(invite);
    } catch (cause) {
      setError({
        message: "没有认出这份邀请。请回到聊天中重新复制 KP 发来的完整内容，再粘贴一次。",
        detail: technicalMessage(cause),
      });
      inviteInputRef.current?.focus();
      return;
    }
    if ("version" in parsed) {
      setError({ message: "这份邀请来自旧版本，已经不能加入。请让 KP 在新房间里重新发一份邀请。" });
      inviteInputRef.current?.focus();
      return;
    }
    const lobbyState = useAppStore.getState();
    const existingRecord = lobbyState.rooms.find((candidate) => candidate.id === parsed.roomId)
      ?? (lobbyState.currentRoom?.id === parsed.roomId ? lobbyState.currentRoom : undefined);
    if (existingRecord?.localRole === "host") {
      // Connecting with a player invitation would persist a player record over
      // this machine's host record (host token, seat and identity), leaving
      // the room permanently unhostable. Refuse before anything is written.
      setError({
        message: `这份玩家邀请属于你在本机主持的“${existingRecord.name}”，因此没有覆盖 KP 记录。邀请请发给玩家使用；你可以从开始页的房间卡片继续以 KP 身份进入。`,
      });
      inviteInputRef.current?.focus();
      return;
    }
    if (!confirmLeavingCurrentRoom("加入另一个房间")) return;
    setBusy(true);
    try {
      await saveLocalSeatSecret(parsed.roomId, parsed.seatId, parsed.seatSecret);
      const now = new Date().toISOString();
      // Rejoining a room with a fresh invite must extend the existing local
      // record instead of resetting it: keep the local peer identity, lastSeq
      // (so event catch-up continues from what is already on this machine)
      // and createdAt, while adopting the invite's newer seat credentials.
      const room: RoomRecord = {
        id: parsed.roomId,
        name: parsed.roomName ?? existingRecord?.name ?? `未命名调查 · ${parsed.roomId.slice(0, 8)}`,
        localRole: "player",
        localPeerId: existingRecord?.localPeerId ?? crypto.randomUUID(),
        hostPeerId: parsed.hostPeerId, inviteToken: parsed.relayToken,
        relayUrl: parsed.relayUrl,
        lastSeq: existingRecord?.lastSeq ?? 0,
        createdAt: existingRecord?.createdAt ?? now, updatedAt: now,
        protocolVersion: 2, localSeatId: parsed.seatId, hostSeatId: parsed.hostSeatId,
        seatCredentialVersion: parsed.credentialVersion,
      };
      await onConnect(room, nickname.trim());
      rememberNickname();
    } catch (cause) {
      if (isSupersededConnection(cause)) return;
      const savedRoom = useAppStore.getState().rooms.find((candidate) => candidate.id === parsed.roomId);
      setJoinRecoveryRoom(savedRoom);
      setError({
        message: "还没能进入房间。请确认 KP 仍在线，然后再试一次；也可以请 KP 重新发一份邀请。",
        detail: technicalMessage(cause),
      });
    } finally {
      setBusy(false);
    }
  };

  const reconnectRoom = async (room: RoomRecord) => {
    if (!confirmLeavingCurrentRoom(`进入“${room.name}”`)) return;
    setPendingRoomModule(undefined);
    const displayName = nickname.trim() || (room.localRole === "host" ? "KP" : "调查员");
    setBusy(true);
    setError(undefined);
    try {
      await onConnect(room, displayName);
      localStorage.setItem("coc-room.nickname", displayName);
    } catch (cause) {
      if (isSupersededConnection(cause)) return;
      setError({
        message: `还没能回到“${room.name}”。请确认 KP 在线后再试；你也可以先查看本机记录。`,
        detail: technicalMessage(cause),
      });
    } finally {
      setBusy(false);
    }
  };

  const openLocalRecord = async (room: RoomRecord) => {
    if (!confirmLeavingCurrentRoom(`打开“${room.name}”的本地记录`)) return;
    setPendingRoomModule(undefined);
    setBusy(true);
    setError(undefined);
    try {
      await onOpenLocalRecord(room);
    } catch (cause) {
      setError({
        message: `暂时打不开“${room.name}”的本机记录。请稍后再试。`,
        detail: technicalMessage(cause),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-5xl gap-8 px-5 py-8 sm:px-8 lg:py-12">
        <header className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[.26em] text-brass">CoC Room</p>
          <h1 className="mt-3 font-serif text-4xl text-ink sm:text-5xl">{hasPreviousInvestigation ? "今晚，继续调查。" : "今晚，开始一次调查。"}</h1>
          <p className="mt-3 text-base leading-7 text-zinc-400">{hasPreviousInvestigation
            ? "从上次的现场继续，或选择今天要主持还是加入朋友。房间连接和本机记录会自动处理。"
            : "你可以直接主持一个新团，或凭朋友发来的邀请加入。模组和地图都可以稍后准备。"}</p>
        </header>

        {connectionPhase === "connecting" && (
          <section role="status" aria-live="polite" className="rounded-xl border border-sky-900/70 bg-sky-950/25 p-4 text-sm text-sky-100">
            正在建立房间连接。完成前不会把旧房间显示成仍然在线，其他入房操作也已暂时锁定。
          </section>
        )}

        {currentRoom && connectionPhase !== "connecting" && (
          <section aria-labelledby="active-investigation" className="rounded-2xl border border-brass/40 bg-gradient-to-br from-brass/10 via-zinc-950 to-zinc-950 p-5 shadow-[0_18px_50px_rgba(0,0,0,.2)] sm:flex sm:items-center sm:justify-between sm:gap-6 sm:p-6">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[.2em] text-brass">{connectionPhase === "live" ? "正在进行" : "本机记录"}</p>
              <div className="mt-2 flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${currentRoom.localRole === "host" ? "bg-brass/15 text-brass" : "bg-sky-950 text-sky-300"}`}>{currentRoom.localRole === "host" ? "KP" : "调查员"}</span>
                <h2 id="active-investigation" className="truncate font-serif text-2xl text-ink">{currentRoom.name}</h2>
              </div>
              <p className="mt-2 text-sm leading-6 text-zinc-400">{connectionPhase === "live"
                ? "你仍在这个房间里。回到现场即可继续查看当前情境、发言和行动。"
                : "你正在查看这份本机记录；它不会显示成在线房间，也不会发送任何行动。"}</p>
            </div>
            <Button className="mt-5 h-11 shrink-0 sm:mt-0" disabled={operationBusy} onClick={() => setActiveView("room")}>
              <Play className="mr-2 h-4 w-4" />{connectionPhase === "live" ? "回到现场" : "回到本机记录"}
            </Button>
          </section>
        )}

        {connectionPhase === "live" && currentRoom?.localRole === "host" && pendingRoomModule && intent === "choose" && (
          <section aria-label="待确认房间模组" className="rounded-xl border border-amber-800/60 bg-amber-950/20 p-4 sm:flex sm:items-center sm:justify-between sm:gap-5">
            <div>
              <p className="text-sm font-semibold text-amber-100">房间已经建好，但模组还没有带入</p>
              <p className="mt-1 text-xs leading-5 text-zinc-400">继续确认“{pendingRoomModule.title}”后，房间才会把它标记为本次跑团使用的模组。</p>
            </div>
            <Button className="mt-3 shrink-0 sm:mt-0" disabled={operationBusy} onClick={() => setActiveView("modules")}><BookOpen className="mr-2 h-4 w-4" />继续确认模组</Button>
          </section>
        )}

        {intent === "choose" && <ErrorNotice error={error} />}

        {savedRooms.length > 0 && intent === "choose" && (
          <section aria-labelledby="recent-investigations" className="grid gap-3">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[.2em] text-zinc-600">最近</p>
                <h2 id="recent-investigations" className="mt-1 font-serif text-2xl">{currentRoom ? "查看其他调查" : "继续上次调查"}</h2>
              </div>
              <span className="text-xs text-zinc-600">记录只保存在本机</span>
            </div>
            <div className="grid gap-2">
              {savedRooms.map((room) => (
                <article key={`${room.id}-${room.localPeerId}`} className="flex flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-950/65 p-4 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${room.localRole === "host" ? "bg-brass/15 text-brass" : "bg-sky-950 text-sky-300"}`}>{room.localRole === "host" ? "KP" : "调查员"}</span>
                      <h3 className="truncate font-medium text-ink">{room.name}</h3>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-zinc-500">{(room.protocolVersion ?? 1) === 1
                      ? "旧版调查；仍可查看并导出已经保存在本机的记录"
                      : "上次的记录已经保存在本机，离线时也能查看"}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant={(room.protocolVersion ?? 1) === 1 ? "primary" : "ghost"} disabled={operationBusy} onClick={() => void openLocalRecord(room)}><History className="mr-2 h-4 w-4" />{(room.protocolVersion ?? 1) === 1 ? "查看并导出记录" : "只看记录"}</Button>
                    {(room.protocolVersion ?? 1) === 2 && <Button disabled={operationBusy} onClick={() => void reconnectRoom(room)}><Play className="mr-2 h-4 w-4" />继续调查</Button>}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {intent === "choose" && <section aria-labelledby="new-investigation" className="grid gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.2em] text-zinc-600">新的开始</p>
            <h2 id="new-investigation" className="mt-1 font-serif text-2xl">你要主持，还是加入朋友的房间？</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <button type="button" disabled={operationBusy} onClick={() => { setIntent("host"); setError(undefined); }} className="group rounded-2xl border border-zinc-800 bg-panel p-6 text-left transition hover:-translate-y-0.5 hover:border-brass/60 hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass disabled:opacity-50">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-brass/10 text-brass"><Users className="h-5 w-5" /></span>
              <span className="mt-5 block font-serif text-2xl text-ink">我是 KP，开一个新团</span>
              <span className="mt-2 block text-sm leading-6 text-zinc-400">创建房间后再邀请玩家。模组、地图和 AI 都不是开团前置条件。</span>
              <span className="mt-5 block text-sm font-semibold text-brass">开始建房 →</span>
            </button>
            <button type="button" disabled={operationBusy} onClick={() => { setPendingRoomModule(undefined); setIntent("join"); setError(undefined); }} className="group rounded-2xl border border-zinc-800 bg-panel p-6 text-left transition hover:-translate-y-0.5 hover:border-sky-700 hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 disabled:opacity-50">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-sky-950 text-sky-300"><DoorOpen className="h-5 w-5" /></span>
              <span className="mt-5 block font-serif text-2xl text-ink">我是玩家，加入朋友</span>
              <span className="mt-2 block text-sm leading-6 text-zinc-400">只需要你的称呼，以及 KP 单独发给你的邀请。</span>
              <span className="mt-5 block text-sm font-semibold text-sky-300">粘贴邀请 →</span>
            </button>
          </div>
          <button type="button" disabled={operationBusy} onClick={() => setActiveView("modules")} className="flex items-center gap-3 justify-self-start rounded-lg px-2 py-2 text-sm text-zinc-500 transition hover:bg-zinc-900 hover:text-ink disabled:opacity-50">
            <BookOpen className="h-4 w-4" /><span>还不开团，先为 KP 准备模组</span>
          </button>
        </section>}

        {intent === "host" && <Panel className="mx-auto w-full max-w-2xl p-0">
          <form aria-label="创建调查房间" className="grid gap-5 p-6 sm:p-8" onSubmit={(event) => { event.preventDefault(); void createRoom(); }}>
            <button type="button" disabled={operationBusy} onClick={() => { setIntent("choose"); setJoinRecoveryRoom(undefined); clearError(); }} className="flex items-center gap-2 justify-self-start text-sm text-zinc-500 hover:text-ink disabled:opacity-40"><ArrowLeft className="h-4 w-4" />返回选择</button>
            <div><p className="text-xs font-semibold uppercase tracking-[.2em] text-brass">KP · 第一步</p><h2 className="mt-2 font-serif text-3xl">创建今晚的调查房间</h2><p className="mt-2 text-sm leading-6 text-zinc-400">填好称呼和房间名就能进入。进入后再邀请玩家，不需要先准备模组或地图。</p></div>
            {pendingRoomModule && (
              <section aria-label="新房间待用模组" className="rounded-xl border border-brass/40 bg-brass/5 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[.18em] text-brass">已经选好备团资料</p>
                    <p className="mt-1 truncate font-medium text-ink">{pendingRoomModule.title} · 第 {pendingRoomModule.revision} 版</p>
                    <p className="mt-2 text-xs leading-5 text-zinc-400">先创建房间；连接成功后会回到模组页，请你再点一次确认。确认前，这份模组不会进入房间。</p>
                  </div>
                  <Button type="button" variant="ghost" disabled={operationBusy} onClick={() => setPendingRoomModule(undefined)}>暂不使用</Button>
                </div>
              </section>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="大家怎么称呼你"><Input ref={nicknameInputRef} aria-label="你的称呼" aria-required="true" autoFocus disabled={operationBusy} value={nickname} onChange={(event) => { setNickname(event.target.value); clearError(); }} maxLength={40} placeholder="例如：阿岚 KP" /></Field>
              <Field label="这次调查叫什么"><Input ref={roomNameInputRef} aria-label="房间名" aria-required="true" disabled={operationBusy} value={roomName} onChange={(event) => { setRoomName(event.target.value); clearError(); }} maxLength={120} /></Field>
            </div>
            <ErrorNotice error={error} />
            <Button type="submit" className="h-11 sm:justify-self-start" disabled={operationBusy}>{operationBusy ? "正在创建房间…" : pendingRoomModule ? "创建房间，下一步确认模组" : "创建房间并进入"}</Button>
          </form>
        </Panel>}

        {intent === "join" && <Panel className="mx-auto w-full max-w-2xl p-0">
          <form aria-label="加入调查房间" className="grid gap-5 p-6 sm:p-8" onSubmit={(event) => { event.preventDefault(); void joinRoom(); }}>
            <button type="button" disabled={operationBusy} onClick={() => { setIntent("choose"); setJoinRecoveryRoom(undefined); clearError(); }} className="flex items-center gap-2 justify-self-start text-sm text-zinc-500 hover:text-ink disabled:opacity-40"><ArrowLeft className="h-4 w-4" />返回选择</button>
            <div><p className="text-xs font-semibold uppercase tracking-[.2em] text-sky-300">调查员 · 加入</p><h2 className="mt-2 font-serif text-3xl">带上邀请，进入现场</h2><p className="mt-2 text-sm leading-6 text-zinc-400">把 KP 单独发给你的整段邀请粘贴到下方。邀请只供你使用，请不要转发给其他玩家。</p></div>
            <Field label="大家怎么称呼你"><Input ref={nicknameInputRef} aria-label="你的称呼" aria-required="true" autoFocus disabled={operationBusy} value={nickname} onChange={(event) => { setNickname(event.target.value); clearError(); }} maxLength={40} placeholder="例如：小林" /></Field>
            <Field label="KP 发给你的邀请" hint="完整粘贴即可。如果复制时缺了开头或结尾，这里会提醒你重新复制。">
              <Textarea ref={inviteInputRef} aria-label="KP 发给你的邀请" aria-required="true" disabled={operationBusy} spellCheck={false} value={invite} onChange={(event) => { setInvite(event.target.value); setJoinRecoveryRoom(undefined); clearError(); }} className="min-h-32 font-mono text-xs" placeholder="在这里粘贴整段邀请…" />
            </Field>
            <ErrorNotice error={error} />
            {joinRecoveryRoom && <section role="status" className="rounded-xl border border-sky-900/70 bg-sky-950/25 p-4 text-sm text-sky-100">
              <p className="font-medium">“{joinRecoveryRoom.name}”和你的加入位置已经保存在本机</p>
              <p className="mt-1 text-xs leading-5 text-sky-200/70">不用重新寻找这份邀请。KP 在线后，可以从开始页直接继续调查；已有的本机记录也仍可查看。</p>
              <Button type="button" variant="secondary" className="mt-3 h-9" onClick={() => { setIntent("choose"); setJoinRecoveryRoom(undefined); clearError(); }}>回到开始页</Button>
            </section>}
            <Button type="submit" className="h-11 sm:justify-self-start" disabled={operationBusy}>{operationBusy ? "正在进入房间…" : "加入调查"}</Button>
          </form>
        </Panel>}

        <details className="justify-self-center text-center text-xs text-zinc-600">
          <summary className="cursor-pointer hover:text-zinc-400">遇到连接问题？</summary>
          <p className="mt-2">可以先重试；若仍失败，请在设置中检查网络服务地址。</p>
          <p className="mt-1 break-all font-mono">{relayUrl}</p>
        </details>
      </div>
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
