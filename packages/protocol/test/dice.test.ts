import { describe, expect, it } from "vitest";

import {
  diceRollResultSchema,
  parseDiceExpression,
  resolveCheck,
  rollDice,
  rollPercentile,
  type RandomIntSource,
} from "../src";

function sequenceRng(values: readonly number[]): RandomIntSource {
  let index = 0;
  return (maxExclusive) => {
    const value = values[index++];
    if (value === undefined) throw new Error("test RNG exhausted");
    expect(value).toBeLessThan(maxExclusive);
    return value;
  };
}

describe("dice expressions", () => {
  it("parses and normalizes ordinary notation", () => {
    expect(parseDiceExpression(" 2D6 + 3 ")).toEqual({
      normalized: "2d6+3",
      count: 2,
      sides: 6,
      modifier: 3,
    });
    expect(() => parseDiceExpression("0d6")).toThrow(/count/i);
    expect(() => parseDiceExpression("2d1")).toThrow(/sides/i);
  });

  it("rolls ordinary dice with an injectable RNG", () => {
    expect(rollDice("2d6+3", { rng: sequenceRng([0, 5]) })).toEqual({
      kind: "standard",
      expression: "2d6+3",
      count: 2,
      sides: 6,
      modifier: 3,
      rolls: [1, 6],
      total: 10,
    });
  });
});

describe("CoC 7e percentile checks", () => {
  it("selects the lower bonus candidate and higher penalty candidate", () => {
    const bonus = rollPercentile({ bonusDice: 1, rng: sequenceRng([5, 7, 2]) });
    expect(bonus.candidates).toEqual([75, 25]);
    expect(bonus.total).toBe(25);

    const penalty = rollPercentile({ penaltyDice: 1, rng: sequenceRng([5, 7, 2]) });
    expect(penalty.total).toBe(75);
  });

  it("treats 00 and 0 as 100", () => {
    expect(rollDice("d100", { rng: sequenceRng([0, 0]) }).total).toBe(100);
  });

  it("resolves critical, difficulty, failure, and fumble thresholds", () => {
    expect(resolveCheck(1, 50).outcome).toBe("critical");
    expect(resolveCheck(10, 50, { requiredDifficulty: "extreme" })).toMatchObject({
      outcome: "extreme",
      success: true,
    });
    expect(resolveCheck(20, 50, { requiredDifficulty: "extreme" })).toMatchObject({
      outcome: "hard",
      success: false,
    });
    expect(resolveCheck(96, 49).outcome).toBe("fumble");
    expect(resolveCheck(96, 50).outcome).toBe("failure");
    expect(resolveCheck(100, 90).outcome).toBe("fumble");
  });

  it("rejects mutually exclusive bonus and penalty dice", () => {
    expect(() => rollPercentile({ bonusDice: 1, penaltyDice: 1 })).toThrow(/cannot/i);
  });

  it("rejects internally inconsistent wire results", () => {
    expect(
      diceRollResultSchema.safeParse({
        kind: "standard",
        expression: "1d6",
        count: 1,
        sides: 6,
        modifier: 0,
        rolls: [7],
        total: 7,
      }).success,
    ).toBe(false);
  });
});
