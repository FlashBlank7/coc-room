// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RoomRecord } from "./data/repository";
import { useAppStore } from "./store/app-store";
import { App } from "./App";

const room = (localRole: RoomRecord["localRole"]): RoomRecord => ({
  id: `room-${localRole}`,
  name: localRole === "host" ? "KP 的调查" : "玩家的调查",
  localRole,
  localPeerId: `${localRole}-peer`,
  hostPeerId: "host-peer",
  inviteToken: "saved-token",
  relayUrl: "ws://127.0.0.1:8787/v1/rooms/test/ws",
  lastSeq: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ activeView: "lobby", currentRoom: undefined, connectionPhase: "idle" });
});

describe("App navigation", () => {
  it("does not show an unusable investigation tab before the visitor has entered a room", async () => {
    useAppStore.setState({ activeView: "lobby", currentRoom: undefined, connectionPhase: "idle" });

    render(<App />);

    await screen.findAllByRole("button", { name: "开始" });
    expect(screen.queryByRole("button", { name: "调查现场" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "开始" })).toHaveLength(2);
    expect(screen.queryByText("尚未进入调查")).toBeNull();
  });

  it("shows KP preparation without an active room and opens it", async () => {
    render(<App />);

    const moduleButtons = await screen.findAllByRole("button", { name: "KP 备团" });
    expect(moduleButtons).toHaveLength(2);
    fireEvent.click(moduleButtons[0]!);

    expect(await screen.findByRole("heading", { name: "把模组变成随手可查的备团资料", level: 1 })).toBeTruthy();
  });

  it("hides KP preparation from a player who is already in a room", async () => {
    useAppStore.setState({ activeView: "lobby", currentRoom: room("player"), connectionPhase: "live" });

    render(<App />);

    await screen.findAllByRole("button", { name: "调查现场" });
    expect(screen.queryByRole("button", { name: "KP 备团" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "调查现场" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "大厅" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "开始" })).toBeNull();
  });

  it("keeps KP preparation available to the room host", async () => {
    useAppStore.setState({ activeView: "lobby", currentRoom: room("host"), connectionPhase: "live" });

    render(<App />);

    expect(await screen.findAllByRole("button", { name: "KP 备团" })).toHaveLength(2);
  });

  it("describes an automatic recovery in human language", async () => {
    const hostRoom = room("host");
    useAppStore.setState({
      activeView: "lobby",
      currentRoom: hostRoom,
      connectionPhase: "live",
      relayConnected: false,
      paths: { [hostRoom.hostPeerId]: "direct" },
    });

    render(<App />);

    expect(await screen.findByText("仍可正常游玩 · 正在恢复备用连接")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/直连|中继/);
  });
});
