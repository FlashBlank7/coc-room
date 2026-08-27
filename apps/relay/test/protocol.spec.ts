import { describe, expect, it } from "vitest";
import { MAX_FRAME_BYTES } from "../src/constants";
import {
  canRoute,
  frameByteLength,
  parseClientMessage,
  serializeServerMessage,
} from "../src/protocol";
import type { PeerAttachment } from "../src/types";

function peer(peerId: string, role: "host" | "player"): PeerAttachment {
  return {
    attachmentVersion: 1,
    authenticated: true,
    peerId,
    displayName: peerId,
    role,
    status: "online",
    joinedAt: 1,
  };
}

describe("relay protocol", () => {
  it("accepts all five client message kinds", () => {
    const messages = [
      {
        kind: "join",
        protocolVersion: 1,
        roomId: "room-id-12345678",
        token: "a".repeat(20),
        peerId: "host-peer",
        displayName: "Keeper",
        role: "host",
      },
      { kind: "presence", status: "away" },
      { kind: "signal", targetPeerId: "host-peer", data: { sdp: "offer" } },
      { kind: "relay", targetPeerId: "host-peer", payload: { type: "command" } },
      { kind: "leave" },
    ];

    for (const message of messages) {
      expect(parseClientMessage(JSON.stringify(message))).toMatchObject({
        kind: message.kind,
      });
    }
  });

  it("rejects malformed messages and unsupported versions", () => {
    expect(parseClientMessage("not json")).toBeUndefined();
    expect(
      parseClientMessage(JSON.stringify({ kind: "presence", status: "busy" })),
    ).toBeUndefined();
    expect(
      parseClientMessage(
        JSON.stringify({ kind: "leave", protocolVersion: 2 }),
      ),
    ).toBeUndefined();
  });

  it("enforces the host-centered star topology", () => {
    const host = peer("host-peer", "host");
    const first = peer("player-1", "player");
    const second = peer("player-2", "player");

    expect(canRoute(host, first)).toBe(true);
    expect(canRoute(first, host)).toBe(true);
    expect(canRoute(first, second)).toBe(false);
    expect(canRoute(host, host)).toBe(false);
  });

  it("measures UTF-8 bytes and refuses oversized server envelopes", () => {
    expect(frameByteLength("调查")).toBe(6);
    expect(
      serializeServerMessage({
        kind: "relay",
        protocolVersion: 1,
        fromPeerId: "host-peer",
        payload: "x".repeat(MAX_FRAME_BYTES),
      }),
    ).toBeUndefined();
  });
});
