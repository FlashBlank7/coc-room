// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomRecord } from "../data/repository";
import { encodeInvitation } from "../lib/invitation";
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

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ rooms: [room], relayUrl: "http://127.0.0.1:8787" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAppStore.setState({ rooms: [] });
});

describe("LobbyView saved rooms", () => {
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

    fireEvent.change(screen.getAllByLabelText("你的昵称")[0]!, { target: { value: "守秘人" } });
    fireEvent.change(screen.getByLabelText("房间名"), { target: { value: "周五夜谈" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并连接" }));

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

  it("joins from an invitation as a new player without receiving the host credential", async () => {
    const onConnect = vi.fn(async (_room: RoomRecord, _nickname: string) => undefined);
    const invitation = encodeInvitation({
      version: 1,
      roomId: "joined-room-id-12345",
      token: "host-id-1234." + "s".repeat(43),
      hostPeerId: "host-id-1234",
      relayUrl: "ws://127.0.0.1:8787/v1/rooms/joined-room-id-12345/ws",
    });
    render(<LobbyView onConnect={onConnect} onOpenLocalRecord={vi.fn()} />);

    fireEvent.change(screen.getAllByLabelText("你的昵称")[1]!, { target: { value: "调查员" } });
    fireEvent.change(screen.getByLabelText(/^邀请串/), { target: { value: invitation } });
    fireEvent.click(screen.getByRole("button", { name: "解析邀请并加入" }));

    await waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
    const [joinedRoom, nickname] = onConnect.mock.calls[0]!;
    expect(nickname).toBe("调查员");
    expect(joinedRoom).toMatchObject({
      id: "joined-room-id-12345",
      localRole: "player",
      hostPeerId: "host-id-1234",
      inviteToken: "host-id-1234." + "s".repeat(43),
      relayUrl: "ws://127.0.0.1:8787/v1/rooms/joined-room-id-12345/ws",
      lastSeq: 0,
    });
    expect(joinedRoom).not.toHaveProperty("joinToken");
    expect(joinedRoom.localPeerId).not.toBe(joinedRoom.hostPeerId);
  });

  it("opens a saved room locally without reconnecting", async () => {
    const onConnect = vi.fn(async () => undefined);
    const onOpenLocalRecord = vi.fn(async () => undefined);
    render(<LobbyView onConnect={onConnect} onOpenLocalRecord={onOpenLocalRecord} />);

    fireEvent.click(screen.getByRole("button", { name: "查看本地记录" }));

    await waitFor(() => expect(onOpenLocalRecord).toHaveBeenCalledWith(room));
    expect(onConnect).not.toHaveBeenCalled();
  });
});
