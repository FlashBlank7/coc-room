// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeInvitation } from "./lib/invitation";
import type { LocalRepository, RoomRecord } from "./data/repository";
import type { RoomEventV1 } from "@coc-room/protocol";
import { useAppStore } from "./store/app-store";

const mocks = vi.hoisted(() => ({
  getRepository: vi.fn(),
  roomSessionConstructor: vi.fn(),
  roomSessionStart: vi.fn(),
  roomSessionStop: vi.fn(),
}));

vi.mock("./data/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./data/repository")>();
  return { ...actual, getRepository: mocks.getRepository };
});

vi.mock("./network/RoomSession", () => ({
  RoomSession: class MockRoomSession {
    constructor(options: unknown) {
      mocks.roomSessionConstructor(options);
    }

    start() {
      return mocks.roomSessionStart();
    }

    stop() {
      mocks.roomSessionStop();
    }
  },
}));

import { App } from "./App";

const room: RoomRecord = {
  id: "archived-room",
  name: "离线调查",
  localRole: "player",
  localPeerId: "local-peer",
  hostPeerId: "host-peer",
  inviteToken: "saved-token",
  relayUrl: "wss://relay.invalid/v1/rooms/archived-room/ws",
  lastSeq: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const savedEvent: RoomEventV1 = {
  protocolVersion: 1,
  roomId: room.id,
  eventId: "saved-event",
  sequence: 1,
  sender: { peerId: "host-peer", displayName: "守秘人", role: "host" },
  type: "system.notice",
  occurredAt: "2026-01-01T00:10:00.000Z",
  payload: { message: "这是本机保存的记录。", level: "info" },
};

beforeEach(() => {
  const repository = {
    listRooms: vi.fn(async () => [room]),
    listModules: vi.fn(async () => []),
    listEvents: vi.fn(async () => [savedEvent]),
    getSetting: vi.fn(async () => undefined),
  } as unknown as LocalRepository;
  mocks.getRepository.mockResolvedValue(repository);
  mocks.roomSessionConstructor.mockClear();
  mocks.roomSessionStart.mockReset().mockResolvedValue(undefined);
  mocks.roomSessionStop.mockClear();
  useAppStore.setState({
    activeView: "lobby",
    currentRoom: undefined,
    rooms: [],
    modules: [],
    events: [],
    participants: [],
    paths: {},
    connectionError: undefined,
  });
});

afterEach(() => {
  cleanup();
  mocks.getRepository.mockReset();
  useAppStore.getState().leaveRoom();
});

describe("App local record mode", () => {
  it("loads saved events without constructing a RoomSession", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "查看本地记录" }));

    expect(await screen.findByText("这是本机保存的记录。")).toBeTruthy();
    expect(screen.getAllByText(/本地记录（只读）/).length).toBeGreaterThan(0);
    expect(mocks.roomSessionConstructor).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "返回大厅" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "开始一次调查" })).toBeTruthy());
  });
});

describe("App failed room replacement", () => {
  it("clears stale active-room state while preserving saved room records", async () => {
    const invitation = encodeInvitation({
      version: 1,
      roomId: "joined-room-id-12345",
      token: "host-id-1234." + "s".repeat(43),
      hostPeerId: "host-id-1234",
      relayUrl: "ws://127.0.0.1:8787/v1/rooms/joined-room-id-12345/ws",
    });
    mocks.roomSessionStart.mockRejectedValue(new Error("relay unavailable"));
    useAppStore.setState({ currentRoom: room, activeView: "lobby", rooms: [room] });
    render(<App />);

    fireEvent.change(screen.getAllByRole("textbox")[2]!, { target: { value: "player" } });
    fireEvent.change(screen.getAllByRole("textbox")[3]!, { target: { value: invitation } });
    fireEvent.click(screen.getByRole("button", { name: /解析邀请并加入/ }));

    await screen.findByText("relay unavailable");
    expect(useAppStore.getState().currentRoom).toBeUndefined();
    expect(useAppStore.getState().activeView).toBe("lobby");
    expect(useAppStore.getState().rooms).toContainEqual(room);
    expect(mocks.roomSessionStop).toHaveBeenCalledOnce();
  });
});
