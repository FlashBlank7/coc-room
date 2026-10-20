import { z } from "zod";
import characterDraftContract from "./character-draft-contract.json";
import type { Coc7Character } from "@coc-room/protocol";
import { deriveCoc7Stats } from "../lib/character-derivation";
import { BrowserDeepSeekError, callBrowserDeepSeek } from "./browser-deepseek";

export { BrowserDeepSeekError, DEFAULT_DEEPSEEK_MODEL } from "./browser-deepseek";

/**
 * Direct browser→DeepSeek character drafting for pages that have no local AI
 * channel (the deployed test site). The DeepSeek API allows cross-origin
 * browser calls, so the keeper's key — stored only in this browser — travels
 * straight to api.deepseek.com and nowhere else. The instructions, output
 * schema, and derivation rules mirror the Python sidecar's
 * character_provider.py so both paths draft identical investigators.
 */

const CHARACTER_DRAFT_INSTRUCTIONS = characterDraftContract.instructions;

const characteristicSchema = z.object({
  str: z.number().int().min(0).max(100),
  con: z.number().int().min(0).max(100),
  siz: z.number().int().min(0).max(100),
  dex: z.number().int().min(0).max(100),
  app: z.number().int().min(0).max(100),
  int: z.number().int().min(0).max(100),
  pow: z.number().int().min(0).max(100),
  edu: z.number().int().min(0).max(100),
  luck: z.number().int().min(0).max(100),
}).strict();

const skillSchema = z.object({
  name: z.string().min(1).max(120),
  specialization: z.string().min(1).max(120).nullish(),
  baseValue: z.number().int().min(0).max(100),
  baseSource: z.enum(["edu", "half-dex"]).nullish(),
  value: z.number().int().min(0).max(100),
  checked: z.boolean().default(false),
}).strict();

const inventorySchema = z.object({
  name: z.string().min(1).max(160),
  quantity: z.number().int().min(0).max(10_000),
  description: z.string().max(4_000).default(""),
  equipped: z.boolean().default(false),
}).strict();

const backgroundSchema = z.object({
  personalDescription: z.string().max(4_000).default(""),
  ideologyAndBeliefs: z.string().max(4_000).default(""),
  significantPeople: z.string().max(4_000).default(""),
  meaningfulLocations: z.string().max(4_000).default(""),
  treasuredPossessions: z.string().max(4_000).default(""),
  traits: z.string().max(4_000).default(""),
  injuriesAndScars: z.string().max(4_000).default(""),
  phobiasAndManias: z.string().max(4_000).default(""),
  arcaneTomesSpellsAndArtifacts: z.string().max(4_000).default(""),
  encountersWithStrangeEntities: z.string().max(4_000).default(""),
}).strict();

const providerOutputSchema = z.object({
  name: z.string().min(1).max(160),
  occupation: z.string().max(160).default(""),
  age: z.number().int().min(15).max(120),
  residence: z.string().max(240).default(""),
  birthplace: z.string().max(240).default(""),
  characteristics: characteristicSchema,
  skills: z.array(skillSchema).max(200).default([]),
  creation: z.object({
    occupationProfile: z.enum(["作家", "记者", "教授", "医生"]).nullish(),
    occupationFormula: z.enum(["edu4", "edu2-str2", "edu2-dex2", "edu2-app2", "edu2-pow2", "custom"]),
    occupationBudget: z.number().int().min(0).max(10000).nullish(),
    interestBudget: z.number().int().min(0).max(10000).nullish(),
    creditMin: z.number().int().min(0).max(99).nullish(),
    creditMax: z.number().int().min(0).max(99).nullish(),
    occupationSkillIndexes: z.array(z.number().int().min(0).max(199)).max(200),
    allocations: z.array(z.object({ skillIndex: z.number().int().min(0).max(199), occupation: z.number().int().min(0).max(100), interest: z.number().int().min(0).max(100) }).strict()).max(200),
  }).strict().nullish(),
  inventory: z.array(inventorySchema).max(500).default([]),
  background: backgroundSchema,
  notes: z.string().max(20_000).default(""),
}).strict().superRefine((draft, context) => {
  const plan = draft.creation;
  if (!plan) return;
  if (new Set(plan.occupationSkillIndexes).size !== plan.occupationSkillIndexes.length || plan.occupationSkillIndexes.some((index) => !draft.skills[index])) {
    context.addIssue({ code: "custom", path: ["creation", "occupationSkillIndexes"], message: "职业技能引用无效或重复" });
  }
  if (plan.allocations.length !== draft.skills.length || new Set(plan.allocations.map((item) => item.skillIndex)).size !== draft.skills.length || plan.allocations.some((item) => !draft.skills[item.skillIndex])) {
    context.addIssue({ code: "custom", path: ["creation", "allocations"], message: "每个技能都需要一条独立分配记录" });
  }
});

