import type { AssetDescriptorV1, Coc7Character } from "@coc-room/protocol";
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { createCoccharPackage, parseCoccharPackage } from "./cocchar-package";

describe(".cocchar package", () => {
  it("round-trips a character and keeps private notes outside the public character payload", async () => {
    const character = fixtureCharacter();
    const bytes = await createCoccharPackage({
      character,
      privateNotes: "只有玩家自己知道的秘密。",
    });
    const imported = await parseCoccharPackage(bytes);

    expect(imported.character).toEqual(character);
    expect(imported.privateNotes).toBe("只有玩家自己知道的秘密。");
    expect(imported.avatar).toBeUndefined();

    const archive = unzipSync(bytes);
    const document = JSON.parse(new TextDecoder().decode(archive["character.json"])) as Record<string, unknown>;
    expect(document).toMatchObject({
      character,
      localOnly: { privateNotes: "只有玩家自己知道的秘密。" },
    });
    expect((document.character as Record<string, unknown>)).not.toHaveProperty("privateNotes");
  });

  it("round-trips and verifies a content-addressed avatar", async () => {
    const avatarBytes = staticWebpFixture();
    const descriptor = await avatarDescriptor(avatarBytes);
    const bytes = await createCoccharPackage({
      character: fixtureCharacter(),
      privateNotes: "私人笔记",
      avatar: { descriptor, bytes: avatarBytes },
    });
    const imported = await parseCoccharPackage(bytes);

    expect(imported.avatar?.descriptor).toEqual(descriptor);
    expect(imported.avatar?.bytes).toEqual(avatarBytes);
    const hash = descriptor.assetId.slice("sha256:".length);
    expect(Object.keys(unzipSync(bytes))).toContain(`assets/sha256/${hash.slice(0, 2)}/${hash}.webp`);
  });

  it("rejects traversal entries before extracting", async () => {
    const malicious = zipSync({
      "../escape.json": strToU8("{}"),
      "manifest.json": strToU8("{}"),
    });

    await expect(parseCoccharPackage(malicious)).rejects.toThrow(/unsafe package path/i);
  });

  it("rejects an avatar whose bytes no longer match its declared hash", async () => {
    const avatarBytes = staticWebpFixture();
    const descriptor = await avatarDescriptor(avatarBytes);
    const valid = await createCoccharPackage({
      character: fixtureCharacter(),
      avatar: { descriptor, bytes: avatarBytes },
    });
    const files = unzipSync(valid);
    const avatarPath = Object.keys(files).find((path) => path.endsWith(".webp"));
    if (avatarPath === undefined) throw new Error("test package omitted avatar");
    const corrupted = new Uint8Array(files[avatarPath]!);
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0xff;
    files[avatarPath] = corrupted;

    await expect(parseCoccharPackage(zipSync(files))).rejects.toThrow(/SHA-256 hash/i);
  });

  it("rejects a structurally invalid character", async () => {
    const invalid = { ...fixtureCharacter(), age: 7 } as Coc7Character;
    await expect(createCoccharPackage({ character: invalid })).rejects.toThrow();
  });

  it("rejects an avatar whose declared MIME type does not match its bytes", async () => {
    const avatarBytes = staticWebpFixture();
    const hash = await digestHex(avatarBytes);
    const descriptor: AssetDescriptorV1 = {
      schemaVersion: 1,
      assetId: `sha256:${hash}`,
      mediaType: "image/png",
      byteLength: avatarBytes.byteLength,
      width: 1,
      height: 1,
    };

    await expect(createCoccharPackage({
      character: fixtureCharacter(),
      avatar: { descriptor, bytes: avatarBytes },
    })).rejects.toThrow(/MIME type/i);
  });
});

function fixtureCharacter(): Coc7Character {
  return {
    schemaVersion: 1,
    id: "investigator-cocchar-test",
    ownerPeerId: "player-cocchar-test",
    name: "沈雾",
    playerName: "测试玩家",
    occupation: "记者",
    age: 29,
    residence: "上海",
    birthplace: "苏州",
    characteristics: {
      str: 45,
      con: 55,
      siz: 50,
      dex: 65,
      app: 60,
      int: 75,
      pow: 70,
      edu: 80,
      luck: 55,
    },
    derived: {
      hitPoints: 10,
      maxHitPoints: 10,
      magicPoints: 14,
      maxMagicPoints: 14,
      sanity: 70,
      maxSanity: 99,
      movementRate: 8,
      build: 0,
      damageBonus: "0",
    },
    skills: [{
      id: "skill-library-use",
      name: "图书馆使用",
      baseValue: 20,
      value: 70,
      checked: false,
    }],
    status: {
      temporaryInsanity: false,
      indefiniteInsanity: false,
      majorWound: false,
      dying: false,
      unconscious: false,
    },
    inventory: [],
    background: {
      personalDescription: "总带着一本黑色笔记簿。",
      ideologyAndBeliefs: "真相应被记录。",
      significantPeople: "报社编辑",
      meaningfulLocations: "旧报社",
      treasuredPossessions: "钢笔",
      traits: "冷静",
      injuriesAndScars: "",
      phobiasAndManias: "",
      arcaneTomesSpellsAndArtifacts: "",
      encountersWithStrangeEntities: "",
    },
    notes: "这部分是可同步的公开备注。",
    updatedAt: "2026-08-29T00:00:00.000Z",
    extensions: {},
  };
}

async function avatarDescriptor(bytes: Uint8Array): Promise<AssetDescriptorV1> {
  const hash = await digestHex(bytes);
  return {
    schemaVersion: 1,
    assetId: `sha256:${hash}`,
    mediaType: "image/webp",
    byteLength: bytes.byteLength,
    width: 1,
    height: 1,
  };
}

function staticWebpFixture(): Uint8Array {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x0c, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
    0x00, 0x00, 0x00, 0x00,
  ]);
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
