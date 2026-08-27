import { useEffect, useRef, useState } from "react";
import { BookOpen, DoorOpen, MessageSquare, Settings, UserRound, Wifi } from "lucide-react";
import type { ParticipantV1, RoomCommandV1, RoomEventV1 } from "@coc-room/protocol";
import { getRepository, type RoomRecord } from "./data/repository";
import { RoomSession } from "./network/RoomSession";
import type { ConnectionPath } from "./network/RoomTransport";
import { useAppStore, type AppView } from "./store/app-store";
import { LobbyView } from "./views/LobbyView";
import { RoomView } from "./views/RoomView";
import { ModulesView } from "./views/ModulesView";
import { SettingsView } from "./views/SettingsView";
import { CharactersView } from "./views/CharactersView";
import { cn } from "./lib/cn";

const navigation: Array<{ id: AppView; label: string; icon: typeof DoorOpen }> = [
  { id: "lobby", label: "大厅", icon: DoorOpen },
  { id: "room", label: "跑团房间", icon: MessageSquare },
  { id: "characters", label: "角色卡", icon: UserRound },
  { id: "modules", label: "模组库", icon: BookOpen },
  { id: "settings", label: "设置", icon: Settings },
];

export function App() {
  const activeView = useAppStore((state) => state.activeView);
  const setActiveView = useAppStore((state) => state.setActiveView);
  const currentRoom = useAppStore((state) => state.currentRoom);
  const enterRoom = useAppStore((state) => state.enterRoom);
  const leaveRoomState = useAppStore((state) => state.leaveRoom);
  const [session, setSession] = useState<RoomSession>();
  const sessionRef = useRef<RoomSession>();

  useEffect(() => {
    void getRepository().then(async (repository) => {
      const [rooms, modules, relayUrl, model] = await Promise.all([
        repository.listRooms(), repository.listModules(), repository.getSetting("relayUrl"), repository.getSetting("deepseekModel"),
      ]);
      useAppStore.getState().setRooms(rooms);
      useAppStore.getState().setModules(modules.map((item) => item.package));
      if (relayUrl) useAppStore.getState().setRelayUrl(relayUrl);
      if (model) useAppStore.getState().setModel(model);
    }).catch((error) => useAppStore.getState().setConnectionError(String(error)));
    return () => sessionRef.current?.stop();
  }, []);

  const connect = async (room: RoomRecord, nickname: string) => {
    sessionRef.current?.stop();
    sessionRef.current = undefined;
    setSession(undefined);
    useAppStore.getState().setConnectionError(undefined);
    const repository = await getRepository();
    const next = new RoomSession({ room, displayName: nickname, relayUrl: room.relayUrl, repository });
    let active = false;
    let latestEvents: RoomEventV1[] = [];
    let latestParticipants: ParticipantV1[] = [];
    const latestPaths: Record<string, ConnectionPath> = {};
    next.onEvents = (events) => {
      latestEvents = events;
      if (active && sessionRef.current === next) useAppStore.getState().setEvents(events);
    };
    next.onPresence = (participants) => {
      latestParticipants = participants;
      if (active && sessionRef.current === next) useAppStore.getState().setParticipants(participants);
    };
    next.onPathChange = (peerId, path) => {
      latestPaths[peerId] = path;
      if (active && sessionRef.current === next) useAppStore.getState().setPath(peerId, path);
    };
    next.onError = (message) => {
      if (active && sessionRef.current === next) useAppStore.getState().setConnectionError(message);
    };
    try {
      await next.start();
      await repository.saveRoom(room);
      useAppStore.getState().setRooms(await repository.listRooms());
      enterRoom(room);
      sessionRef.current = next;
      active = true;
      useAppStore.getState().setEvents(latestEvents);
      useAppStore.getState().setParticipants(latestParticipants);
      for (const [peerId, path] of Object.entries(latestPaths)) useAppStore.getState().setPath(peerId, path);
      setSession(next);
    } catch (error) {
      next.stop();
      const message = error instanceof Error ? error.message : String(error);
      useAppStore.getState().setConnectionError(message);
      throw error;
    }
  };

  const leave = () => {
    sessionRef.current?.stop();
    sessionRef.current = undefined;
    setSession(undefined);
    leaveRoomState();
  };

  return (
    <div className="flex h-screen overflow-hidden bg-[#101317] text-ink">
      <aside className="flex w-20 shrink-0 flex-col items-center border-r border-zinc-800 bg-zinc-950 py-4">
        <div className="mb-7 grid h-11 w-11 place-items-center rounded-xl border border-brass/40 bg-brass/10 font-serif text-xl text-brass">秘</div>
        <nav className="grid w-full gap-1 px-2">
          {navigation.map(({ id, label, icon: Icon }) => {
            const disabled = (id === "room" || id === "characters") && !currentRoom;
            return <button key={id} title={label} disabled={disabled} onClick={() => setActiveView(id)} className={cn("grid h-12 place-items-center rounded-lg text-zinc-500 transition hover:bg-zinc-800 hover:text-ink disabled:opacity-20", activeView === id && "bg-zinc-800 text-brass")}><Icon className="h-5 w-5" /></button>;
          })}
        </nav>
        <div className="mt-auto flex flex-col items-center gap-2 text-[10px] text-zinc-600"><Wifi className={cn("h-4 w-4", currentRoom && "text-emerald-500")} /><span>v0.1</span></div>
      </aside>
      <main className="min-w-0 flex-1">
        {activeView === "lobby" && <LobbyView onConnect={connect} />}
        {activeView === "room" && <RoomView session={session} onLeave={leave} />}
        {activeView === "characters" && <CharactersView session={session} />}
        {activeView === "modules" && <ModulesView session={session} />}
        {activeView === "settings" && <SettingsView />}
      </main>
    </div>
  );
}

// Retain compile-time correlation with the shared command protocol at the app boundary.
type _SharedCommandContract = RoomCommandV1;
