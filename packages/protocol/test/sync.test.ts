import { describe, expect, it } from "vitest";

import {
  SyncChunkCollector,
  assembleSyncChunks,
  createSyncChunks,
} from "../src";
import { chatEvent } from "./fixtures";

const REQUEST_ID = "30000000-0000-4000-8000-000000000001";
const TRANSFER_ID = "30000000-0000-4000-8000-000000000002";

describe("synchronization chunks", () => {
  it("round-trips UTF-8 events in out-of-order chunks", () => {
    const events = [chatEvent(1, "克苏鲁".repeat(400)), chatEvent(2, "第二条")];
    const chunks = createSyncChunks(events, {
      roomId: "room-1",
      requestId: REQUEST_ID,
      transferId: TRANSFER_ID,
      maxChunkBytes: 256,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(assembleSyncChunks([...chunks].reverse())).toEqual(events);

    const collector = new SyncChunkCollector();
    let assembled;
    for (const chunk of [...chunks].reverse()) {
      assembled = collector.add(chunk) ?? assembled;
    }
    expect(assembled).toEqual(events);
    expect(collector.isComplete).toBe(true);
    expect(collector.add(chunks[0]!)).toBeUndefined();
  });

  it("rejects incomplete and corrupted transfers", () => {
    const chunks = createSyncChunks([chatEvent(1, "x".repeat(1_000))], {
      roomId: "room-1",
      requestId: REQUEST_ID,
      transferId: TRANSFER_ID,
      maxChunkBytes: 256,
    });
    expect(() => assembleSyncChunks(chunks.slice(1))).toThrow(/incomplete/i);

    const first = chunks[0];
    if (first === undefined) throw new Error("expected a chunk");
    const corrupted = [{ ...first, data: first.data.replace(/^./, first.data[0] === "A" ? "B" : "A") }, ...chunks.slice(1)];
    expect(() => assembleSyncChunks(corrupted)).toThrow(/checksum|JSON|UTF-8/i);
  });
});
