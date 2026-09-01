import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { BookOpen, Home, MessageSquare, Settings, UserRound } from "lucide-react";
import {
  createRoomWorldStateV2,
  coc7CharacterSchema,
  deriveRoomWorldStateFromViewsV2,
  type ParticipantV1,
  type AssetDescriptorV1,
  type RoomCommandV1,
  type RoomEventV1,
  type RoomEventViewV2,
  type RoomWorldStateV2,
  type SeatV2,
  type Coc7Character,
} from "@coc-room/protocol";
import { getRepository, type RoomRecord } from "./data/repository";
import type { RoomSession } from "./network/RoomSession";
import type { RoomSessionV2, V2AuthenticationState } from "./network/RoomSessionV2";
import type { ConnectionPath } from "./network/RoomTransport";
import { useAppStore, type AppView } from "./store/app-store";
import { LobbyView } from "./views/LobbyView";
import { cn } from "./lib/cn";
import { isRoomHostAvailable } from "./lib/room-availability";
import { hasManagedAssetStore, managedAssetStoreKind, resolveManagedAssetUrl } from "./lib/asset-store";
import { SynchronizedAudioRuntime, type AudioSyncStatus } from "./lib/audio-sync";
import { ViewErrorBoundary } from "./components/ViewErrorBoundary";
import type { RoomAssetCoordinator } from "./network/RoomAssetCoordinator";
import type { CharacterDraftExecutionRequest, RoomAiJobCoordinator } from "./ai/room-ai-job-coordinator";

// The lobby is the only unconditional first screen. Preparation, character
// management, settings, and both room generations are fetched when the user
// actually opens them, keeping their editors/canvases/package tooling out of
// the startup request without changing the in-app navigation model or HMR.
const RoomView = lazy(async () => ({ default: (await import("./views/RoomView")).RoomView }));
const RoomViewV2 = lazy(async () => ({ default: (await import("./views/RoomViewV2")).RoomViewV2 }));
const ModulesView = lazy(async () => ({ default: (await import("./views/ModulesView")).ModulesView }));
const SettingsView = lazy(async () => ({ default: (await import("./views/SettingsView")).SettingsView }));
const CharactersView = lazy(async () => ({ default: (await import("./views/CharactersView")).CharactersView }));

interface HostCharacterDraftRequest {
  jobId: string;
  requesterSeatId: string;
  requesterName: string;
  playerName: string;
  prompt: string;
}

type AppHydrationState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "failed"; message: string };

interface PendingConnectionAttempt {
  id: number;
  disposed: boolean;
  session?: { stop(): void };
  assetCoordinator?: RoomAssetCoordinator;
  aiCoordinator?: RoomAiJobCoordinator;
}

class SupersededConnectionAttemptError extends Error {
  constructor() {
    super("房间连接已由更新的操作接替");
    this.name = "AbortError";
  }
}

function disposePendingConnectionAttempt(attempt: PendingConnectionAttempt | undefined): void {
  if (!attempt || attempt.disposed) return;
  attempt.disposed = true;
  attempt.aiCoordinator?.shutdown();
  attempt.assetCoordinator?.dispose();
  attempt.session?.stop();
}

const navigation: Array<{ id: AppView; label: string; icon: typeof Home }> = [
  { id: "lobby", label: "开始", icon: Home },
  { id: "room", label: "调查现场", icon: MessageSquare },
  { id: "characters", label: "我的调查员", icon: UserRound },
  { id: "modules", label: "KP 备团", icon: BookOpen },
  { id: "settings", label: "设置", icon: Settings },
];

