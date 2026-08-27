// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomEventV1 } from "@coc-room/protocol";
import type { RoomRecord } from "../data/repository";
import type { RoomSession } from "../network/RoomSession";
import { useAppStore } from "../store/app-store";
import { RoomView } from "./RoomView";

const room: RoomRecord = {
  id: "room-local",
  name: "见世之蝶",
  localRole: "player",
  localPeerId: "player-local",
  hostPeerId: "host-peer",
  inviteToken: "saved-token",
  relayUrl: "ws://127.0.0.1:8787/v1/rooms/room-local/ws",
  lastSeq: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const event: RoomEventV1 = {
  protocolVersion: 1,
  roomId: room.id,
  eventId: "event-1",
  sequence: 1,
  sender: { peerId: "host-peer", displayName: "守秘人", role: "host" },
  type: "chat.message",
  occurredAt: "2026-01-01T01:02:03.000Z",
  payload: { message: "蝶影掠过庭院。", format: "plain" },
};

beforeEach(() => {
  useAppStore.setState({
    activeView: "room",
    currentRoom: room,
    events: [event],
    participants: [],
    paths: {},
    connectionError: undefined,
  });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().leaveRoom();
});

describe("RoomView", () => {
  it("renders local records as an explicitly read-only, exportable view", () => {
    const onLeave = vi.fn();
    render(<RoomView readOnly onLeave={onLeave} />);

    expect(screen.getByText("蝶影掠过庭院。")).toBeTruthy();
    expect(screen.getAllByText(/本地记录（只读）/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Markdown" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "HTML" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("说点什么……")).toBeNull();
    expect(screen.queryByRole("heading", { name: "骰子与检定" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "在线成员" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "返回大厅" }));
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("submits the selected check difficulty only when a target is present", async () => {
    const submit = vi.fn(async (_type: string, _payload: unknown) => undefined);
    const session = { submit } as unknown as RoomSession;
    render(<RoomView session={session} onLeave={() => undefined} />);

    const difficulty = screen.getByRole("combobox", { name: "成功难度" });
    expect((difficulty as HTMLSelectElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("目标值（可选）"), { target: { value: "60" } });
    fireEvent.change(difficulty, { target: { value: "hard" } });
    fireEvent.click(screen.getByRole("button", { name: "掷骰并记录" }));

    await waitFor(() => expect(submit).toHaveBeenCalledWith("dice.roll", expect.objectContaining({
      target: 60,
      requiredDifficulty: "hard",
    })));

    submit.mockClear();
    fireEvent.change(screen.getByLabelText("目标值（可选）"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "掷骰并记录" }));

    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const payload = submit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("target");
    expect(payload).not.toHaveProperty("requiredDifficulty");
  });
});
