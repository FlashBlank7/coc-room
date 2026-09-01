import { describe, expect, it, vi } from "vitest";
import { generateBrowserDeepSeekNpcStats } from "./browser-deepseek-npc-stats";

describe("generateBrowserDeepSeekNpcStats", () => {
  it("maps the provider draft to the executor wire shape", async () => {
    const draft = {
      characteristics: { str: 160, con: 120, siz: 150, dex: 70, int: 60, pow: 90, app: null, edu: null },
      skills: [{ name: "斗殴", value: 75 }, { name: "潜行", value: 60 }],
      hitPoints: 27,
      sanity: null,
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: "completed",
      output_text: JSON.stringify(draft),
    }), { status: 200 }));

    const character = await generateBrowserDeepSeekNpcStats({
      name: "地窖中的猎犬",
      description: "皮革般湿滑的巨兽。",
      guidance: "战斗轮怪物，别客气。",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Null APP/EDU/SAN vanish instead of polluting the record; skills become a map.
    expect(character).toEqual({
      characteristics: { str: 160, con: 120, siz: 150, dex: 70, int: 60, pow: 90 },
      skills: { 斗殴: 75, 潜行: 60 },
      hitPoints: 27,
    });
    const payload = JSON.parse(String((fetchImpl.mock.calls[0]! as unknown as [string, RequestInit])[1].body)) as { input: string };
    expect(JSON.parse(payload.input)).toEqual({
      name: "地窖中的猎犬",
      description: "皮革般湿滑的巨兽。",
      guidance: "战斗轮怪物，别客气。",
    });
  });
});