export function App() {
  const webDevelopmentMode = managedAssetStoreKind() === "web-development";
  const activeView = useAppStore((state) => state.activeView);
  const setActiveView = useAppStore((state) => state.setActiveView);
  const currentRoom = useAppStore((state) => state.currentRoom);
  const connectionPhase = useAppStore((state) => state.connectionPhase);
  const visibleNavigation = navigation
    .filter(({ id }) => id !== "room" || (currentRoom && connectionPhase !== "connecting"))
    .filter(({ id }) => id !== "modules" || !currentRoom || currentRoom.localRole === "host")
    .map((item) => item.id === "lobby" && currentRoom && connectionPhase !== "connecting" ? { ...item, label: "大厅" } : item);
  const participants = useAppStore((state) => state.participants);
  const paths = useAppStore((state) => state.paths);
  const relayConnected = useAppStore((state) => state.relayConnected);
  const connectionError = useAppStore((state) => state.connectionError);
  const setConnectionError = useAppStore((state) => state.setConnectionError);
  const beginConnection = useAppStore((state) => state.beginConnection);
  const enterRoom = useAppStore((state) => state.enterRoom);
  const leaveRoomState = useAppStore((state) => state.leaveRoom);
  const [hydration, setHydration] = useState<AppHydrationState>({ status: "loading" });
  const [hydrationAttempt, setHydrationAttempt] = useState(0);
  const [session, setSession] = useState<RoomSession>();
  const [sessionV2, setSessionV2] = useState<RoomSessionV2>();
  const [viewsV2, setViewsV2] = useState<RoomEventViewV2[]>([]);
  const [worldV2, setWorldV2] = useState<RoomWorldStateV2>(() => createRoomWorldStateV2());
  const [seatsV2, setSeatsV2] = useState<SeatV2[]>([]);
  const [authenticationV2, setAuthenticationV2] = useState<V2AuthenticationState>("waiting");
  const [isViewingLocalRecord, setIsViewingLocalRecord] = useState(false);
  const sessionRef = useRef<RoomSession>();
  const sessionV2Ref = useRef<RoomSessionV2>();
  const assetCoordinatorRef = useRef<RoomAssetCoordinator>();
  const aiCoordinatorRef = useRef<RoomAiJobCoordinator>();
  const connectionAttemptIdRef = useRef(0);
  const pendingConnectionAttemptRef = useRef<PendingConnectionAttempt>();
  const [requestCharacterDraft, setRequestCharacterDraft] = useState<((prompt: string, playerName: string) => Promise<Coc7Character>)>();
  const [hostCharacterRequests, setHostCharacterRequests] = useState<HostCharacterDraftRequest[]>([]);
  const [aiDraftStage, setAiDraftStage] = useState<string>();
  const [lateApprovedDraft, setLateApprovedDraft] = useState<Coc7Character>();
  const [resolveRoomAsset, setResolveRoomAsset] = useState<((asset: AssetDescriptorV1) => Promise<string>)>();
  // Ambience audio survives main-nav switches: the runtime lives with the
  // session here, not with the room view that unmounts on every tab change.
  const [audioStatus, setAudioStatus] = useState<AudioSyncStatus>();
  const [audioVolume, setAudioVolume] = useState(1);
  const [audioMuted, setAudioMuted] = useState(false);
  const audioRuntimeRef = useRef<SynchronizedAudioRuntime>();
  const resolveRoomAssetRef = useRef<typeof resolveRoomAsset>();
  resolveRoomAssetRef.current = resolveRoomAsset;

  useEffect(() => {
    if (!sessionV2) return;
    const runtime = new SynchronizedAudioRuntime({
      resolveAssetUrl: async (asset) => {
        const resolver = resolveRoomAssetRef.current;
        if (resolver) return resolver(asset);
        if (!hasManagedAssetStore()) return null;
        return resolveManagedAssetUrl(asset.assetId);
      },
      localVolume: 1,
      muted: false,
      onStatus: setAudioStatus,
    });
    audioRuntimeRef.current = runtime;
    setAudioVolume(1);
    setAudioMuted(false);
    return () => {
      if (audioRuntimeRef.current === runtime) audioRuntimeRef.current = undefined;
      runtime.dispose();
      setAudioStatus(undefined);
    };
  }, [sessionV2]);

  useEffect(() => {
    audioRuntimeRef.current?.setLocalVolume(audioVolume);
    audioRuntimeRef.current?.setMuted(audioMuted);
  }, [audioMuted, audioVolume, sessionV2]);

  useEffect(() => {
    const runtime = audioRuntimeRef.current;
    if (!runtime) return;
    for (const view of viewsV2) runtime.consumeView(view);
  }, [viewsV2]);
  const isV2PlayerRoom = Boolean(currentRoom && (currentRoom.protocolVersion ?? 1) === 2 && currentRoom.localRole === "player");
  const seatAuthFailedV2 = Boolean(isV2PlayerRoom && !isViewingLocalRecord && authenticationV2 === "failed");
  const hostPathV2 = currentRoom ? paths[currentRoom.hostPeerId] : undefined;
  // The transport only reports "offline" when it tears down an existing link,
  // so a host absent from the moment we joined never gets a path entry. Once
  // the relay is up and presence has arrived, a missing host seat is offline.
  const hostOfflineV2 = Boolean(isV2PlayerRoom && (
    hostPathV2 === "offline"
    || (hostPathV2 === undefined && relayConnected && seatsV2.length > 0 && !seatsV2.some((seat) => seat.role === "host"))
  ));
  const roomPaused = Boolean(currentRoom && !isViewingLocalRecord && (
    (currentRoom.protocolVersion ?? 1) === 2
      ? seatAuthFailedV2 || hostOfflineV2
      : !isRoomHostAvailable(currentRoom, participants, paths[currentRoom.hostPeerId])
  ));

  useEffect(() => {
    let active = true;
    setHydration({ status: "loading" });
    void getRepository().then(async (repository) => {
      const [rooms, modules, relayUrl, parserProvider, codexModel, deepseekModel] = await Promise.all([
        repository.listRooms(),
        repository.listModules(),
        repository.getSetting("relayUrl"),
        repository.getSetting("moduleParserProvider"),
        repository.getSetting("codexModel"),
        repository.getSetting("deepseekModel"),
      ]);
      if (!active) return;
      const state = useAppStore.getState();
      state.setRooms(rooms);
      state.setModules(modules.map((item) => item.package));
      if (relayUrl) state.setRelayUrl(relayUrl);
      if (parserProvider === "codex" || parserProvider === "deepseek") state.setParserProvider(parserProvider);
      if (codexModel !== undefined) state.setCodexModel(codexModel);
      if (deepseekModel) state.setDeepseekModel(deepseekModel);
      setHydration({ status: "ready" });
    }).catch((error) => {
      if (active) setHydration({ status: "failed", message: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      active = false;
    };
  }, [hydrationAttempt]);

  useEffect(() => {
    return () => {
      disposePendingConnectionAttempt(pendingConnectionAttemptRef.current);
      pendingConnectionAttemptRef.current = undefined;
      const liveSession = sessionRef.current;
      const liveSessionV2 = sessionV2Ref.current;
      const liveAiCoordinator = aiCoordinatorRef.current;
      const liveAssetCoordinator = assetCoordinatorRef.current;
      sessionRef.current = undefined;
      sessionV2Ref.current = undefined;
      aiCoordinatorRef.current = undefined;
      assetCoordinatorRef.current = undefined;
      liveAiCoordinator?.shutdown();
      liveAssetCoordinator?.dispose();
      liveSession?.stop();
      liveSessionV2?.stop();
      useAppStore.getState().leaveRoom();
    };
  }, []);

  if (hydration.status !== "ready") {
    return <AppStartupScreen hydration={hydration} onRetry={() => setHydrationAttempt((attempt) => attempt + 1)} />;
  }

  const stopLiveRuntime = () => {
    const liveSession = sessionRef.current;
    const liveSessionV2 = sessionV2Ref.current;
    const liveAiCoordinator = aiCoordinatorRef.current;
    const liveAssetCoordinator = assetCoordinatorRef.current;
    sessionRef.current = undefined;
    sessionV2Ref.current = undefined;
    aiCoordinatorRef.current = undefined;
    assetCoordinatorRef.current = undefined;
    liveAiCoordinator?.shutdown();
    liveAssetCoordinator?.dispose();
    liveSession?.stop();
    liveSessionV2?.stop();
  };

  const clearSessionPresentation = (roomId?: string) => {
    setRequestCharacterDraft(undefined);
    setHostCharacterRequests([]);
    setAiDraftStage(undefined);
    setLateApprovedDraft(undefined);
    setResolveRoomAsset(undefined);
    setSession(undefined);
    setSessionV2(undefined);
    setViewsV2([]);
    setWorldV2(createRoomWorldStateV2(roomId));
    setSeatsV2([]);
  };

  const connect = async (room: RoomRecord, nickname: string) => {
    const attempt: PendingConnectionAttempt = {
      id: connectionAttemptIdRef.current + 1,
      disposed: false,
    };
    connectionAttemptIdRef.current = attempt.id;
    const previousPendingAttempt = pendingConnectionAttemptRef.current;
    pendingConnectionAttemptRef.current = attempt;
    disposePendingConnectionAttempt(previousPendingAttempt);
    stopLiveRuntime();
    clearSessionPresentation(room.id);
    setAuthenticationV2(room.localRole === "host" ? "authenticated" : "waiting");
    beginConnection();

    const assertAttemptOwner = () => {
      if (pendingConnectionAttemptRef.current !== attempt || attempt.disposed) {
        throw new SupersededConnectionAttemptError();
      }
    };

    let repository: Awaited<ReturnType<typeof getRepository>> | undefined;
    try {
      repository = await getRepository();
      assertAttemptOwner();

      if ((room.protocolVersion ?? 1) === 2) {
        const [
          { RoomSessionV2: RoomSessionV2Runtime },
          { RoomAiJobCoordinator: RoomAiJobCoordinatorRuntime },
        ] = await Promise.all([
          import("./network/RoomSessionV2"),
          import("./ai/room-ai-job-coordinator"),
        ]);
        assertAttemptOwner();
        const next = new RoomSessionV2Runtime({ room, displayName: nickname, relayUrl: room.relayUrl, repository });
        attempt.session = next;
        let active = false;
        const settings = useAppStore.getState();
        const aiProvider = settings.parserProvider;
        const aiModel = aiProvider === "codex" ? settings.codexModel : settings.deepseekModel;
        // The provider choice must follow the CURRENT settings, not the ones
        // from the moment the room was joined — a keeper who switches to
        // DeepSeek mid-session expects the next draft to honor it.
        const characterDraftExecutor = next.isHost
          ? await (async () => {
            const inner = new (await import("./ai/tauri-character-draft-executor")).TauriCharacterDraftExecutor();
            return {
              executeCharacterDraft: (request: CharacterDraftExecutionRequest, signal: AbortSignal) => {
                const state = useAppStore.getState();
                const provider = state.parserProvider;
                return inner.executeCharacterDraft({
                  ...request,
                  provider,
                  model: provider === "codex" ? state.codexModel : state.deepseekModel,
                }, signal);
              },
            };
          })()
          : undefined;
        assertAttemptOwner();
        const aiCoordinator = new RoomAiJobCoordinatorRuntime({
          session: next,
          provider: aiProvider,
          model: aiModel,
          ...(characterDraftExecutor ? { executor: characterDraftExecutor } : {}),
          onHostStatus: (seat, status) => {
            if (!active) return;
            const result = status.result && typeof status.result === "object"
              ? status.result as { approvalRequest?: unknown; prompt?: unknown; playerName?: unknown }
              : undefined;
            const prompt = result?.prompt;
            if (result?.approvalRequest !== true || typeof prompt !== "string") return;
            setHostCharacterRequests((current) => [...current.filter(({ jobId }) => jobId !== status.jobId), {
              jobId: status.jobId,
              requesterSeatId: seat.seatId,
              requesterName: seat.displayName,
              playerName: typeof result.playerName === "string" && result.playerName.length > 0
                ? result.playerName
                : seat.displayName,
              prompt,
            }].slice(-200));
          },
          onClientStatus: (status) => {
            if (!active || sessionV2Ref.current !== next) return;
            setAiDraftStage(status.message);
            if (status.status === "completed") {
              try {
                const record = status.result as Record<string, unknown> | undefined;
                setLateApprovedDraft(coc7CharacterSchema.parse(record?.character));
              } catch {
                // Malformed late payloads keep only the stage message.
              }
            }
          },
        });
        attempt.aiCoordinator = aiCoordinator;
        next.onUnhandledWireMessage = (fromSeat, message) => {
          aiCoordinator.handleWireMessage(fromSeat, message);
        };
        next.onSeatAuthenticated = (seatId) => {
          aiCoordinator.flushOutbox(seatId);
        };
        next.onSeatCredentialRotated = (seatId) => {
          aiCoordinator.forgetSeat(seatId);
        };
        let coordinator: RoomAssetCoordinator | undefined;
        let latestViews: RoomEventViewV2[] = [];
        let latestWorld = createRoomWorldStateV2(room.id);
        let latestSeats: SeatV2[] = [];
        let latestAuthentication: V2AuthenticationState = room.localRole === "host" ? "authenticated" : "waiting";
        let latestRelayConnected = false;
        const latestPaths: Record<string, ConnectionPath> = {};
        next.onViews = (views) => {
          latestViews = views;
          if (active && sessionV2Ref.current === next) setViewsV2(views);
        };
        next.onWorld = (world) => {
          latestWorld = world;
          if (active && sessionV2Ref.current === next) {
            setWorldV2(world);
            const state = useAppStore.getState();
            state.setRooms(state.rooms.map((savedRoom) => savedRoom.id === room.id
              ? { ...savedRoom, lastSeq: world.lastSequence }
              : savedRoom));
          }
        };
        next.onPresence = (seats) => {
          latestSeats = seats;
          if (active && sessionV2Ref.current === next) setSeatsV2(seats);
        };
        next.onAuthenticationState = (state) => {
          latestAuthentication = state;
          // A re-authenticated player replays unfinished draft requests so the
          // host can re-send any status lost while the connection blinked.
          if (state === "authenticated") aiCoordinator.resendPendingRequests();
          if (active && sessionV2Ref.current === next) setAuthenticationV2(state);
        };
        next.onPathChange = (peerId, path) => {
          latestPaths[peerId] = path;
          if (active && sessionV2Ref.current === next) useAppStore.getState().setPath(peerId, path);
        };
        next.onRelayStateChange = (connected) => {
          latestRelayConnected = connected;
          if (active && sessionV2Ref.current === next) {
            const state = useAppStore.getState();
            state.setRelayConnected(connected);
            if (connected) state.setConnectionError(undefined);
          }
        };
        next.onCommandRejected = (_commandId, message) => {
          if (active && sessionV2Ref.current === next) useAppStore.getState().setConnectionError(message);
        };
        next.onError = (message) => {
          if (active && sessionV2Ref.current === next) useAppStore.getState().setConnectionError(message);
        };

        await next.start();
        assertAttemptOwner();
        if (hasManagedAssetStore()) {
          const { RoomAssetCoordinator: RoomAssetCoordinatorRuntime } = await import("./network/RoomAssetCoordinator");
          assertAttemptOwner();
          coordinator = new RoomAssetCoordinatorRuntime(next, (event) => {
            if (active && sessionV2Ref.current === next && event.kind === "error") {
              useAppStore.getState().setConnectionError(event.message);
            }
          });
          attempt.assetCoordinator = coordinator;
        }
        const refreshedRooms = await repository.listRooms();
        assertAttemptOwner();

        pendingConnectionAttemptRef.current = undefined;
        attempt.disposed = true;
        attempt.session = undefined;
        attempt.aiCoordinator = undefined;
        attempt.assetCoordinator = undefined;
        sessionV2Ref.current = next;
        aiCoordinatorRef.current = aiCoordinator;
        assetCoordinatorRef.current = coordinator;
        active = true;
        setRequestCharacterDraft(() => (prompt: string, playerName: string) => {
          setAiDraftStage(undefined);
          return aiCoordinator.requestCharacterDraft(prompt, playerName)
            .finally(() => setAiDraftStage(undefined));
        });
        if (coordinator) setResolveRoomAsset(() => (asset: AssetDescriptorV1) => coordinator.resolve(asset));
        setViewsV2(latestViews);
        setWorldV2(latestWorld);
        setSeatsV2(latestSeats);
        setAuthenticationV2(latestAuthentication);
        setIsViewingLocalRecord(false);
        setSessionV2(next);
        useAppStore.getState().setRooms(refreshedRooms);
        enterRoom(room);
        useAppStore.getState().setRelayConnected(latestRelayConnected);
        for (const [peerId, path] of Object.entries(latestPaths)) useAppStore.getState().setPath(peerId, path);
        return;
      }

      const { RoomSession: RoomSessionRuntime } = await import("./network/RoomSession");
      assertAttemptOwner();
      const next = new RoomSessionRuntime({ room, displayName: nickname, relayUrl: room.relayUrl, repository });
      attempt.session = next;
      let active = false;
      let latestEvents: RoomEventV1[] = [];
      let latestParticipants: ParticipantV1[] = [];
      let latestRelayConnected = false;
      const latestPaths: Record<string, ConnectionPath> = {};
      next.onEvents = (events) => {
        latestEvents = events;
        if (active && sessionRef.current === next) {
          const state = useAppStore.getState();
          state.setEvents(events);
          const lastSeq = events.at(-1)?.sequence ?? 0;
          state.setRooms(state.rooms.map((savedRoom) => savedRoom.id === room.id ? { ...savedRoom, lastSeq } : savedRoom));
        }
      };
      next.onPresence = (participants) => {
        latestParticipants = participants;
        if (active && sessionRef.current === next) useAppStore.getState().setParticipants(participants);
      };
      next.onPathChange = (peerId, path) => {
        latestPaths[peerId] = path;
        if (active && sessionRef.current === next) useAppStore.getState().setPath(peerId, path);
      };
      next.onRelayStateChange = (connected) => {
        latestRelayConnected = connected;
        if (active && sessionRef.current === next) {
          const state = useAppStore.getState();
          state.setRelayConnected(connected);
          if (connected) state.setConnectionError(undefined);
        }
      };
      next.onError = (message) => {
        if (active && sessionRef.current === next) useAppStore.getState().setConnectionError(message);
      };

      await next.start();
      assertAttemptOwner();
      const refreshedRooms = await repository.listRooms();
      assertAttemptOwner();

      pendingConnectionAttemptRef.current = undefined;
      attempt.disposed = true;
      attempt.session = undefined;
      sessionRef.current = next;
      active = true;
      setIsViewingLocalRecord(false);
      setSession(next);
      useAppStore.getState().setRooms(refreshedRooms);
      enterRoom(room);
      useAppStore.getState().setEvents(latestEvents);
      useAppStore.getState().setParticipants(latestParticipants);
      useAppStore.getState().setRelayConnected(latestRelayConnected);
      for (const [peerId, path] of Object.entries(latestPaths)) useAppStore.getState().setPath(peerId, path);
    } catch (error) {
      const stillOwner = pendingConnectionAttemptRef.current === attempt;
      disposePendingConnectionAttempt(attempt);
      if (!stillOwner) throw new SupersededConnectionAttemptError();

      pendingConnectionAttemptRef.current = undefined;
      clearSessionPresentation();
      setAuthenticationV2("waiting");
      setIsViewingLocalRecord(false);
      leaveRoomState();
      const message = error instanceof Error ? error.message : String(error);
      useAppStore.getState().setConnectionError(message);
      if (repository) {
        try {
          const refreshedRooms = await repository.listRooms();
          if (connectionAttemptIdRef.current === attempt.id && useAppStore.getState().connectionPhase === "idle") {
            useAppStore.getState().setRooms(refreshedRooms);
          }
        } catch {
          // The original connection error is the actionable failure.
        }
      }
      if (connectionAttemptIdRef.current !== attempt.id) throw new SupersededConnectionAttemptError();
      throw error;
    }
  };

  const openLocalRecord = async (room: RoomRecord) => {
    connectionAttemptIdRef.current += 1;
    const pendingAttempt = pendingConnectionAttemptRef.current;
    pendingConnectionAttemptRef.current = undefined;
    disposePendingConnectionAttempt(pendingAttempt);
    const repository = await getRepository();
    const isV2 = (room.protocolVersion ?? 1) === 2;
    const events = isV2 ? [] : await repository.listEvents(room.id);
    const localViewsV2 = isV2 ? await repository.listEventViewsV2(room.id) : [];
    stopLiveRuntime();
    clearSessionPresentation();
    useAppStore.getState().setConnectionError(undefined);
    enterRoom(room, "idle");
    useAppStore.getState().setEvents(events);
    setViewsV2(localViewsV2);
    setWorldV2(isV2 ? deriveRoomWorldStateFromViewsV2(localViewsV2) : createRoomWorldStateV2());
    setSeatsV2([]);
    setAuthenticationV2("waiting");
    setIsViewingLocalRecord(true);
  };

  const leave = () => {
    connectionAttemptIdRef.current += 1;
    const pendingAttempt = pendingConnectionAttemptRef.current;
    pendingConnectionAttemptRef.current = undefined;
    disposePendingConnectionAttempt(pendingAttempt);
    stopLiveRuntime();
    clearSessionPresentation();
    setIsViewingLocalRecord(false);
    leaveRoomState();
  };

  const relayDegraded = Boolean(connectionPhase === "live" && currentRoom && !isViewingLocalRecord && !relayConnected);
  const connectionLabel = connectionPhase === "connecting"
    ? "正在连接房间…"
    : isViewingLocalRecord
    ? "本地记录（只读）"
    : connectionPhase === "live" && seatAuthFailedV2
    ? "席位验证失败：邀请可能已被换新，请向 KP 索取新邀请串"
    : connectionPhase === "live" && roomPaused
      ? "房主离线 · 房间暂停"
      : relayDegraded
        ? paths[currentRoom?.hostPeerId ?? ""] === "direct"
          ? "仍可正常游玩 · 正在恢复备用连接"
          : "连接不稳定 · 正在自动恢复"
        : currentRoom && connectionPhase === "live"
          ? "房间已连接"
          : currentRoom
            ? "尚未连接房间"
          : "尚未进入调查";

  return (
    <div className="flex h-screen overflow-hidden bg-[#101317] text-ink">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 px-3 py-4 md:flex">
        <div className="mb-7 flex items-center gap-3 px-1">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-brass/40 bg-brass/10 font-serif text-xl text-brass">秘</div>
          <div className="min-w-0">
            <div className="truncate font-serif text-sm text-ink">密斯卡托尼克</div>
            <div className="text-[10px] uppercase tracking-[.18em] text-zinc-600">CoC Room</div>
          </div>
        </div>
        {currentRoom && <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="mb-1 flex items-center gap-2"><span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${currentRoom.localRole === "host" ? "bg-brass/15 text-brass" : "bg-sky-950 text-sky-300"}`}>{currentRoom.localRole === "host" ? "KP" : "调查员"}</span><span className="truncate text-xs font-medium text-zinc-300">{currentRoom.name}</span></div>
          <p className="text-[10px] leading-4 text-zinc-600">{connectionLabel}</p>
        </div>}
        <nav aria-label="主导航" className="grid w-full gap-1">
          {visibleNavigation.map(({ id, label, icon: Icon }) => {
            return (
              <button
                key={id}
                title={label}
                aria-current={activeView === id ? "page" : undefined}
                onClick={() => setActiveView(id)}
                className={cn(
                  "flex h-11 items-center gap-3 rounded-lg px-3 text-left text-sm text-zinc-500 transition hover:bg-zinc-800 hover:text-ink",
                  activeView === id && "bg-zinc-800 text-brass",
                )}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
        <div className="mt-auto grid gap-2">
          {webDevelopmentMode && <details className="rounded-md border border-amber-900/40 bg-amber-950/10 p-2 text-[10px] leading-4 text-amber-300">
            <summary className="cursor-pointer">本机保存提醒</summary>
            <p className="mt-1 text-amber-300/70">当前记录只保存在这个浏览器；清除浏览器数据会一并删除。</p>
          </details>}
        </div>
      </aside>
      <main className="min-w-0 flex-1 pb-16 md:pb-0">
        <ViewErrorBoundary resetKey={activeView}>
        <Suspense fallback={<AppViewLoading />}>
          {activeView === "lobby" && <LobbyView onConnect={connect} onOpenLocalRecord={openLocalRecord} />}
          {activeView === "room" && currentRoom && (currentRoom.protocolVersion ?? 1) === 2
            ? <RoomViewV2
                room={currentRoom}
                session={sessionV2}
                views={viewsV2}
                world={worldV2}
                seats={seatsV2}
                paths={paths}
                authenticationState={authenticationV2}
                readOnly={isViewingLocalRecord}
                connectionError={connectionError}
                setConnectionError={setConnectionError}
                resolveAsset={resolveRoomAsset}
                audioStatus={audioStatus}
                audioVolume={audioVolume}
                audioMuted={audioMuted}
                onAudioVolumeChange={setAudioVolume}
                onAudioMutedChange={setAudioMuted}
                onLeave={leave}
              />
            : activeView === "room" && <RoomView session={session} readOnly={isViewingLocalRecord} onLeave={leave} />}
          {activeView === "characters" && <CharactersView
            session={sessionV2 ?? session}
            worldV2={worldV2}
            requestCharacterDraft={requestCharacterDraft}
            aiDraftStage={aiDraftStage}
            lateApprovedDraft={lateApprovedDraft}
            onConsumeLateApprovedDraft={() => setLateApprovedDraft(undefined)}
            hostCharacterRequests={hostCharacterRequests}
            onApproveHostCharacterRequest={(jobId) => {
              aiCoordinatorRef.current?.approveRequest(jobId);
              setHostCharacterRequests((current) => current.filter((request) => request.jobId !== jobId));
            }}
            onRejectHostCharacterRequest={(jobId) => {
              aiCoordinatorRef.current?.rejectRequest(jobId);
              setHostCharacterRequests((current) => current.filter((request) => request.jobId !== jobId));
            }}
          />}
          {activeView === "modules" && <ModulesView session={sessionV2 ?? session} />}
          {activeView === "settings" && <SettingsView />}
        </Suspense>
        </ViewErrorBoundary>
      </main>
      <nav aria-label="主导航" className={cn("fixed inset-x-0 bottom-0 z-50 grid h-16 border-t border-zinc-800 bg-zinc-950/95 px-1 backdrop-blur md:hidden", visibleNavigation.length === 4 ? "grid-cols-4" : "grid-cols-5")}>
        {visibleNavigation.map(({ id, label, icon: Icon }) => {
          return <button key={id} type="button" aria-current={activeView === id ? "page" : undefined} onClick={() => setActiveView(id)} className={cn("grid place-items-center content-center gap-1 text-[10px] text-zinc-500", activeView === id && "text-brass")}><Icon className="h-5 w-5" /><span>{label}</span></button>;
        })}
      </nav>
    </div>
  );
}

function AppViewLoading() {
  return <div role="status" className="grid h-full min-h-48 place-items-center px-6 text-sm text-zinc-500">正在打开这部分资料…</div>;
}

function AppStartupScreen({ hydration, onRetry }: { hydration: Exclude<AppHydrationState, { status: "ready" }>; onRetry(): void }) {
  const failed = hydration.status === "failed";
  return (
    <main className="grid h-screen place-items-center bg-[#101317] p-6 text-ink">
      <section
        role={failed ? "alert" : "status"}
        aria-busy={!failed}
        className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl"
      >
        <p className="text-xs font-semibold uppercase tracking-[.22em] text-brass">CoC Room</p>
        <h1 className="mt-3 font-serif text-2xl">{failed ? "暂时打不开本机调查资料" : "正在打开你的调查资料"}</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-400">
          {failed
            ? "房间和设置还没有读取完成。你可以重新读取；在此之前不会连接房间或使用默认网络设置。"
            : "正在读取本机保存的房间与设置。完成前不会连接网络，请稍候。"}
        </p>
        {failed && (
          <>
            <button
              type="button"
              className="mt-5 inline-flex h-10 items-center rounded-md bg-brass px-4 text-sm font-semibold text-zinc-950 hover:bg-amber-300"
              onClick={onRetry}
            >
              重新读取
            </button>
            <button
              type="button"
              className="ml-2 inline-flex h-10 items-center rounded-md border border-zinc-700 px-4 text-sm font-semibold text-zinc-300 hover:bg-zinc-900"
              onClick={() => window.location.reload()}
            >
              重新加载应用
            </button>
            <details className="mt-4 rounded-md border border-zinc-800 bg-black/20 px-3 py-2 text-xs text-zinc-500">
              <summary className="cursor-pointer text-zinc-400">查看技术信息</summary>
              <p className="mt-2 break-words">{hydration.message}</p>
            </details>
          </>
        )}
      </section>
    </main>
  );
}

// Retain compile-time correlation with the shared command protocol at the app boundary.
type _SharedCommandContract = RoomCommandV1;
