import { describe, expect, it } from "vitest";
import type { RoomEventV2 } from "@coc-room/protocol";
import {
  NPC_CONTEXT_MAX_MESSAGE_CODE_POINTS,
  collectSceneDialogue,
  selectNpcPanelMessages,
} from "./npc-scene-reply";

const npc = { entityId: "npc-doorkeeper", name: "守门人" };

function chatEvent(
  id: string,
  message: string,
  options: { senderName?: string; persona?: { name: string; entityId?: string } } = {},
): RoomEventV2 {
  return {
    protocolVersion: 2,
    roomId: "room-npc-scene",
    eventId: id,
    sequence: 1,
    occurredAt: "2026-01-01T00:00:00.000Z",
    audience: { kind: "room" },
    sender: { seatId: "seat-x", role: "player", displayName: options.senderName ?? "调查员", extensions: {} },
    type: "chat.message",
    payload: {
      message,
      format: "plain",
      ...(options.persona ? { persona: options.persona } : {}),
    },
  } as unknown as RoomEventV2;
}

describe("collectSceneDialogue", () => {
  it("maps the shared stream into NPC and human turns with speaker labels", () => {
    const events: RoomEventV2[] = [
      chatEvent("e1", "教堂晚上还有人来吗？", { senderName: "林默" }),
      chatEvent("e2", "只有风琴自己在响。", { persona: { name: "守门人", entityId: "npc-doorkeeper" } }),
      chatEvent("e3", "（雨下大了。）", { senderName: "KP", persona: { name: "另一位神父", entityId: "npc-priest" } }),
      {
        ...chatEvent("ignored", "x"),
        type: "dice.result",
      } as unknown as RoomEventV2,
    ];
    const messages = collectSceneDialogue(events, npc);
    expect(messages).toEqual([
      { id: "e1", role: "human", content: "教堂晚上还有人来吗？", senderLabel: "林默" },
      { id: "e2", role: "npc", content: "只有风琴自己在响。" },
      // A different NPC's line is still context, labeled by its persona name.
      { id: "e3", role: "human", content: "（雨下大了。）", senderLabel: "另一位神父" },
    ]);
  });

  it("keeps legacy per-session NPC messages readable as context", () => {
    const legacy = {
      ...chatEvent("legacy", ""),
      type: "npc.session.message",
      payload: {
        sessionId: "npc-session-1",
        messageId: "m1",
        role: "npc",
        spokenText: "你看起来在找什么东西。",
      },
    } as unknown as RoomEventV2;
    expect(collectSceneDialogue([legacy], npc)).toEqual([
      { id: "m1", role: "npc", content: "你看起来在找什么东西。" },
    ]);
  });
});

describe("selectNpcPanelMessages", () => {
  it("keeps the newest suffix under the code-point budget", () => {
    const big = "蝶".repeat(NPC_CONTEXT_MAX_MESSAGE_CODE_POINTS);
    const selected = selectNpcPanelMessages([
      { id: "old", role: "human", content: big },
      { id: "new", role: "human", content: "最后一句" },
    ]);
    expect(selected.map(({ id }) => id)).toEqual(["new"]);
  });
});
