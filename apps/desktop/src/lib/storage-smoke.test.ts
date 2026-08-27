import { describe, expect, it } from "vitest";
import { exportEventsToHtml, exportEventsToMarkdown, type RoomEventV1 } from "@coc-room/protocol";
import { createStorageSmokeMarker } from "./storage-smoke";

describe("storage smoke marker", () => {
  it("survives Markdown and HTML export without escaping", () => {
    const marker = createStorageSmokeMarker("550e8400-e29b-41d4-a716-446655440000");
    const event: RoomEventV1 = {
      protocolVersion: 1,
      roomId: "storage-room",
      eventId: "550e8400-e29b-41d4-a716-446655440001",
      sequence: 1,
      sender: { peerId: "host", displayName: "Host", role: "host" },
      occurredAt: "2026-08-28T00:00:00.000Z",
      type: "chat.message",
      payload: { message: marker, format: "plain" },
    };
    const options = {
      title: "Storage smoke",
      roomName: "Storage room",
      roomId: event.roomId,
      generatedAt: event.occurredAt,
    };

    expect(marker).toMatch(/^[a-z0-9]+$/iu);
    expect(exportEventsToMarkdown([event], options)).toContain(marker);
    expect(exportEventsToHtml([event], options)).toContain(marker);
  });
});
