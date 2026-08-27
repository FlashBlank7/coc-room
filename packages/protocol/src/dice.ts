import { z } from "zod";

export type RandomIntSource = (maxExclusive: number) => number;
export type CheckDifficulty = "regular" | "hard" | "extreme";
export type CheckOutcome =
  | "critical"
  | "extreme"
  | "hard"
  | "regular"
  | "failure"
  | "fumble";

export interface ParsedDiceExpression {
  readonly normalized: string;
  readonly count: number;
  readonly sides: number;
  readonly modifier: number;
}

export const checkResolutionSchema = z
  .object({
    roll: z.number().int().min(1).max(100),
    target: z.number().int().min(1).max(100),
    requiredDifficulty: z.enum(["regular", "hard", "extreme"]),
    outcome: z.enum(["critical", "extreme", "hard", "regular", "failure", "fumble"]),
    success: z.boolean(),
    thresholds: z
      .object({
        regular: z.number().int().min(1).max(100),
        hard: z.number().int().min(0).max(50),
        extreme: z.number().int().min(0).max(20),
      })
      .strict(),
  })
  .strict()
  .superRefine((check, context) => {
    const expected = {
      regular: check.target,
      hard: Math.floor(check.target / 2),
      extreme: Math.floor(check.target / 5),
    };
    for (const key of ["regular", "hard", "extreme"] as const) {
      if (check.thresholds[key] !== expected[key]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["thresholds", key],
          message: `${key} threshold is inconsistent with target`,
        });
      }
    }
  });

export const standardDiceResultSchema = z
  .object({
    kind: z.literal("standard"),
    expression: z.string(),
    count: z.number().int().min(1).max(100),
    sides: z.number().int().min(2).max(1_000),
    modifier: z.number().int().min(-100_000).max(100_000),
    rolls: z.array(z.number().int().positive()).min(1).max(100),
    total: z.number().int(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.rolls.length !== result.count) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rolls"],
        message: "roll count does not match expression count",
      });
    }
    result.rolls.forEach((roll, index) => {
      if (roll > result.sides) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rolls", index],
          message: "roll exceeds die sides",
        });
      }
    });
    const expectedTotal = result.rolls.reduce((sum, roll) => sum + roll, result.modifier);
    if (result.total !== expectedTotal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["total"],
        message: "total is inconsistent with rolls and modifier",
      });
    }
  });

export const percentileDiceResultSchema = z
  .object({
    kind: z.literal("percentile"),
    expression: z.literal("1d100"),
    bonusDice: z.number().int().min(0).max(2),
    penaltyDice: z.number().int().min(0).max(2),
    unitsDie: z.number().int().min(0).max(9),
    tensDice: z.array(z.number().int().min(0).max(9)).min(1).max(3),
    candidates: z.array(z.number().int().min(1).max(100)).min(1).max(3),
    total: z.number().int().min(1).max(100),
    check: checkResolutionSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.bonusDice > 0 && result.penaltyDice > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["penaltyDice"],
        message: "bonusDice and penaltyDice cannot both be positive",
      });
    }
    const expectedLength = 1 + result.bonusDice + result.penaltyDice;
    if (result.tensDice.length !== expectedLength || result.candidates.length !== expectedLength) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates"],
        message: "candidate count is inconsistent with bonus and penalty dice",
      });
    }
    const expectedCandidates = result.tensDice.map((tens) => {
      const candidate = tens * 10 + result.unitsDie;
      return candidate === 0 ? 100 : candidate;
    });
    if (expectedCandidates.some((candidate, index) => result.candidates[index] !== candidate)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates"],
        message: "candidates are inconsistent with tens and units dice",
      });
    }
    const expectedTotal =
      result.bonusDice > 0
        ? Math.min(...expectedCandidates)
        : result.penaltyDice > 0
          ? Math.max(...expectedCandidates)
          : expectedCandidates[0];
    if (result.total !== expectedTotal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["total"],
        message: "total is inconsistent with percentile candidates",
      });
    }
    if (result.check !== undefined && result.check.roll !== result.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["check", "roll"],
        message: "check roll must match percentile total",
      });
    }
  });

