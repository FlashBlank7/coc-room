import { describe, expect, it } from "vitest";

import { exportEventsToHtml, exportEventsToMarkdown, type RoomEventV1 } from "../src";
import { CHARACTER, PLAYER, chatEvent } from "./fixtures";

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
});
