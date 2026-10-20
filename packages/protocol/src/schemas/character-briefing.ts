import { z } from "zod";
import { entityIdSchema } from "./common.js";

/** Only KP-confirmed public guidance crosses the room boundary. Omitted limits mean no house rule configured. */
export const characterBriefingSchema = z.object({
  moduleId: entityIdSchema.optional(),
  text: z.string().max(8_000),
  characteristicBudget: z.number().int().min(1).max(800).optional(),
  characteristicMin: z.number().int().min(0).max(100).optional(),
  characteristicMax: z.number().int().min(1).max(100).optional(),
  skillBudget: z.number().int().min(0).max(10_000).optional(),
  skillMax: z.number().int().min(1).max(100).optional(),
  skillPointMode: z.literal("occupation-interest").optional(),
  occupationBudget: z.number().int().min(0).max(10_000).optional(),
  interestBudget: z.number().int().min(0).max(10_000).optional(),
  allowMythos: z.boolean().optional(),
  recommendedSkills: z.array(z.string().trim().min(1).max(120)).max(40),
}).strict().superRefine((rules, context) => {
  if ((rules.characteristicMin ?? 0) > (rules.characteristicMax ?? 100)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["characteristicMin"], message: "属性下限不能高于上限" });
});
export type CharacterBriefingV1 = z.infer<typeof characterBriefingSchema>;
