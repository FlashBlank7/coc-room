import { describe, expect, it, vi } from "vitest";
import { coc7CharacterSchema } from "@coc-room/protocol";
import {
  BrowserDeepSeekError,
  generateBrowserDeepSeekCharacterDraft,
} from "./browser-deepseek-character-draft";

const providerDraft = {
  name: "陈默",
  occupation: "图书馆管理员",
  age: 29,
  residence: "上海",
  birthplace: "宁波",
  characteristics: { str: 45, con: 55, siz: 50, dex: 60, app: 55, int: 75, pow: 60, edu: 80, luck: 50 },
  skills: [
    { name: "图书馆使用", specialization: null, baseValue: 20, value: 70, checked: false },
    { name: "克苏鲁神话", specialization: null, baseValue: 0, value: 5, checked: false },
  ],
  inventory: [{ name: "黄铜书签", quantity: 1, description: "", equipped: false }],
  background: {
    personalDescription: "安静而好奇。",
    ideologyAndBeliefs: "知识应当被守护。",
    significantPeople: "",
    meaningfulLocations: "",
    treasuredPossessions: "",
    traits: "谨慎",
    injuriesAndScars: "",
    phobiasAndManias: "",
    arcaneTomesSpellsAndArtifacts: "",
    encountersWithStrangeEntities: "",
  },
  notes: "",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("generateBrowserDeepSeekCharacterDraft", () => {
  it("builds a schema-valid investigator with derived stats from a responses body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "completed", output_text: JSON.stringify(providerDraft) }));
    const character = await generateBrowserDeepSeekCharacterDraft({
      prompt: "1920 年代的图书馆管理员",
      playerName: "Alice",
      ownerSeatId: "seat-player-1",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(() => coc7CharacterSchema.parse(character)).not.toThrow();
    expect(character.ownerPeerId).toBe("seat-player-1");
    expect(character.playerName).toBe("Alice");
    // CoC 7e derivation: HP=(CON+SIZ)/10, MP=POW/5, SAN=POW, maxSAN=99-神话.
    expect(character.derived).toMatchObject({
      maxHitPoints: 10,
      maxMagicPoints: 12,
      sanity: 60,
      maxSanity: 94,
      damageBonus: "0",
    });

    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/responses");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const payload = JSON.parse(String(init.body)) as { model: string; input: string };
    expect(payload.model).toBe("deepseek-v4-flash");
    expect(JSON.parse(payload.input)).toEqual({ prompt: "1920 年代的图书馆管理员", playerName: "Alice" });
  });

  it("also accepts a chat-completions style body with fenced JSON", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: "```json\n" + JSON.stringify(providerDraft) + "\n```" } }],
    }));
    const character = await generateBrowserDeepSeekCharacterDraft({
      prompt: "p",
      playerName: "Alice",
      ownerSeatId: "seat-player-1",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(character.name).toBe("陈默");
  });

  it("reports a bad key in plain words", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(generateBrowserDeepSeekCharacterDraft({
      prompt: "p",
      playerName: "Alice",
      ownerSeatId: "seat-player-1",
      apiKey: "sk-bad",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/拒绝了这个 API Key/);
  });

  it("flags truncated responses as retryable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }));
    const attempt = generateBrowserDeepSeekCharacterDraft({
      prompt: "p",
      playerName: "Alice",
      ownerSeatId: "seat-player-1",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(attempt).rejects.toSatisfy((error: unknown) =>
      error instanceof BrowserDeepSeekError && error.retryable);
  });
});
