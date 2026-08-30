import { useEffect, useMemo, useState } from "react";
import { Copy, Download, Send, Dices, LogOut, Search, X } from "lucide-react";
import {
  deriveRoomWorldState,
  exportEventsToHtml,
  exportEventsToMarkdown,
  parseDiceExpression,
  type CheckDifficulty,
  type CheckOutcome,
  type ModulePackageV1,
  type RoomEventV1,
} from "@coc-room/protocol";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { RoomSession } from "../network/RoomSession";
import { encodeInvitation } from "../lib/invitation";
import { isRoomHostAvailable } from "../lib/room-availability";
import { downloadTextInBrowser } from "../lib/browser-download";
import { useAppStore } from "../store/app-store";
import { getRepository } from "../data/repository";
import {
  KeeperSceneControls,
} from "../components/room/KeeperSceneControls";
import {
  RoomWorldStage,
  type PublishedRoomLocation,
  type PublishedRoomNpc,
  type RoomStageCharacter,
} from "../components/room/RoomWorldStage";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";

interface RoomViewProps {
  session?: RoomSession;
  readOnly?: boolean;
  onLeave(): void;
}

type RecordCategory = "all" | "conversation" | "checks" | "discoveries" | "changes";

type ExportState =
  | { readonly status: "idle" }
  | { readonly status: "working"; readonly format: "md" | "html" }
  | { readonly status: "success"; readonly message: string }
  | { readonly status: "error"; readonly format: "md" | "html"; readonly detail: string };

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
  const [recordQuery, setRecordQuery] = useState("");
  const [recordCategory, setRecordCategory] = useState<RecordCategory>("all");
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" });
  const [keeperModule, setKeeperModule] = useState<ModulePackageV1>();
  const [keeperModuleLoading, setKeeperModuleLoading] = useState(false);
  const [keeperModuleError, setKeeperModuleError] = useState<string>();
  const [keeperSelectedLocationId, setKeeperSelectedLocationId] = useState<string>();
  const [pendingWorldAction, setPendingWorldAction] = useState<{
    commandId: string;
    label: string;
  }>();
  const diceInput = useMemo(() => inspectDiceInput(dice), [dice]);
  const world = useMemo(() => deriveRoomWorldState(events), [events]);
  const activeKeeperModule = keeperModule !== undefined
    && world.activeModule !== undefined
    && keeperModule.moduleId === world.activeModule.moduleId
    && keeperModule.revision === world.activeModule.revision
    ? keeperModule
    : undefined;
  const stageCharacters = useMemo(() => new Map(
    [...world.latestCharacters].map(([characterId, character]) => [characterId, {
      id: character.id,
      ownerPeerId: character.ownerPeerId,
      name: character.name,
      occupation: character.occupation,
      derived: {
        hitPoints: character.derived.hitPoints,
        maxHitPoints: character.derived.maxHitPoints,
        sanity: character.derived.sanity,
      },
    }] as const),
  ), [world.latestCharacters]);
  const filteredEvents = useMemo(
    () => filterRecordEvents(events, recordCategory, recordQuery),
    [events, recordCategory, recordQuery],
  );
  const hasRecordFilter = recordCategory !== "all" || recordQuery.trim().length > 0;

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

  useEffect(() => {
    let cancelled = false;
    setKeeperModule(undefined);
    setKeeperModuleError(undefined);

    if (
      readOnly || room?.localRole !== "host" || session?.isHost !== true ||
      world.activeModule === undefined
    ) {
      setKeeperModuleLoading(false);
      return () => { cancelled = true; };
    }

    setKeeperModuleLoading(true);
    const { moduleId, revision } = world.activeModule;
    void (async () => {
      try {
        const repository = await getRepository();
        const stored = await repository.getModule(moduleId, revision);
        if (cancelled) return;
        if (stored === undefined) {
          setKeeperModuleError(`本机找不到《${world.activeModule?.title ?? "本局模组"}》正在使用的版本。请回到模组库重新导入或选择它，再来展示场景。`);
          return;
        }
        setKeeperModule(stored.package);
      } catch (cause) {
        if (!cancelled) {
          setKeeperModuleError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) setKeeperModuleLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [readOnly, room?.localRole, session, world.activeModule?.moduleId, world.activeModule?.revision]);

  useEffect(() => {
    setKeeperSelectedLocationId(undefined);
    setPendingWorldAction(undefined);
  }, [world.activeModule?.moduleId, world.activeModule?.revision]);

  useEffect(() => {
    if (
      pendingWorldAction !== undefined &&
      events.some((event) => event.causedByCommandId === pendingWorldAction.commandId)
    ) {
      setPendingWorldAction(undefined);
    }
  }, [events, pendingWorldAction]);

  useEffect(() => {
    if (pendingWorldAction === undefined) return;
    const timeout = window.setTimeout(() => {
      setPendingWorldAction((current) => current?.commandId === pendingWorldAction.commandId ? undefined : current);
      setConnectionError(`等待 KP 确认“${pendingWorldAction.label}”超时；请检查连接后重试。`);
    }, 15_000);
    return () => window.clearTimeout(timeout);
  }, [pendingWorldAction, setConnectionError]);

  if (!room) return <EmptyRoom />;

  const roomPaused = !readOnly && !isRoomHostAvailable(room, participants, paths[room.hostPeerId]);
  const commandsDisabled = !session || roomPaused;
  const commandsDisabledReason = roomPaused
    ? "KP 暂时离线，本局已暂停"
    : !session
      ? "尚未连上房间"
      : undefined;
  const worldCommandsDisabled = commandsDisabled || pendingWorldAction !== undefined;
  const worldCommandsDisabledReason = pendingWorldAction !== undefined
    ? `正在等待 KP 确认：${pendingWorldAction.label}`
    : commandsDisabledReason;

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
    if (exportState.status === "working") return;
    setExportState({ status: "working", format });
    try {
      const content = format === "md"
        ? exportEventsToMarkdown(events, { roomName: room.name, roomId: room.id })
        : exportEventsToHtml(events, { roomName: room.name, roomId: room.id });
      const filename = `${safeName(room.name)}-${new Date().toISOString().slice(0, 10)}.${format}`;
      if (window.__TAURI_INTERNALS__) {
        const path = await save({ defaultPath: filename, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
        if (!path) {
          setExportState({ status: "idle" });
          return;
        }
        await writeTextFile(path, content);
        setExportState({ status: "success", message: `已保存${exportFormatLabel(format)}。` });
      } else {
        downloadTextInBrowser(filename, content, format === "html" ? "text/html;charset=utf-8" : "text/markdown;charset=utf-8");
        setExportState({ status: "success", message: `${exportFormatLabel(format)}已开始下载。` });
      }
    } catch (cause) {
      setExportState({
        status: "error",
        format,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const enterLocation = async (character: RoomStageCharacter, location: PublishedRoomLocation) => {
    if (worldCommandsDisabled || !session || world.activeModule === undefined) return;
    const commandId = globalThis.crypto.randomUUID();
    setPendingWorldAction({ commandId, label: `${character.name}进入${location.name}` });
    try {
      await session.submit("location.enter", {
        moduleId: world.activeModule.moduleId,
        revision: world.activeModule.revision,
        locationId: location.id,
        locationName: location.name,
        characterId: character.id,
        characterName: character.name,
      }, commandId);
      setConnectionError(undefined);
    } catch (cause) {
      setPendingWorldAction((current) => current?.commandId === commandId ? undefined : current);
      setConnectionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const publishLocation = async (location: PublishedRoomLocation) => {
    if (
      worldCommandsDisabled || !session || !session.isHost || room.localRole !== "host" ||
      world.activeModule === undefined || activeKeeperModule === undefined
    ) return;
    const sourceLocation = activeKeeperModule.locations.find((candidate) => candidate.id === location.id);
    if (
      sourceLocation === undefined ||
      sourceLocation.name !== location.name ||
      (sourceLocation.playerDescription?.trim() ?? "") !== location.description ||
      location.description.length === 0
    ) {
      setConnectionError("这个地点的公开内容已经变化。请重新选择地点，核对后再展示给玩家。");
      return;
    }
    const commandId = globalThis.crypto.randomUUID();
    setPendingWorldAction({ commandId, label: `公开地点 ${location.name}` });
    try {
      await session.submit("location.publish", {
        moduleId: world.activeModule.moduleId,
        revision: world.activeModule.revision,
        location,
      }, commandId);
      setConnectionError(undefined);
    } catch (cause) {
      setPendingWorldAction((current) => current?.commandId === commandId ? undefined : current);
      setConnectionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const publishNpc = async (location: PublishedRoomLocation, npc: PublishedRoomNpc) => {
    if (
      worldCommandsDisabled || !session || !session.isHost || room.localRole !== "host" ||
      world.activeModule === undefined || activeKeeperModule === undefined
    ) return;
    const sourceLocation = activeKeeperModule.locations.find((candidate) => candidate.id === location.id);
    const sourceNpc = activeKeeperModule.npcs.find((candidate) => candidate.id === npc.id);
    const publishedLocation = world.locations.get(location.id);
    if (
      sourceLocation === undefined || sourceLocation.name !== location.name ||
      publishedLocation?.name !== location.name ||
      sourceNpc === undefined || sourceNpc.name !== npc.name ||
      (sourceNpc.playerDescription?.trim() ?? "") !== npc.description ||
      npc.description.length === 0
    ) {
      setConnectionError("这个人物的公开内容已经变化。请重新选择人物，核对后再展示给玩家。");
      return;
    }
    const commandId = globalThis.crypto.randomUUID();
    setPendingWorldAction({ commandId, label: `${npc.name}出现在${location.name}` });
    try {
      await session.submit("npc.publish", {
        moduleId: world.activeModule.moduleId,
        revision: world.activeModule.revision,
        locationId: location.id,
        locationName: location.name,
        npc,
      }, commandId);
      setConnectionError(undefined);
    } catch (cause) {
      setPendingWorldAction((current) => current?.commandId === commandId ? undefined : current);
      setConnectionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_340px]">
      <section className="flex min-h-0 flex-col border-r border-zinc-800">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-5 py-3">
          <div>
            <h1 className="font-serif text-xl text-ink">{room.name}</h1>
            <p className="text-xs text-zinc-500">
              {readOnly
                ? `本地记录（只读） · 共 ${events.length} 条`
                : room.localRole === "host"
                  ? `KP 视角 · 已保存 ${events.length} 条记录`
                  : roomPaused
                    ? `等待 KP 回来 · 已保存 ${events.length} 条记录`
                    : `调查进行中 · 已保存 ${events.length} 条记录`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={exportState.status === "working"}
              onClick={() => void exportTranscript("md")}
            >
              <Download className="mr-2 h-4 w-4" />
              {exportState.status === "working" && exportState.format === "md" ? "正在准备…" : "导出文字记录"}
            </Button>
            <Button
              variant="secondary"
              disabled={exportState.status === "working"}
              onClick={() => void exportTranscript("html")}
            >
              {exportState.status === "working" && exportState.format === "html" ? "正在准备…" : "导出网页记录"}
            </Button>
            <Button variant="ghost" onClick={onLeave} aria-label={readOnly ? "返回大厅" : "离开房间"}><LogOut className="h-4 w-4" />{readOnly && <span className="ml-2">返回大厅</span>}</Button>
          </div>
        </header>
        {roomPaused && (
          <div role="status" className="border-b border-amber-900 bg-amber-950/30 px-5 py-3 text-sm text-amber-200">
            <b>KP 暂时离线，本局已暂停。</b>
            <span className="ml-1">已经收到的记录都安全留在本机，你仍可查看或导出；KP 回来后会自动继续。</span>
          </div>
        )}
        {connectionError && <RoomErrorNotice error={connectionError} onDismiss={() => setConnectionError(undefined)} />}
        {exportState.status === "success" && (
          <div role="status" className="flex items-center justify-between gap-3 border-b border-emerald-900 bg-emerald-950/25 px-5 py-2 text-xs text-emerald-200">
            <span>{exportState.message}</span>
            <button type="button" className="rounded p-1 hover:bg-emerald-900/40" aria-label="关闭导出提示" onClick={() => setExportState({ status: "idle" })}><X className="h-3.5 w-3.5" /></button>
          </div>
        )}
        {exportState.status === "error" && (
          <div role="alert" className="border-b border-red-900 bg-red-950/25 px-5 py-3 text-xs text-red-200">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <b>导出没有完成，记录仍安全保存在本机。</b>
                <p className="mt-1 text-red-200/80">请重试，或改用另一种格式。</p>
              </div>
              <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => void exportTranscript(exportState.format)}>重试导出</Button>
            </div>
            <details className="mt-2 text-red-200/70"><summary className="cursor-pointer">查看失败原因</summary><p className="mt-1 break-words">{exportState.detail}</p></details>
          </div>
        )}
        <RoomWorldStage
          locations={world.locations}
          npcsByLocation={world.npcsByLocation}
          latestCharacters={stageCharacters}
          currentLocationByCharacterId={world.currentLocationByCharacterId}
          locationContent={world.locationContent}
          localPeerId={room.localPeerId}
          selectedLocationId={room.localRole === "host" ? keeperSelectedLocationId : undefined}
          readOnly={readOnly}
          disabled={worldCommandsDisabled}
          disabledReason={worldCommandsDisabledReason}
          onSelectLocation={room.localRole === "host" ? setKeeperSelectedLocationId : undefined}
          onEnterLocation={readOnly ? undefined : (character, location) => void enterLocation(character, location)}
        />
        <section aria-labelledby="room-record-heading" className="event-scroll flex-1 overflow-y-auto p-5">
          <div className="mx-auto max-w-3xl">
            <div className="mb-4 grid gap-3 rounded-xl border border-zinc-800 bg-zinc-950/55 p-3 sm:grid-cols-[minmax(0,1fr)_180px]">
              <div>
                <h2 id="room-record-heading" className="text-sm font-semibold text-zinc-200">调查记录</h2>
                <p className="mt-1 text-xs text-zinc-500">
                  {hasRecordFilter ? `找到 ${filteredEvents.length} 条，共 ${events.length} 条` : `共 ${events.length} 条，按发生顺序排列`}
                </p>
              </div>
              <label className="relative block">
                <span className="sr-only">搜索记录</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" aria-hidden="true" />
                <Input
                  aria-label="搜索记录"
                  className="pl-9"
                  value={recordQuery}
                  onChange={(event) => setRecordQuery(event.target.value)}
                  placeholder="搜索人物、地点或对话"
                />
              </label>
              <label className="grid gap-1 text-xs text-zinc-500 sm:col-span-2">
                <span>只看</span>
                <select
                  aria-label="记录类型"
                  className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-ink outline-none focus:border-brass"
                  value={recordCategory}
                  onChange={(event) => setRecordCategory(event.target.value as RecordCategory)}
                >
                  <option value="all">全部记录</option>
                  <option value="conversation">对话</option>
                  <option value="checks">检定</option>
                  <option value="discoveries">地点、人物与线索</option>
                  <option value="changes">角色与调查变化</option>
                </select>
              </label>
              <p className="text-[11px] leading-5 text-zinc-500 sm:col-span-2">筛选只改变这里显示的内容；导出始终包含这台设备保存的全部记录。</p>
            </div>
            {events.length === 0 ? (
              <div className="grid min-h-44 place-items-center rounded-xl border border-dashed border-zinc-800 px-4 text-center text-sm text-zinc-600">
                {readOnly ? "这台设备里没有保存到任何调查记录。" : "还没有记录。说出第一句话，调查就开始了。"}
              </div>
            ) : filteredEvents.length === 0 ? (
              <div className="grid min-h-44 place-items-center rounded-xl border border-dashed border-zinc-800 px-4 text-center text-sm text-zinc-500">
                <div><p>没有找到符合条件的记录。</p><Button variant="secondary" className="mt-3" onClick={() => { setRecordCategory("all"); setRecordQuery(""); }}>清除筛选</Button></div>
              </div>
            ) : (
              <div aria-label="调查记录列表" className="grid gap-3">
                {filteredEvents.map((event) => <EventCard key={event.eventId} event={event} />)}
              </div>
            )}
          </div>
        </section>
        {readOnly ? (
          <div className="border-t border-zinc-800 bg-zinc-950/80 px-4 py-3 text-center text-xs text-zinc-500">
            这是旧版房间留在这台设备上的记录。只能查看和导出；打开它不会联网，也不会向任何人发送内容。
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
                placeholder={roomPaused ? "等 KP 回来后继续发言……" : "说点什么……"}
                className="flex-1"
              />
              <Button aria-label="发送消息" onClick={() => void sendChat()} disabled={commandsDisabled}><Send className="h-4 w-4" /></Button>
            </div>
          </div>
        )}
      </section>

      <aside className="flex flex-col overflow-y-auto p-4">
        {invitation.value && <Panel className="mb-4 p-4"><h2 className="text-sm font-semibold">邀请朋友</h2><p className="my-2 break-all font-mono text-[10px] text-zinc-500">{invitation.value}</p><Button variant="secondary" className="w-full" onClick={() => void navigator.clipboard.writeText(invitation.value!)}><Copy className="mr-2 h-4 w-4" />复制邀请串</Button></Panel>}
        {invitation.error && <Panel className="mb-4 border-amber-900 p-4"><h2 className="text-sm font-semibold text-amber-300">邀请不可用</h2><p className="mt-2 text-xs leading-5 text-amber-200/80">{invitation.error}</p></Panel>}
        {readOnly ? (
          <Panel className="mb-4 p-4">
            <h2 className="text-sm font-semibold">这份记录保存在本机</h2>
            <p className="mt-2 text-xs leading-5 text-zinc-500">共 {events.length} 条，是这台设备当时实际收到的内容。你可以随时导出备份；没有收到过的内容不会出现在这里。</p>
            <div className="mt-3 grid gap-1 text-[11px] leading-5 text-zinc-500">
              <p><b className="text-zinc-300">文字记录</b>：适合继续编辑或放进笔记软件。</p>
              <p><b className="text-zinc-300">网页记录</b>：双击即可阅读，也适合打印或分享。</p>
            </div>
          </Panel>
        ) : (
          <Panel className="mb-4 p-4">
            <h2 className="mb-3 text-sm font-semibold">在线成员</h2>
            <div className="grid gap-2 text-sm">{participants.map((participant) => {
              const path = paths[participant.peerId];
              const status = participant.peerId === room.localPeerId
                ? "本机"
                : path === "direct"
                  ? "在线"
                  : path === "relay"
                    ? "在线（备用连接）"
                    : path === "offline"
                      ? "离线"
                      : "正在连接";
              return <div key={participant.peerId} className="flex justify-between"><span>{participant.displayName}{participant.role === "host" ? "（KP）" : ""}</span><span className={path === "direct" ? "text-emerald-400" : path === "offline" ? "text-zinc-500" : "text-amber-400"}>{status}</span></div>;
            })}</div>
          </Panel>
        )}
        {!readOnly && room.localRole === "host" && session?.isHost === true && (
          <div className="order-2 mb-4">
            {keeperModuleLoading ? (
              <Panel className="p-4 text-sm text-zinc-500">正在打开本局使用的模组……</Panel>
            ) : activeKeeperModule ? (
              <KeeperSceneControls
                modulePackage={activeKeeperModule}
                publishedLocations={world.locations}
                npcsByLocation={world.npcsByLocation}
                selectedLocationId={keeperSelectedLocationId}
                disabled={worldCommandsDisabled}
                disabledReason={worldCommandsDisabledReason}
                onSelectLocation={setKeeperSelectedLocationId}
                onPublishLocation={(location) => void publishLocation(location)}
                onPublishNpc={(location, npc) => void publishNpc(location, npc)}
              />
            ) : (
              <Panel className="border-amber-900/60 p-4">
                <h2 className="text-sm font-semibold text-amber-200">KP 场景准备</h2>
                <p className="mt-2 text-xs leading-5 text-zinc-500">
                  {keeperModuleError ?? (world.activeModule
                    ? "本局模组暂时无法打开。请回到模组库重新选择或导入后再试。"
                    : "先到模组库选择本局要用的模组，就可以在这里向玩家展示地点和人物。")}
                </p>
              </Panel>
            )}
          </div>
        )}
        {!readOnly && <Panel className="order-1 mb-4 grid gap-3 p-4">
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
              {checkOutcomeLabels[result.check.outcome]} · 目标值 {result.check.target} · 本次要求：{difficultyLabels[result.check.requiredDifficulty]}（{result.check.success ? "通过" : "未通过"}）
            </p>
          )}
        </div>
      );
      break;
    }
    case "character.updated": body = <p>更新角色卡：<b>{event.payload.character.name}</b></p>; break;
    case "module.switched": body = <p>切换模组：<b>{event.payload.title}</b></p>; break;
    case "content.revealed": body = <div><b>{event.payload.title}</b><p className="mt-2 whitespace-pre-wrap text-zinc-300">{event.payload.body}</p></div>; break;
    case "location.published": body = <div><b>公开地点：{event.payload.location.name}</b><p className="mt-2 whitespace-pre-wrap text-zinc-300">{event.payload.location.description}</p></div>; break;
    case "location.entered": body = <p><b>{event.payload.characterName}</b> 进入了 {event.payload.locationName}</p>; break;
    case "npc.published": body = <div><b>{event.payload.npc.name}</b> 出现在 {event.payload.locationName}<p className="mt-2 whitespace-pre-wrap text-zinc-300">{event.payload.npc.description}</p></div>; break;
  }
  return (
    <article className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4">
      <header className="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">{recordTypeLabel(event.type)}</span>
        <span className="text-zinc-300">{event.sender.displayName}</span>
        <time dateTime={event.occurredAt} title={`记录顺序 ${event.sequence}`}>{formatRecordTime(event.occurredAt)}</time>
      </header>
      <div className="text-sm leading-6 text-ink">{body}</div>
    </article>
  );
}

function RoomErrorNotice({ error, onDismiss }: { error: string; onDismiss(): void }) {
  const readableError = /[\u3400-\u9fff]/u.test(error)
    ? error
    : "刚才的操作没有完成。请检查网络连接后重试。";
  return (
    <div role="alert" className="flex items-start justify-between gap-3 border-b border-amber-900 bg-amber-950/30 px-5 py-3 text-xs text-amber-200">
      <div>
        <p>{readableError}</p>
        <p className="mt-1 text-amber-200/70">已经保存的调查记录不会受到影响。</p>
        {readableError !== error && (
          <details className="mt-2"><summary className="cursor-pointer">查看失败原因</summary><p className="mt-1 break-words">{error}</p></details>
        )}
      </div>
      <button type="button" className="shrink-0 rounded p-1 hover:bg-amber-900/40" aria-label="关闭错误提示" onClick={onDismiss}><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}

function filterRecordEvents(
  events: readonly RoomEventV1[],
  category: RecordCategory,
  query: string,
): readonly RoomEventV1[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return events.filter((event) => {
    if (category !== "all" && recordCategoryForEvent(event.type) !== category) return false;
    if (terms.length === 0) return true;
    const searchable = `${event.sender.displayName} ${recordTypeLabel(event.type)} ${JSON.stringify(event.payload)}`.toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

function recordCategoryForEvent(type: RoomEventV1["type"]): Exclude<RecordCategory, "all"> {
  switch (type) {
    case "chat.message": return "conversation";
    case "dice.result": return "checks";
    case "content.revealed":
    case "location.published":
    case "location.entered":
    case "npc.published": return "discoveries";
    case "system.notice":
    case "character.updated":
    case "module.switched": return "changes";
  }
}

function recordTypeLabel(type: RoomEventV1["type"]): string {
  switch (type) {
    case "chat.message": return "对话";
    case "system.notice": return "调查变化";
    case "dice.result": return "检定";
    case "character.updated": return "角色卡";
    case "module.switched": return "模组";
    case "content.revealed": return "线索";
    case "location.published": return "地点";
    case "location.entered": return "移动";
    case "npc.published": return "人物";
  }
}

function formatRecordTime(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function exportFormatLabel(format: "md" | "html"): string {
  return format === "md" ? "文字记录" : "网页记录";
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
