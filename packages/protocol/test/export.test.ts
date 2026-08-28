import { describe, expect, it } from "vitest";

import { exportEventsToHtml, exportEventsToMarkdown, type RoomEventV1 } from "../src";
import { CHARACTER, HOST, PLAYER, chatEvent } from "./fixtures";

describe("transcript exports", () => {
  it("sorts Markdown records by host sequence", () => {
    const markdown = exportEventsToMarkdown([chatEvent(2), chatEvent(1)], {
      generatedAt: "2026-08-27T13:00:00.000Z",
    });
    expect(markdown.indexOf("000001")).toBeLessThan(markdown.indexOf("000002"));
    expect(markdown).toContain("事件数：2");
  });

  it("produces a self-contained HTML document and escapes user content", () => {
    const html = exportEventsToHtml([chatEvent(1, '<script>alert("x")</script>')], {
      title: "测试记录",
      generatedAt: "2026-08-27T13:00:00.000Z",
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).not.toMatch(/<(?:link|script)\b/i);
  });

  it("exports the complete character snapshot instead of only entry counts", () => {
    const character = {
      ...CHARACTER,
      status: { ...CHARACTER.status, majorWound: true },
      notes: "私人备忘 <不公开>",
      extensions: { campaign: { reputation: 2 } },
    };
    const event: RoomEventV1 = {
      protocolVersion: 1,
      roomId: "room-1",
      eventId: "00000000-0000-4000-8000-000000000099",
      sequence: 99,
      sender: PLAYER,
      occurredAt: "2026-08-27T12:00:00.000Z",
      type: "character.updated",
      payload: { character },
    };

    const markdown = exportEventsToMarkdown([event], { generatedAt: "2026-08-27T13:00:00.000Z" });
    expect(markdown).toContain("图书馆使用：70（基础 20）");
    expect(markdown).toContain("笔记本");
    expect(markdown).toContain("一本旧笔记本");
    expect(markdown).toContain("真相值得付出代价");
    expect(markdown).toContain("异常状态：重伤");
    expect(markdown).toContain("私人备忘 &lt;不公开&gt;");
    expect(markdown).not.toContain("技能数：1");

    const html = exportEventsToHtml([event], { generatedAt: "2026-08-27T13:00:00.000Z" });
    expect(html).toContain("图书馆使用：70（基础 20）");
    expect(html).toContain("一本旧笔记本");
    expect(html).toContain("真相值得付出代价");
    expect(html).toContain("重伤");
    expect(html).toContain("私人备忘 &lt;不公开&gt;");
    expect(html).toContain("reputation");
  });

  it("exports immersive room events and escapes every public snapshot field", () => {
    const common = {
      protocolVersion: 1 as const,
      roomId: "room-1",
      sender: HOST,
      occurredAt: "2026-08-27T12:00:00.000Z",
    };
    const events: RoomEventV1[] = [
      {
        ...common,
        eventId: "50000000-0000-4000-8000-000000000001",
        sequence: 1,
        type: "location.published",
        payload: {
          moduleId: "module-1",
          revision: 1,
          location: {
            id: "location-1",
            name: "<旧宅&别馆>",
            description: "<script>alert('location')</script>",
          },
        },
      },
      {
        ...common,
        eventId: "50000000-0000-4000-8000-000000000002",
        sequence: 2,
        sender: PLAYER,
        type: "location.entered",
        payload: {
          moduleId: "module-1",
          revision: 1,
          locationId: "location-1",
          locationName: "<旧宅&别馆>",
          characterId: CHARACTER.id,
          characterName: "*林若岚*",
        },
      },
      {
        ...common,
        eventId: "50000000-0000-4000-8000-000000000003",
        sequence: 3,
        type: "npc.published",
        payload: {
          moduleId: "module-1",
          revision: 1,
          locationId: "location-1",
          locationName: "<旧宅&别馆>",
          npc: { id: "npc-1", name: "<管家>", description: "Tom & Jerry" },
        },
      },
      {
        ...common,
        eventId: "50000000-0000-4000-8000-000000000004",
        sequence: 4,
        type: "content.revealed",
        payload: {
          moduleId: "module-1",
          revision: 1,
          contentId: "clue-1",
          contentType: "clue",
          title: "线索",
          body: "正文",
          locationId: "location-1",
        },
      },
    ];

    const markdown = exportEventsToMarkdown(events, { generatedAt: "2026-08-27T13:00:00.000Z" });
    expect(markdown).toContain("公开地点");
    expect(markdown).toContain("NPC 登场");
    expect(markdown).toContain("&lt;旧宅&amp;别馆&gt;");
    expect(markdown).toContain("\\*林若岚\\*");
    expect(markdown).toContain("地点 ID：`location\\-1`");
    expect(markdown).not.toContain("<script>");

    const html = exportEventsToHtml(events, { generatedAt: "2026-08-27T13:00:00.000Z" });
    expect(html).toContain("&lt;旧宅&amp;别馆&gt;");
    expect(html).toContain("&lt;管家&gt;");
    expect(html).toContain("Tom &amp; Jerry");
    expect(html).not.toContain("<script>alert('location')</script>");
  });
});