const OUTPUT_JSON_SCHEMA = characterDraftContract.schema;

export interface BrowserDeepSeekCharacterDraftRequest {
  prompt: string;
  playerName: string;
  ownerSeatId: string;
  apiKey: string;
  model?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export async function generateBrowserDeepSeekCharacterDraft(
  request: BrowserDeepSeekCharacterDraftRequest,
): Promise<Coc7Character> {
  const providerInput = JSON.stringify({ prompt: request.prompt, playerName: request.playerName });
  const payload = await callBrowserDeepSeek({
    apiKey: request.apiKey,
    ...(request.model === undefined ? {} : { model: request.model }),
    instructions: CHARACTER_DRAFT_INSTRUCTIONS,
    inputJson: providerInput,
    schemaName: "coc7_character_draft_v1",
    schema: OUTPUT_JSON_SCHEMA,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.fetchImpl === undefined ? {} : { fetchImpl: request.fetchImpl }),
    ...(request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl }),
  });
  const draft = providerOutputSchema.parse(payload);
  const skills = draft.skills.map((skill) => ({
    id: globalThis.crypto.randomUUID(),
    name: skill.name,
    ...(skill.specialization ? { specialization: skill.specialization } : {}),
    baseValue: skill.baseValue,
    ...(skill.baseSource ? { baseSource: skill.baseSource } : {}),
    value: skill.value,
    checked: skill.checked,
  }));
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: globalThis.crypto.randomUUID(),
    ownerPeerId: request.ownerSeatId,
    name: draft.name,
    playerName: request.playerName,
    occupation: draft.occupation,
    age: draft.age,
    residence: draft.residence,
    birthplace: draft.birthplace,
    characteristics: draft.characteristics,
    derived: deriveCoc7Stats({
      characteristics: draft.characteristics,
      age: draft.age,
      skills,
    }),
    skills,
    ...(draft.creation ? { creation: {
      origin: "ai" as const,
      ...(draft.creation.occupationProfile == null ? {} : { occupationProfile: draft.creation.occupationProfile }),
      occupationFormula: draft.creation.occupationFormula,
      ...(draft.creation.occupationBudget == null ? {} : { occupationBudget: draft.creation.occupationBudget }),
      ...(draft.creation.interestBudget == null ? {} : { interestBudget: draft.creation.interestBudget }),
      ...(draft.creation.creditMin == null ? {} : { creditMin: draft.creation.creditMin }),
      ...(draft.creation.creditMax == null ? {} : { creditMax: draft.creation.creditMax }),
      occupationSkillIds: draft.creation.occupationSkillIndexes.map((index) => skills[index]!.id),
      allocations: Object.fromEntries(draft.creation.allocations.map(({ skillIndex, occupation, interest }) => [skills[skillIndex]!.id, { occupation, interest }])),
    } } : {}),
    status: { temporaryInsanity: false, indefiniteInsanity: false, majorWound: false, dying: false, unconscious: false },
    inventory: draft.inventory.map((item) => ({
      id: globalThis.crypto.randomUUID(),
      name: item.name,
      quantity: item.quantity,
      description: item.description,
      equipped: item.equipped,
    })),
    background: draft.background,
    notes: draft.notes,
    updatedAt: now,
    extensions: {},
  };
}

