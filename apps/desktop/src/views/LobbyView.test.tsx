// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomRecord } from "../data/repository";
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
  useAppStore.setState({ rooms: [] });
});

describe("LobbyView saved rooms", () => {
  it("opens a saved room locally without reconnecting", async () => {
    const onConnect = vi.fn(async () => undefined);
    const onOpenLocalRecord = vi.fn(async () => undefined);
    render(<LobbyView onConnect={onConnect} onOpenLocalRecord={onOpenLocalRecord} />);

    fireEvent.click(screen.getByRole("button", { name: "查看本地记录" }));

    await waitFor(() => expect(onOpenLocalRecord).toHaveBeenCalledWith(room));
    expect(onConnect).not.toHaveBeenCalled();
  });
});