export const diceRollResultSchema = z.union([
  standardDiceResultSchema,
  percentileDiceResultSchema,
]);

export type CheckResolution = z.infer<typeof checkResolutionSchema>;
export type StandardDiceResult = z.infer<typeof standardDiceResultSchema>;
export type PercentileDiceResult = z.infer<typeof percentileDiceResultSchema>;
export type DiceRollResult = z.infer<typeof diceRollResultSchema>;

const DICE_EXPRESSION = /^(\d*)d(\d+)([+-]\d+)?$/i;

export function parseDiceExpression(expression: string): ParsedDiceExpression {
  const compact = expression.replace(/\s+/g, "");
  const match = DICE_EXPRESSION.exec(compact);
  if (match === null) {
    throw new Error(`Invalid dice expression: ${expression}`);
  }

  const count = match[1] === "" ? 1 : Number(match[1]);
  const sides = Number(match[2]);
  const modifier = match[3] === undefined ? 0 : Number(match[3]);

  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new RangeError("Dice count must be an integer between 1 and 100");
  }
  if (!Number.isSafeInteger(sides) || sides < 2 || sides > 1_000) {
    throw new RangeError("Die sides must be an integer between 2 and 1000");
  }
  if (!Number.isSafeInteger(modifier) || Math.abs(modifier) > 100_000) {
    throw new RangeError("Dice modifier must be an integer between -100000 and 100000");
  }

  const modifierSuffix = modifier === 0 ? "" : modifier > 0 ? `+${modifier}` : String(modifier);
  return {
    normalized: `${count}d${sides}${modifierSuffix}`,
    count,
    sides,
    modifier,
  };
}

/**
 * Cryptographically secure, unbiased integer generation for browser, Worker, and
 * Tauri webview runtimes. Tests should inject a deterministic RandomIntSource.
 */
export const secureRandomInt: RandomIntSource = (maxExclusive) => {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 0x1_0000_0000) {
    throw new RangeError("maxExclusive must be an integer between 1 and 2^32");
  }
  if (globalThis.crypto?.getRandomValues === undefined) {
    throw new Error("A Web Crypto implementation is required for secure dice rolls");
  }

  const range = 0x1_0000_0000;
  const cutoff = range - (range % maxExclusive);
  const buffer = new Uint32Array(1);
  do {
    globalThis.crypto.getRandomValues(buffer);
  } while ((buffer[0] ?? range) >= cutoff);
  return (buffer[0] ?? 0) % maxExclusive;
};

function nextRandom(rng: RandomIntSource, maxExclusive: number): number {
  const value = rng(maxExclusive);
  if (!Number.isSafeInteger(value) || value < 0 || value >= maxExclusive) {
    throw new RangeError(`Random source must return an integer in [0, ${maxExclusive})`);
  }
  return value;
}

export interface ResolveCheckOptions {
  readonly requiredDifficulty?: CheckDifficulty;
}

