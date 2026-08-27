import { peerMessageSchema, type ParticipantV1 } from "@coc-room/protocol";
import { describe, expect, it } from "vitest";

import { createDiagnosticMessages, type ProcessParticipants } from "./process-network-diagnostic";

describe("cross-process network diagnostic payloads", () => {
  it("uses distinct schema-valid Unicode messages large enough to fragment in relay mode", () => {
    const participants: ProcessParticipants = {
      host: participant("smoke-host-1234567890abcdef", "host"),
      player: participant("smoke-player-1234567890abcdef", "player"),
    };
    const messages = createDiagnosticMessages("room_1234567890abcdef", participants);
    const hostPayload = peerMessageSchema.parse(messages.hostPayload);
    const playerPayload = peerMessageSchema.parse(messages.playerPayload);
    peerMessageSchema.parse(messages.hostAcknowledgement);
    peerMessageSchema.parse(messages.playerAcknowledgement);

    expect(byteLength(hostPayload)).toBeGreaterThan(64 * 1024);
    expect(byteLength(playerPayload)).toBeGreaterThan(64 * 1024);
    expect(JSON.stringify(hostPayload)).not.toBe(JSON.stringify(playerPayload));
    expect(messages.hostAcknowledgement).not.toEqual(messages.playerAcknowledgement);
    expect(hostPayload.kind).toBe("event");
    expect(playerPayload.kind).toBe("event");
    if (hostPayload.kind === "event" && playerPayload.kind === "event") {
      expect(hostPayload.event.payload).toMatchObject({ title: "房主跨进程 Unicode 载荷" });
      expect(playerPayload.event.payload).toMatchObject({ title: "玩家跨进程 Unicode 载荷" });
    }
  });
});

function participant(peerId: string, role: ParticipantV1["role"]): ParticipantV1 {
  return { peerId, displayName: role, role };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
