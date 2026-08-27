import { z } from "zod";

import {
  entityIdSchema,
  extensionsSchema,
  isoDateTimeSchema,
  peerIdSchema,
} from "./common.js";

const characteristicSchema = z.number().int().min(0).max(100);

export const coc7CharacteristicsSchema = z
  .object({
    str: characteristicSchema,
    con: characteristicSchema,
    siz: characteristicSchema,
    dex: characteristicSchema,
    app: characteristicSchema,
    int: characteristicSchema,
    pow: characteristicSchema,
    edu: characteristicSchema,
    luck: characteristicSchema,
  })
  .strict();

export const coc7DerivedStatsSchema = z
  .object({
    hitPoints: z.number().int().min(0).max(99),
    maxHitPoints: z.number().int().min(0).max(99),
    magicPoints: z.number().int().min(0).max(99),
    maxMagicPoints: z.number().int().min(0).max(99),
    sanity: z.number().int().min(0).max(100),
    maxSanity: z.number().int().min(0).max(100),
    movementRate: z.number().int().min(0).max(20),
    build: z.number().int().min(-2).max(5),
    damageBonus: z.string().min(1).max(32),
  })
  .strict()
  .superRefine((stats, context) => {
    const pairs = [
      ["hitPoints", stats.hitPoints, stats.maxHitPoints],
      ["magicPoints", stats.magicPoints, stats.maxMagicPoints],
      ["sanity", stats.sanity, stats.maxSanity],
    ] as const;

    for (const [path, current, maximum] of pairs) {
      if (current > maximum) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: `${path} cannot exceed its maximum`,
        });
      }
    }
  });

export const coc7SkillSchema = z
  .object({
    id: entityIdSchema,
    name: z.string().min(1).max(120),
    specialization: z.string().min(1).max(120).optional(),
    baseValue: z.number().int().min(0).max(100),
    value: z.number().int().min(0).max(100),
    checked: z.boolean(),
  })
  .strict();

export const coc7StatusSchema = z
  .object({
    temporaryInsanity: z.boolean(),
    indefiniteInsanity: z.boolean(),
    majorWound: z.boolean(),
    dying: z.boolean(),
    unconscious: z.boolean(),
  })
  .strict();

export const coc7InventoryItemSchema = z
  .object({
    id: entityIdSchema,
    name: z.string().min(1).max(160),
    quantity: z.number().int().nonnegative(),
    description: z.string().max(4_000),
    equipped: z.boolean(),
  })
  .strict();

export const coc7BackgroundSchema = z
  .object({
    personalDescription: z.string().max(4_000),
    ideologyAndBeliefs: z.string().max(4_000),
    significantPeople: z.string().max(4_000),
    meaningfulLocations: z.string().max(4_000),
    treasuredPossessions: z.string().max(4_000),
    traits: z.string().max(4_000),
    injuriesAndScars: z.string().max(4_000),
    phobiasAndManias: z.string().max(4_000),
    arcaneTomesSpellsAndArtifacts: z.string().max(4_000),
    encountersWithStrangeEntities: z.string().max(4_000),
  })
  .strict();

export const coc7CharacterSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: entityIdSchema,
    ownerPeerId: peerIdSchema,
    name: z.string().min(1).max(160),
    playerName: z.string().min(1).max(160),
    occupation: z.string().max(160),
    age: z.number().int().min(15).max(120),
    residence: z.string().max(240),
    birthplace: z.string().max(240),
    characteristics: coc7CharacteristicsSchema,
    derived: coc7DerivedStatsSchema,
    skills: z.array(coc7SkillSchema).max(200),
    status: coc7StatusSchema,
    inventory: z.array(coc7InventoryItemSchema).max(500),
    background: coc7BackgroundSchema,
    notes: z.string().max(20_000),
    updatedAt: isoDateTimeSchema,
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((character, context) => {
    const skillIds = new Set<string>();
    character.skills.forEach((skill, index) => {
      if (skillIds.has(skill.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["skills", index, "id"],
          message: `duplicate skill id: ${skill.id}`,
        });
      }
      skillIds.add(skill.id);
    });
  });

/** Public type name used by the desktop application. */
export type Coc7Character = z.infer<typeof coc7CharacterSchema>;
export type Coc7Characteristics = z.infer<typeof coc7CharacteristicsSchema>;
export type Coc7DerivedStats = z.infer<typeof coc7DerivedStatsSchema>;
export type Coc7Skill = z.infer<typeof coc7SkillSchema>;