export function resolveCheck(
  roll: number,
  target: number,
  options: ResolveCheckOptions = {},
): CheckResolution {
  if (!Number.isInteger(roll) || roll < 1 || roll > 100) {
    throw new RangeError("roll must be an integer between 1 and 100");
  }
  if (!Number.isInteger(target) || target < 1 || target > 100) {
    throw new RangeError("target must be an integer between 1 and 100");
  }

  const thresholds = {
    regular: target,
    hard: Math.floor(target / 2),
    extreme: Math.floor(target / 5),
  };
  const requiredDifficulty = options.requiredDifficulty ?? "regular";

  let outcome: CheckOutcome;
  if (roll === 1) {
    outcome = "critical";
  } else if (roll === 100 || (target < 50 && roll >= 96)) {
    outcome = "fumble";
  } else if (roll <= thresholds.extreme) {
    outcome = "extreme";
  } else if (roll <= thresholds.hard) {
    outcome = "hard";
  } else if (roll <= thresholds.regular) {
    outcome = "regular";
  } else {
    outcome = "failure";
  }

  const outcomeRank: Record<CheckOutcome, number> = {
    critical: 4,
    extreme: 3,
    hard: 2,
    regular: 1,
    failure: 0,
    fumble: 0,
  };
  const requiredRank: Record<CheckDifficulty, number> = {
    regular: 1,
    hard: 2,
    extreme: 3,
  };

  return {
    roll,
    target,
    requiredDifficulty,
    outcome,
    success: outcomeRank[outcome] >= requiredRank[requiredDifficulty],
    thresholds,
  };
}

export interface RollPercentileOptions extends ResolveCheckOptions {
  readonly rng?: RandomIntSource;
  readonly bonusDice?: number;
  readonly penaltyDice?: number;
  readonly target?: number;
}

export function rollPercentile(options: RollPercentileOptions = {}): PercentileDiceResult {
  const rng = options.rng ?? secureRandomInt;
  const bonusDice = options.bonusDice ?? 0;
  const penaltyDice = options.penaltyDice ?? 0;

  if (!Number.isInteger(bonusDice) || bonusDice < 0 || bonusDice > 2) {
    throw new RangeError("bonusDice must be an integer between 0 and 2");
  }
  if (!Number.isInteger(penaltyDice) || penaltyDice < 0 || penaltyDice > 2) {
    throw new RangeError("penaltyDice must be an integer between 0 and 2");
  }
  if (bonusDice > 0 && penaltyDice > 0) {
    throw new Error("Bonus and penalty dice cannot be applied to the same roll");
  }

  const unitsDie = nextRandom(rng, 10);
  const extraDice = bonusDice + penaltyDice;
  const tensDice = Array.from({ length: 1 + extraDice }, () => nextRandom(rng, 10));
  const candidates = tensDice.map((tens) => {
    const value = tens * 10 + unitsDie;
    return value === 0 ? 100 : value;
  });
  const total = bonusDice > 0 ? Math.min(...candidates) : penaltyDice > 0 ? Math.max(...candidates) : candidates[0];
  if (total === undefined) {
    throw new Error("Percentile roll did not produce a candidate");
  }

  const result: PercentileDiceResult = {
    kind: "percentile",
    expression: "1d100",
    bonusDice,
    penaltyDice,
    unitsDie,
    tensDice,
    candidates,
    total,
    ...(options.target === undefined
      ? {}
      : { check: resolveCheck(total, options.target, { requiredDifficulty: options.requiredDifficulty }) }),
  };
  return percentileDiceResultSchema.parse(result);
}

export interface RollDiceOptions extends RollPercentileOptions {}

export function rollDice(expression: string, options: RollDiceOptions = {}): DiceRollResult {
  const parsed = parseDiceExpression(expression);
  const bonusDice = options.bonusDice ?? 0;
  const penaltyDice = options.penaltyDice ?? 0;

  if (parsed.count === 1 && parsed.sides === 100 && parsed.modifier === 0) {
    return rollPercentile(options);
  }
  if (bonusDice !== 0 || penaltyDice !== 0 || options.target !== undefined) {
    throw new Error("Bonus/penalty dice and CoC checks require an unmodified 1d100 expression");
  }

  const rng = options.rng ?? secureRandomInt;
  const rolls = Array.from({ length: parsed.count }, () => nextRandom(rng, parsed.sides) + 1);
  const total = rolls.reduce((sum, roll) => sum + roll, parsed.modifier);
  return standardDiceResultSchema.parse({
    kind: "standard",
    expression: parsed.normalized,
    count: parsed.count,
    sides: parsed.sides,
    modifier: parsed.modifier,
    rolls,
    total,
  });
}
