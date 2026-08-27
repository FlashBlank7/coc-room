import { describe, expect, it } from "vitest";

import {
  MAX_RELAY_FRAME_BYTES,
  RELAY_FRAGMENT_BYTES,
  RelayFragmentReassembler,
  createRelayFragments,
  relayClientEnvelopeSchema,
  relayServerEnvelopeSchema,
  type PeerMessageV1,
} from "../src";

const TRANSFER_A = "00000000-0000-4000-8000-000000000101";
const TRANSFER_B = "00000000-0000-4000-8000-000000000102";

describe("relay transport fragmentation", () => {
  it("round-trips large Chinese and emoji messages out of order exactly once", () => {
    const message = largeUnicodeMessage();
    const fragments = createRelayFragments(message, TRANSFER_A);
    expect(fragments.length).toBeGreaterThan(2);

    const maximumPeerId = "p".repeat(64);
    for (const fragment of fragments) {
      const clientFrame = relayClientEnvelopeSchema.parse({
        kind: "relay",
        targetPeerId: maximumPeerId,
        payload: fragment,
      });
      const workerFrame = relayServerEnvelopeSchema.parse({
        kind: "relay",
        protocolVersion: 1,
        fromPeerId: maximumPeerId,
        payload: fragment,
      });
      expect(byteLength(clientFrame)).toBeLessThanOrEqual(MAX_RELAY_FRAME_BYTES);
      expect(byteLength(workerFrame)).toBeLessThanOrEqual(MAX_RELAY_FRAME_BYTES);
    }

    const reassembler = new RelayFragmentReassembler();
    const delivered: PeerMessageV1[] = [];
    expect(reassembler.add("peer-one", fragments[0]!)).toBeUndefined();
    expect(reassembler.add("peer-one", fragments[0]!)).toBeUndefined();
    for (const fragment of fragments.slice(1).reverse()) {
      const result = reassembler.add("peer-one", fragment);
      if (result !== undefined) delivered.push(result);
    }

    expect(delivered).toEqual([message]);
    expect(reassembler.inflightTransfers).toBe(0);
    expect(reassembler.bufferedBytes).toBe(0);

    for (const fragment of fragments) {
      expect(reassembler.add("peer-one", fragment)).toBeUndefined();
    }
    expect(delivered).toHaveLength(1);
  });

  it("rejects conflicting duplicates and releases their buffered memory", () => {
    const fragments = createRelayFragments(largeUnicodeMessage(), TRANSFER_A);
    const reassembler = new RelayFragmentReassembler();
    reassembler.add("peer-one", fragments[0]!);
    const original = fragments[0]!;
    const firstCharacter = original.data[0] === "A" ? "B" : "A";
    const conflicting = { ...original, data: firstCharacter + original.data.slice(1) };

    expect(() => reassembler.add("peer-one", conflicting)).toThrow(/Conflicting duplicate/);
    expect(reassembler.inflightTransfers).toBe(0);
    expect(reassembler.bufferedBytes).toBe(0);
  });

  it("bounds incomplete transfers and expires abandoned fragments", () => {
    let now = 1_000;
    const reassembler = new RelayFragmentReassembler({
      now: () => now,
      transferTtlMs: 100,
      maxInflightTransfers: 1,
      maxBufferedBytes: RELAY_FRAGMENT_BYTES * 2,
    });
    const first = createRelayFragments(largeUnicodeMessage(), TRANSFER_A)[0]!;
    const second = createRelayFragments(largeUnicodeMessage(), TRANSFER_B)[0]!;

    reassembler.add("peer-one", first);
    expect(() => reassembler.add("peer-one", second)).toThrow(/Too many incomplete/);
    expect(reassembler.inflightTransfers).toBe(1);

    now += 101;
    expect(reassembler.add("peer-one", second)).toBeUndefined();
    expect(reassembler.inflightTransfers).toBe(1);
    expect(reassembler.bufferedBytes).toBe(RELAY_FRAGMENT_BYTES);
  });
});

function largeUnicodeMessage(): PeerMessageV1 {
  return {
    kind: "event",
    event: {
      protocolVersion: 1,
      roomId: "room_abcdefghijklmnop",
      eventId: "00000000-0000-4000-8000-000000000201",
      sequence: 1,
      sender: { peerId: "host-peer-1234", displayName: "守秘人", role: "host" },
      type: "content.revealed",
      occurredAt: "2026-08-28T00:00:00.000Z",
      payload: {
        moduleId: "module-butterfly",
        revision: 1,
        contentId: "handout-butterfly",
        contentType: "handout",
        title: "见世之蝶",
        body: "见🦋".repeat(15_000),
      },
    },
  };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
