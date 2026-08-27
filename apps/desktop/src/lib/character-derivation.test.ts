import { describe, expect, it } from "vitest";
import type { Coc7Characteristics, Coc7Skill } from "@coc-room/protocol";
import {
  calculateBuild,
  calculateMovementRate,
  deriveCoc7Stats,
  findCthulhuMythos,
} from "./character-derivation";

const characteristics: Coc7Characteristics = {
  str: 50,
  con: 50,
  siz: 50,
  dex: 50,
  app: 50,
  int: 50,
  pow: 50,
  edu: 50,
  luck: 50,
};

describe("deriveCoc7Stats", () => {
  it("derives the standard maxima and initializes current resources", () => {
    expect(deriveCoc7Stats({ characteristics, age: 25, skills: [] })).toEqual({
      hitPoints: 10,
      maxHitPoints: 10,
      magicPoints: 10,
      maxMagicPoints: 10,
      sanity: 50,
      maxSanity: 99,
      movementRate: 8,
      build: 0,
      damageBonus: "0",
    });
  });

  it("preserves spent resources and clamps only values above a new maximum", () => {
    const next = deriveCoc7Stats({
      characteristics: { ...characteristics, con: 30, siz: 40, pow: 35 },
      age: 25,
      skills: [skill("克苏鲁神话", 42)],
      current: { hitPoints: 8, magicPoints: 9, sanity: 80 },
    });

    expect(next).toMatchObject({
      hitPoints: 7,
      maxHitPoints: 7,
      magicPoints: 7,
      maxMagicPoints: 7,
      sanity: 57,
      maxSanity: 57,
    });
  });

  it("does not refill resources when their recalculated maximum increases", () => {
    const next = deriveCoc7Stats({
      characteristics: { ...characteristics, con: 70, siz: 50, pow: 70 },
      age: 25,
      skills: [],
      current: { hitPoints: 4, magicPoints: 3, sanity: 31 },
    });

    expect(next).toMatchObject({
      hitPoints: 4,
      maxHitPoints: 12,
      magicPoints: 3,
      maxMagicPoints: 14,
      sanity: 31,
      maxSanity: 99,
    });
  });
});

describe("movement, build and Mythos rules", () => {
  it("compares STR and DEX with SIZ, then applies the age-band penalty", () => {
    expect(calculateMovementRate({ str: 40, dex: 40, siz: 50 }, 39)).toBe(7);
    expect(calculateMovementRate({ str: 60, dex: 60, siz: 50 }, 40)).toBe(8);
    expect(calculateMovementRate({ str: 50, dex: 60, siz: 50 }, 80)).toBe(3);
  });

  it.each([
    [64, -2, "-2"],
    [65, -1, "-1"],
    [85, 0, "0"],
    [125, 1, "+1d4"],
    [165, 2, "+1d6"],
    [205, 3, "+2d6"],
  ] as const)("maps STR + SIZ %i to build %i", (total, build, damageBonus) => {
    expect(calculateBuild(total)).toEqual({ build, damageBonus });
  });

  it("recognizes Chinese and flexible English Cthulhu Mythos names", () => {
    expect(findCthulhuMythos([
      skill("克苏鲁神话学", 12),
      skill("Mythos, Cthulhu", 23),
      skill("Occult", 80),
    ])).toBe(23);
  });
});

function skill(name: string, value: number): Coc7Skill {
  return {
    id: `skill-${name.replace(/\W+/g, "-")}`,
    name,
    baseValue: 0,
    value,
    checked: false,
  };
}
