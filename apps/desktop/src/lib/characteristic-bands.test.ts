import { describe, expect, it } from "vitest";

import {
  CHARACTERISTIC_LABELS,
  describeCharacteristic,
  type CharacteristicKey,
} from "./characteristic-bands";

const KEYS = Object.keys(CHARACTERISTIC_LABELS) as CharacteristicKey[];

describe("characteristic bands", () => {
  it("describes every characteristic across the whole 0..300 range without gaps", () => {
    for (const key of KEYS) {
      for (let value = 0; value <= 300; value += 1) {
        expect(describeCharacteristic(key, value)).not.toBe("");
      }
    }
  });

  it("anchors the CoC 7e reference points", () => {
    expect(describeCharacteristic("str", 50)).toContain("普通");
    expect(describeCharacteristic("str", 99)).toContain("奥运");
    expect(describeCharacteristic("edu", 75)).toContain("大学");
    expect(describeCharacteristic("edu", 92)).toContain("博士");
    expect(describeCharacteristic("int", 90)).toBe("天才");
    expect(describeCharacteristic("siz", 65)).toContain("cm");
    expect(describeCharacteristic("siz", 45)).toContain("150");
  });

  it("keeps superhuman bands readable for published creatures", () => {
    expect(describeCharacteristic("str", 120)).toContain("超越人类");
    expect(describeCharacteristic("str", 180)).toContain("怪物");
    expect(describeCharacteristic("str", 250)).toContain("泰坦");
    expect(describeCharacteristic("siz", 160)).toContain("怪物");
    expect(describeCharacteristic("pow", 210)).toContain("神性");
  });

  it("returns empty for invalid values", () => {
    expect(describeCharacteristic("str", -1)).toBe("");
    expect(describeCharacteristic("str", Number.NaN)).toBe("");
  });
});
