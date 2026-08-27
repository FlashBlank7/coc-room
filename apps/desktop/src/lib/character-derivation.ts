import type {
  Coc7Characteristics,
  Coc7DerivedStats,
  Coc7Skill,
} from "@coc-room/protocol";

export interface Coc7DerivationInput {
  characteristics: Coc7Characteristics;
  age: number;
  skills: readonly Coc7Skill[];
  current?: Pick<Coc7DerivedStats, "hitPoints" | "magicPoints" | "sanity">;
}

/**
 * Recalculate the CoC 7e derived values that follow directly from a character
 * sheet. Current resources are deliberately preserved and only clamped when a
 * recalculation lowers their maximum; changing POW must not heal MP or SAN.
 */
export function deriveCoc7Stats(input: Coc7DerivationInput): Coc7DerivedStats {
  const { characteristics, skills } = input;
  const maxHitPoints = Math.floor((characteristics.con + characteristics.siz) / 10);
  const maxMagicPoints = Math.floor(characteristics.pow / 5);
  const maxSanity = Math.max(0, 99 - findCthulhuMythos(skills));
  const movementRate = calculateMovementRate(characteristics, input.age);
  const { build, damageBonus } = calculateBuild(characteristics.str + characteristics.siz);

  return {
    hitPoints: clampInteger(input.current?.hitPoints ?? maxHitPoints, 0, maxHitPoints),
    maxHitPoints,
    magicPoints: clampInteger(input.current?.magicPoints ?? maxMagicPoints, 0, maxMagicPoints),
    maxMagicPoints,
    sanity: clampInteger(input.current?.sanity ?? characteristics.pow, 0, maxSanity),
    maxSanity,
    movementRate,
    build,
    damageBonus,
  };
}

export function calculateMovementRate(
  characteristics: Pick<Coc7Characteristics, "str" | "siz" | "dex">,
  age: number,
): number {
  let movementRate = 8;
  if (characteristics.str < characteristics.siz && characteristics.dex < characteristics.siz) {
    movementRate = 7;
  } else if (characteristics.str > characteristics.siz && characteristics.dex > characteristics.siz) {
    movementRate = 9;
  }

  const normalizedAge = Number.isFinite(age) ? Math.trunc(age) : 15;
  const agePenalty = normalizedAge >= 40
    ? Math.min(5, Math.floor(normalizedAge / 10) - 3)
    : 0;
  return Math.max(0, movementRate - agePenalty);
}

export function calculateBuild(strengthAndSize: number): Pick<Coc7DerivedStats, "build" | "damageBonus"> {
  if (strengthAndSize <= 64) return { build: -2, damageBonus: "-2" };
  if (strengthAndSize <= 84) return { build: -1, damageBonus: "-1" };
  if (strengthAndSize <= 124) return { build: 0, damageBonus: "0" };
  if (strengthAndSize <= 164) return { build: 1, damageBonus: "+1d4" };
  if (strengthAndSize <= 204) return { build: 2, damageBonus: "+1d6" };
  if (strengthAndSize <= 284) return { build: 3, damageBonus: "+2d6" };
  if (strengthAndSize <= 364) return { build: 4, damageBonus: "+3d6" };
  return { build: 5, damageBonus: "+4d6" };
}

export function findCthulhuMythos(skills: readonly Coc7Skill[]): number {
  return skills.reduce((highest, skill) => {
    const normalized = `${skill.name} ${skill.specialization ?? ""}`
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .replace(/[^\p{L}\p{N}]+/gu, "");
    const isMythos = normalized.includes("克苏鲁神话")
      || (normalized.includes("cthulhu") && normalized.includes("mythos"));
    return isMythos ? Math.max(highest, skill.value) : highest;
  }, 0);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  const finite = Number.isFinite(value) ? Math.trunc(value) : minimum;
  return Math.min(maximum, Math.max(minimum, finite));
}
