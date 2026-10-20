import { create } from "zustand";
import type { ModulePackageV1, ParticipantV1, RoomEventV1 } from "@coc-room/protocol";
import type { ConnectionPath } from "../network/RoomTransport";
import type { RoomRecord } from "../data/repository";

export type AppView = "lobby" | "room" | "characters" | "modules" | "settings";
export type ConnectionPhase = "idle" | "connecting" | "live";
export type ModuleParserProvider = "codex" | "deepseek";
export interface PendingRoomModule {
  moduleId: string;
  revision: number;
  title: string;
}

interface AppState {
  activeView: AppView;
  relayUrl: string;
  parserProvider: ModuleParserProvider;
  codexModel: string;
  deepseekModel: string;
  rooms: RoomRecord[];
  modules: ModulePackageV1[];
  pendingRoomModule?: PendingRoomModule;
  characterTableTarget?: { roomId: string; tableSeatId: string };
  currentRoom?: RoomRecord;
  events: RoomEventV1[];
  participants: ParticipantV1[];
  paths: Record<string, ConnectionPath>;
  relayConnected: boolean;
  connectionPhase: ConnectionPhase;
  connectionError?: string;
  setActiveView(view: AppView): void;
  openTableCharacter(roomId: string, tableSeatId: string): void;
  setRelayUrl(value: string): void;
  setParserProvider(value: ModuleParserProvider): void;
  setCodexModel(value: string): void;
  setDeepseekModel(value: string): void;
  setRooms(value: RoomRecord[]): void;
  setModules(value: ModulePackageV1[]): void;
  setPendingRoomModule(value?: PendingRoomModule): void;
  beginConnection(): void;
  enterRoom(room: RoomRecord, connectionPhase?: Exclude<ConnectionPhase, "connecting">): void;
  leaveRoom(): void;
  setEvents(value: RoomEventV1[]): void;
  setParticipants(value: ParticipantV1[]): void;
  setPath(peerId: string, path: ConnectionPath): void;
  setRelayConnected(value: boolean): void;
  setConnectionError(value?: string): void;
}

export const useAppStore = create<AppState>((set) => ({
  activeView: "lobby",
  relayUrl: import.meta.env.VITE_RELAY_URL ?? "http://127.0.0.1:8787",
  parserProvider: "codex",
  codexModel: "",
  deepseekModel: "deepseek-v4-flash",
  rooms: [],
  modules: [],
  pendingRoomModule: undefined,
  events: [],
  participants: [],
  paths: {},
  relayConnected: false,
  connectionPhase: "idle",
  setActiveView: (activeView) => set({ activeView, ...(activeView === "characters" ? { characterTableTarget: undefined } : {}) }),
  openTableCharacter: (roomId, tableSeatId) => set({ activeView: "characters", characterTableTarget: { roomId, tableSeatId } }),
  setRelayUrl: (relayUrl) => set({ relayUrl }),
  setParserProvider: (parserProvider) => set({ parserProvider }),
  setCodexModel: (codexModel) => set({ codexModel }),
  setDeepseekModel: (deepseekModel) => set({ deepseekModel }),
  setRooms: (rooms) => set({ rooms }),
  setModules: (modules) => set({ modules }),
  setPendingRoomModule: (pendingRoomModule) => set({ pendingRoomModule }),
  beginConnection: () => set({ currentRoom: undefined, activeView: "lobby", events: [], participants: [], paths: {}, relayConnected: false, connectionPhase: "connecting", connectionError: undefined }),
  enterRoom: (currentRoom, connectionPhase = "live") => set({ currentRoom, activeView: "room", events: [], participants: [], paths: {}, relayConnected: false, connectionPhase, connectionError: undefined }),
  leaveRoom: () => set({ currentRoom: undefined, activeView: "lobby", events: [], participants: [], paths: {}, relayConnected: false, connectionPhase: "idle", connectionError: undefined }),
  setEvents: (events) => set({ events }),
  setParticipants: (participants) => set({ participants }),
  setPath: (peerId, path) => set((state) => ({ paths: { ...state.paths, [peerId]: path } })),
  setRelayConnected: (relayConnected) => set({ relayConnected }),
  setConnectionError: (connectionError) => set({ connectionError }),
}));
