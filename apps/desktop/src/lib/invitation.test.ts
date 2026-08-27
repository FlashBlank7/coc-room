import { describe, expect, it } from "vitest";
import { decodeInvitation, encodeInvitation } from "./invitation";

describe("room invitations", () => {
  it("round trips Unicode-safe invitations", () => {
    const value = {
      version: 1 as const,
      roomId: "f4a1c8d0-552c-4fca-9aa7-5d573acfef88",
      token: "secret-token-at-least-20-chars",
      hostPeerId: "10df0e8f-badb-436b-b8fa-d47537a33a2f",
      relayUrl: "wss://relay.example.test/rooms",
    };
    expect(decodeInvitation(encodeInvitation(value))).toEqual(value);
  });

  it("rejects arbitrary strings", () => {
    expect(() => decodeInvitation("not-an-invite")).toThrow(/格式/);
  });

  it("rejects short tokens and invalid peer identifiers", () => {
    expect(() => encodeInvitation({
      version: 1,
      roomId: "valid-room-id-1234",
      token: "too-short",
      hostPeerId: "short",
      relayUrl: "wss://relay.example.test/v1/rooms/valid-room-id-1234",
    })).toThrow();
  });

  it("allows insecure WebSocket only for local development", () => {
    const base = {
      version: 1 as const,
      roomId: "valid-room-id-1234",
      token: "012345678901234567890123",
      hostPeerId: "host-peer-1234",
    };
    expect(decodeInvitation(encodeInvitation({ ...base, relayUrl: "ws://127.0.0.1:8787/v1/rooms/valid-room-id-1234" }))).toMatchObject(base);
    expect(() => encodeInvitation({ ...base, relayUrl: "ws://relay.example.test/v1/rooms/valid-room-id-1234" })).toThrow(/WSS/);
  });
});
