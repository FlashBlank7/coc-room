import { describe, expect, it } from "vitest";

import { exportEventsToHtml, exportEventsToMarkdown } from "../src";
import { chatEvent } from "./fixtures";

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
});
