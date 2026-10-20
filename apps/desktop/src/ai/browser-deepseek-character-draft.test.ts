import { describe, expect, it, vi } from "vitest";
import { coc7CharacterSchema } from "@coc-room/protocol";
import { prepareGeneratedCharacter } from "../lib/table-seating";
import { auditSkillAllocation, updateLinkedSkillBases } from "../lib/character-skill-allocation";
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

  it("preserves an AI allocation through the table, house-rule checks and linked attribute changes", async () => {
    const draft = { ...providerDraft, occupation: "记者", skills: [
      { name: "图书馆使用", specialization: null, baseValue: 20, value: 70, checked: false },
      { name: "聆听", specialization: null, baseValue: 20, value: 35, checked: false },
      { name: "母语", specialization: "汉语", baseValue: 80, value: 85, baseSource: "edu", checked: false },
    ], creation: { occupationFormula: "edu4", occupationBudget: null, interestBudget: null, creditMin: null, creditMax: null, occupationSkillIndexes: [0, 2], allocations: [
      { skillIndex: 0, occupation: 40, interest: 10 }, { skillIndex: 1, occupation: 0, interest: 15 }, { skillIndex: 2, occupation: 5, interest: 0 },
    ] } };
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "completed", output_text: JSON.stringify(draft) }));
    const generated = await generateBrowserDeepSeekCharacterDraft({ prompt: "按自定义职业技能车卡", playerName: "Alice", ownerSeatId: "seat-player-1", apiKey: "sk-test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const card = prepareGeneratedCharacter(generated, { text: "自定义房规", recommendedSkills: [], skillPointMode: "occupation-interest" });
    expect(card.creation).toEqual(generated.creation);
    expect(card.creation!.origin).toBe("ai");
    expect(card.creation!.occupationSkillIds).toEqual([card.skills[0]!.id, card.skills[2]!.id]);
    expect(auditSkillAllocation(card)).toMatchObject({ occupation: 320, interest: 150, occupationSpent: 45, interestSpent: 25, issues: [] });
    expect(auditSkillAllocation(card, { text: "更紧的房规", recommendedSkills: [], occupationBudget: 40, interestBudget: 20 }).issues).toEqual(["职业点超出 5 点，请减少职业投入。", "兴趣点超出 5 点，请减少兴趣投入。"]);
    expect(updateLinkedSkillBases({ ...card, characteristics: { ...card.characteristics, edu: 85 } }).skills[2]).toMatchObject({ baseValue: 85, value: 90 });
    expect(coc7CharacterSchema.parse(JSON.parse(JSON.stringify(card))).creation).toEqual(card.creation);
  });

  it("rejects duplicate or missing skill allocation references before creating a card", async () => {
    const creation = { occupationFormula: "edu4", occupationSkillIndexes: [0], allocations: [{ skillIndex: 0, occupation: 40, interest: 10 }, { skillIndex: 0, occupation: 0, interest: 5 }] };
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "completed", output_text: JSON.stringify({ ...providerDraft, creation }) }));
    await expect(generateBrowserDeepSeekCharacterDraft({ prompt: "p", playerName: "Alice", ownerSeatId: "seat-player-1", apiKey: "sk-test", fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow("每个技能都需要一条独立分配记录");
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
