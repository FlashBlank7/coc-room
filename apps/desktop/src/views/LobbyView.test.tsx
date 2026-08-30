// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomRecord } from "../data/repository";
import { encodeInvitationV2 } from "../lib/invitation";
import { useAppStore } from "../store/app-store";
import { LobbyView } from "./LobbyView";

const room: RoomRecord = {
  id: "room-offline",
  name: "旧日调查",
  localRole: "player",
  localPeerId: "player-local",
  hostPeerId: "host-peer",
  inviteToken: "saved-token",
  relayUrl: "ws://127.0.0.1:8787/v1/rooms/room-offline/ws",
  lastSeq: 12,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const modernRoom: RoomRecord = {
  ...room,
  id: "room-current",
  name: "雾港来信",
  protocolVersion: 2,
  localSeatId: "seat-player",
  hostSeatId: "seat-host",
  seatCredentialVersion: 1,
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ activeView: "lobby", pendingRoomModule: undefined, currentRoom: undefined, rooms: [room], relayUrl: "http://127.0.0.1:8787", connectionPhase: "idle" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAppStore.setState({ activeView: "lobby", pendingRoomModule: undefined, currentRoom: undefined, rooms: [], connectionPhase: "idle" });
});

describe("LobbyView saved rooms", () => {
  it("prioritizes returning to the active investigation instead of reconnecting it", () => {
    useAppStore.setState({ currentRoom: room, connectionPhase: "live" });
    render(<LobbyView onConnect={vi.fn()} onOpenLocalRecord={vi.fn()} />);

    expect(screen.getByRole("heading", { name: room.name })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "继续调查" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "回到现场" }));

    expect(useAppStore.getState().activeView).toBe("room");
  });

  it("does not create a new room when the user declines leaving the active connection", () => {
    const onConnect = vi.fn(async () => undefined);
    const fetchMock = vi.fn();
    const confirmMock = vi.fn(() => false);
    useAppStore.setState({ currentRoom: room, connectionPhase: "live" });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", confirmMock);
    render(<LobbyView onConnect={onConnect} onOpenLocalRecord={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /我是 KP，开一个新团/ }));
    fireEvent.change(screen.getByLabelText("你的称呼"), { target: { value: "守秘人" } });
    fireEvent.click(screen.getByRole("button", { name: "创建房间并进入" }));

    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("会离开当前连接"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
    expect(useAppStore.getState().currentRoom).toEqual(room);
  });

  it("does not join another room when the user declines leaving the active connection", async () => {
    const onConnect = vi.fn(async () => undefined);
    const confirmMock = vi.fn(() => false);
    const invitation = encodeInvitationV2({
      protocolVersion: 2,
      roomId: "another-room-id-12345",
      seatId: "seat-alice",
      role: "player",
      relayToken: "host-id-1234." + "s".repeat(43),
      seatSecret: "x".repeat(48),
      credentialVersion: 1,
      hostSeatId: "seat-host",
      hostPeerId: "host-id-1234",
      relayUrl: "ws://127.0.0.1:8787/v1/rooms/another-room-id-12345/ws",
    });
    useAppStore.setState({ currentRoom: room, connectionPhase: "live" });
    vi.stubGlobal("confirm", confirmMock);
    render(<LobbyView onConnect={onConnect} onOpenLocalRecord={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /我是玩家，加入朋友/ }));
    fireEvent.change(screen.getByLabelText("你的称呼"), { target: { value: "调查员" } });
    fireEvent.change(screen.getByLabelText("KP 发给你的邀请"), { target: { value: invitation } });
    fireEvent.click(screen.getByRole("button", { name: "加入调查" }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("会离开当前连接")));
    expect(onConnect).not.toHaveBeenCalled();
    expect(useAppStore.getState().currentRoom).toEqual(room);
  });

  it("creates a host room with separate host and player credentials", async () => {
    const onConnect = vi.fn(async (_room: RoomRecord, _nickname: string) => undefined);
    const hostToken = "h".repeat(43);
    const joinToken = `host-peer-placeholder.${"j".repeat(43)}`;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { hostPeerId: string };
      return new Response(JSON.stringify({
        protocolVersion: 1,
        roomId: "created-room-id-1234",
        hostPeerId: request.hostPeerId,
        hostToken,
        joinToken,
        websocketUrl: "ws://127.0.0.1:8787/v1/rooms/created-room-id-1234/ws",
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LobbyView onConnect={onConnect} onOpenLocalRecord={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /我是 KP，开一个新团/ }));
    fireEvent.change(screen.getByLabelText("你的称呼"), { target: { value: "守秘人" } });
    fireEvent.change(screen.getByLabelText("房间名"), { target: { value: "周五夜谈" } });
    fireEvent.click(screen.getByRole("button", { name: "创建房间并进入" }));

    await waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
    const [createdRoom, nickname] = onConnect.mock.calls[0]!;
    expect(nickname).toBe("守秘人");
    expect(createdRoom).toMatchObject({
      id: "created-room-id-1234",
      name: "周五夜谈",
      localRole: "host",
      inviteToken: hostToken,
      joinToken,
      relayUrl: "ws://127.0.0.1:8787/v1/rooms/created-room-id-1234/ws",
      lastSeq: 0,
    });
    expect(createdRoom.localPeerId).toBe(createdRoom.hostPeerId);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8787/v1/rooms", expect.objectContaining({ method: "POST" }));
  });

  it("keeps a preselected module through room creation and routes to explicit confirmation", async () => {
    const pendingRoomModule = { moduleId: "module-ready", revision: 3, title: "见世之蝶" };
    const onConnect = vi.fn(async (_room: RoomRecord, _nickname: string) => undefined);
    useAppStore.setState({ pendingRoomModule });
    const hostToken = "h".repeat(43);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { hostPeerId: string };
      return new Response(JSON.stringify({
        protocolVersion: 1,
        roomId: "created-for-module-1234",
        hostPeerId: request.hostPeerId,
        hostToken,
        joinToken: `${request.hostPeerId}.${"j".repeat(43)}`,
        websocketUrl: "ws://127.0.0.1:8787/v1/rooms/created-for-module-1234/ws",
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LobbyView onConnect={onConnect} onOpenLocalRecord={vi.fn()} />);

    const selectedModule = screen.getByLabelText("新房间待用模组");
    expect(within(selectedModule).getByText(/确认前，这份模组不会进入房间/)).not.toBeNull();
    fireEvent.change(screen.getByLabelText("你的称呼"), { target: { value: "守秘人" } });
    fireEvent.click(screen.getByRole("button", { name: "创建房间，下一步确认模组" }));

    await waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
    await waitFor(() => expect(useAppStore.getState().activeView).toBe("modules"));
    expect(useAppStore.getState().pendingRoomModule).toEqual(pendingRoomModule);
  });

  it("does not offer to create a second room when an existing host room still awaits module confirmation", () => {
    const hostRoom = { ...modernRoom, localRole: "host" as const };
    useAppStore.setState({
      currentRoom: hostRoom,
      connectionPhase: "live",
      pendingRoomModule: { moduleId: "module-ready", revision: 3, title: "见世之蝶" },
    });
    render(<LobbyView onConnect={vi.fn()} onOpenLocalRecord={vi.fn()} />);

    expect(screen.getByLabelText("待确认房间模组").textContent).toContain("模组还没有带入");
    expect(screen.queryByRole("form", { name: "创建调查房间" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "继续确认模组" }));
    expect(useAppStore.getState().activeView).toBe("modules");
  });

  it("turns a room creation failure into a safe retry instead of a network error dump", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    render(<LobbyView onConnect={vi.fn()} onOpenLocalRecord={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /我是 KP，开一个新团/ }));
    fireEvent.change(screen.getByLabelText("你的称呼"), { target: { value: "守秘人" } });
    fireEvent.click(screen.getByRole("button", { name: "创建房间并进入" }));

    expect(await screen.findByText(/请检查网络后再试一次/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "创建房间并进入" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("查看技术信息").closest("details")?.open).toBe(false);
  });

  it("joins from an invitation as a new player without receiving the host credential", async () => {
    const onConnect = vi.fn(async (_room: RoomRecord, _nickname: string) => undefined);
    const invitation = encodeInvitationV2({
      protocolVersion: 2,
      roomId: "joined-room-id-12345",
      roomName: "雾港来信",
      seatId: "seat-alice",
      role: "player",
      relayToken: "host-id-1234." + "s".repeat(43),
      seatSecret: "x".repeat(48),
      credentialVersion: 1,
      hostSeatId: "seat-host",
      hostPeerId: "host-id-1234",
      relayUrl: "ws://127.0.0.1:8787/v1/rooms/joined-room-id-12345/ws",
    });
    render(<LobbyView onConnect={onConnect} onOpenLocalRecord={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /我是玩家，加入朋友/ }));
    fireEvent.change(screen.getByLabelText("你的称呼"), { target: { value: "调查员" } });
    fireEvent.change(screen.getByLabelText("KP 发给你的邀请"), { target: { value: invitation } });
    fireEvent.click(screen.getByRole("button", { name: "加入调查" }));

    await waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
    const [joinedRoom, nickname] = onConnect.mock.calls[0]!;
    expect(nickname).toBe("调查员");
    expect(joinedRoom).toMatchObject({
      id: "joined-room-id-12345",
      name: "雾港来信",
      localRole: "player",
      hostPeerId: "host-id-1234",
      inviteToken: "host-id-1234." + "s".repeat(43),
      protocolVersion: 2,
      localSeatId: "seat-alice",
      hostSeatId: "seat-host",
      relayUrl: "ws://127.0.0.1:8787/v1/rooms/joined-room-id-12345/ws",
      lastSeq: 0,
    });
    expect(joinedRoom).not.toHaveProperty("joinToken");
    expect(joinedRoom.localPeerId).not.toBe(joinedRoom.hostPeerId);
  });

  it("returns to a current-format saved room with one clear primary action", async () => {
    const onConnect = vi.fn(async () => undefined);
    useAppStore.setState({ rooms: [modernRoom] });
    render(<LobbyView onConnect={onConnect} onOpenLocalRecord={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "继续调查" }));

    await waitFor(() => expect(onConnect).toHaveBeenCalledWith(modernRoom, "调查员"));
  });

  it("keeps a failed return visible and offers the saved record as recovery", async () => {
    const onConnect = vi.fn(async () => { throw new Error("relay unavailable"); });
    useAppStore.setState({ rooms: [modernRoom] });
    render(<LobbyView onConnect={onConnect} onOpenLocalRecord={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "继续调查" }));

    expect(await screen.findByText(/请确认 KP 在线后再试/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "只看记录" })).toBeTruthy();
    expect(screen.getByText("查看技术信息").closest("details")?.open).toBe(false);
  });

  it("offers a legacy investigation as a readable record instead of a broken reconnect", async () => {
    const onConnect = vi.fn(async () => undefined);
    const onOpenLocalRecord = vi.fn(async () => undefined);
    render(<LobbyView onConnect={onConnect} onOpenLocalRecord={onOpenLocalRecord} />);

    expect(screen.queryByRole("button", { name: "继续调查" })).toBeNull();
    expect(screen.getByText(/旧版调查；仍可查看并导出/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看并导出记录" }));

    await waitFor(() => expect(onOpenLocalRecord).toHaveBeenCalledWith(room));
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("gives a first-time visitor a human choice without protocol vocabulary", () => {
    useAppStore.setState({ rooms: [] });
    render(<LobbyView onConnect={vi.fn()} onOpenLocalRecord={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "今晚，开始一次调查。" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "你要主持，还是加入朋友的房间？" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /我是 KP，开一个新团/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /我是玩家，加入朋友/ })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/席位|令牌|协议|coc-room:v2/);
  });

  it("turns a malformed invitation into a concrete recovery step", () => {
    useAppStore.setState({ rooms: [] });
    render(<LobbyView onConnect={vi.fn()} onOpenLocalRecord={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /我是玩家，加入朋友/ }));
    fireEvent.change(screen.getByLabelText("你的称呼"), { target: { value: "小林" } });
    fireEvent.change(screen.getByLabelText("KP 发给你的邀请"), { target: { value: "只复制到一半" } });
    fireEvent.click(screen.getByRole("button", { name: "加入调查" }));

    expect(screen.getByRole("alert").textContent).toContain("重新复制 KP 发来的完整内容");
    const technicalDetails = screen.getByText("查看技术信息").closest("details");
    expect(technicalDetails?.open).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText("KP 发给你的邀请"));
  });

  it("keeps connection failures human-readable and retryable", async () => {
    const onConnect = vi.fn(async () => { throw new Error("seat HMAC handshake failed"); });
    const invitation = encodeInvitationV2({
      protocolVersion: 2,
      roomId: "joined-room-id-12345",
      seatId: "seat-alice",
      role: "player",
      relayToken: "host-id-1234." + "s".repeat(43),
      seatSecret: "x".repeat(48),
      credentialVersion: 1,
      hostSeatId: "seat-host",
      hostPeerId: "host-id-1234",
      relayUrl: "ws://127.0.0.1:8787/v1/rooms/joined-room-id-12345/ws",
    });
    useAppStore.setState({ rooms: [] });
    render(<LobbyView onConnect={onConnect} onOpenLocalRecord={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /我是玩家，加入朋友/ }));
    fireEvent.change(screen.getByLabelText("你的称呼"), { target: { value: "小林" } });
    fireEvent.change(screen.getByLabelText("KP 发给你的邀请"), { target: { value: invitation } });
    fireEvent.click(screen.getByRole("button", { name: "加入调查" }));

    expect(await screen.findByText(/请确认 KP 仍在线/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "加入调查" }).hasAttribute("disabled")).toBe(false);
  });
});
