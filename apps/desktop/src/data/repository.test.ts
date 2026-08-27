import { describe, expect, it } from "vitest";
import { MemoryRepository } from "./repository";

describe("MemoryRepository", () => {
  it("persists an event idempotently", async () => {
    const repository = new MemoryRepository();
    const event = {
      protocolVersion: 1 as const,
      roomId: "room-12345678",
      eventId: "2bf33a20-8982-4186-8bd5-6d0848449602",
      sequence: 1,
      sender: { peerId: "peer-12345678", displayName: "调查员", role: "player" as const },
      occurredAt: "2026-01-01T00:00:00.000Z",
      type: "chat.message" as const,
      payload: { message: "有人吗？", format: "plain" as const },
    };
    expect(await repository.saveEvent(event)).toBe(true);
    expect(await repository.saveEvent(event)).toBe(false);
    expect(await repository.listEvents(event.roomId)).toEqual([event]);
  });

  it("rejects reused IDs and occupied sequences with different content", async () => {
    const repository = new MemoryRepository();
    const event = {
      protocolVersion: 1 as const,
      roomId: "room-12345678",
      eventId: "2bf33a20-8982-4186-8bd5-6d0848449602",
      sequence: 1,
      sender: { peerId: "peer-12345678", displayName: "调查员", role: "player" as const },
      occurredAt: "2026-01-01T00:00:00.000Z",
      type: "chat.message" as const,
      payload: { message: "有人吗？", format: "plain" as const },
    };
    await repository.saveEvent(event);
    await expect(repository.saveEvent({ ...event, payload: { ...event.payload, message: "不同内容" } })).rejects.toThrow(/ID/);
    await expect(repository.saveEvent({ ...event, eventId: "fe8afcab-1bcc-490f-a71d-fc0bbb1321a2" })).rejects.toThrow(/序号/);
  });
});
