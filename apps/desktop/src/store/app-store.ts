import { create } from "zustand";
import type { ModulePackageV1, ParticipantV1, RoomEventV1 } from "@coc-room/protocol";
import type { ConnectionPath } from "../network/RoomTransport";
import type { RoomRecord } from "../data/repository";

export type AppView = "lobby" | "room" | "characters" | "modules" | "settings";

interface AppState {
  activeView: AppView;
  relayUrl: string;
  model: string;
  rooms: RoomRecord[];
  modules: ModulePackageV1[];
  currentRoom?: RoomRecord;
  events: RoomEventV1[];
  participants: ParticipantV1[];
  paths: Record<string, ConnectionPath>;
  connectionError?: string;
  setActiveView(view: AppView): void;
  setRelayUrl(value: string): void;
  setModel(value: string): void;
  setRooms(value: RoomRecord[]): void;
  setModules(value: ModulePackageV1[]): void;
  enterRoom(room: RoomRecord): void;
  leaveRoom(): void;
  setEvents(value: RoomEventV1[]): void;
  setParticipants(value: ParticipantV1[]): void;
  setPath(peerId: string, path: ConnectionPath): void;
  setConnectionError(value?: string): void;
}

export const useAppStore = create<AppState>((set) => ({
  activeView: "lobby",
  relayUrl: import.meta.env.VITE_RELAY_URL ?? "http://127.0.0.1:8787",
  model: "deepseek-v4-flash",
  rooms: [],
  modules: [],
  events: [],
  participants: [],
  paths: {},
  setActiveView: (activeView) => set({ activeView }),
  setRelayUrl: (relayUrl) => set({ relayUrl }),
  setModel: (model) => set({ model }),
  setRooms: (rooms) => set({ rooms }),
  setModules: (modules) => set({ modules }),
  enterRoom: (currentRoom) => set({ currentRoom, activeView: "room", events: [], participants: [], paths: {}, connectionError: undefined }),
  leaveRoom: () => set({ currentRoom: undefined, activeView: "lobby", events: [], participants: [], paths: {}, connectionError: undefined }),
  setEvents: (events) => set({ events }),
  setParticipants: (participants) => set({ participants }),
  setPath: (peerId, path) => set((state) => ({ paths: { ...state.paths, [peerId]: path } })),
  setConnectionError: (connectionError) => set({ connectionError }),
}));
