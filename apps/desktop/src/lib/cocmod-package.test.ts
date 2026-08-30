import type { ModulePackageV1 } from "@coc-room/protocol";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  createCocmodPackage,
  parseCocmodPackage,
  parseLegacyCocmodJson,
  storedCocmodContents,
  withStoredCocmodContents,
} from "./cocmod-package";

describe(".cocmod package", () => {
  it("round-trips a text-only module with explicit empty resource directories", async () => {
    const modulePackage = fixtureModule();
    const bytes = await createCocmodPackage(modulePackage);
    const imported = await parseCocmodPackage(bytes);

    expect(imported.module).toEqual(modulePackage);
    expect(imported.boards).toEqual([]);
    expect(imported.assets).toEqual([]);
  });

  it("verifies and round-trips board documents and content-addressed assets", async () => {
    const assetBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
    ]);
    const hash = await digestHex(assetBytes);
    const board = {
      schemaVersion: 1 as const,
      boardId: "board-1",
      revision: 1,
      kind: "evidence" as const,
      name: "线索板",
      description: "",
      audience: { kind: "room" as const },
      logicalSize: { width: 10_000, height: 10_000 },
      archived: false,
      items: [],
      edges: [],
      extensions: {},
    };
    const bytes = await createCocmodPackage(fixtureModule(), {
      boards: [{ id: "board-1", value: board }],
      assets: [{
        schemaVersion: 1,
        assetId: `sha256:${hash}`,
        mediaType: "image/webp",
        byteLength: assetBytes.byteLength,
        width: 1,
        height: 1,
        extension: ".webp",
        bytes: assetBytes,
      }],
    });
    const imported = await parseCocmodPackage(bytes);

    expect(imported.boards).toEqual([{ id: "board-1", value: board }]);
    expect(imported.assets[0]).toMatchObject({
      assetId: `sha256:${hash}`,
      mediaType: "image/webp",
      extension: "webp",
    });
    expect(imported.assets[0]?.bytes).toEqual(assetBytes);

    const stored = withStoredCocmodContents(imported.module, {
      boards: imported.boards,
      assets: imported.assets.map(({ bytes: _bytes, ...asset }) => asset),
    });
    expect(storedCocmodContents(stored)).toEqual({
      boards: imported.boards,
      assets: imported.assets.map(({ bytes: _bytes, ...asset }) => asset),
    });
  });

  it("keeps legacy JSON import-only compatibility", () => {
    const modulePackage = fixtureModule();
    expect(parseLegacyCocmodJson(JSON.stringify(modulePackage))).toEqual(modulePackage);
  });

  it("rejects traversal entries before extracting", async () => {
    const malicious = zipSync({
      "../escape.json": strToU8("{}"),
      "manifest.json": strToU8("{}"),
    });
    await expect(parseCocmodPackage(malicious)).rejects.toThrow(/unsafe package path/i);
  });

  it("rejects encrypted and symbolic-link central-directory entries before extracting", async () => {
    const base = zipSync({
      "manifest.json": strToU8("{}"),
      "module.json": strToU8("{}"),
    });
    const encrypted = base.slice();
    const encryptedDirectory = firstCentralDirectoryOffset(encrypted);
    const encryptedView = new DataView(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
    encryptedView.setUint16(encryptedDirectory + 8, encryptedView.getUint16(encryptedDirectory + 8, true) | 1, true);
    await expect(parseCocmodPackage(encrypted)).rejects.toThrow(/Encrypted ZIP entries/i);

    const symlink = base.slice();
    const symlinkDirectory = firstCentralDirectoryOffset(symlink);
    new DataView(symlink.buffer, symlink.byteOffset, symlink.byteLength)
      .setUint32(symlinkDirectory + 38, 0xa0000000, true);
    await expect(parseCocmodPackage(symlink)).rejects.toThrow(/Symbolic links/i);
  });

  it("rejects duplicate paths even when they differ only by case", async () => {
    const duplicate = zipSync({
      "manifest.json": strToU8("{}"),
      "MANIFEST.JSON": strToU8("{}"),
    });
    await expect(parseCocmodPackage(duplicate)).rejects.toThrow(/Duplicate package path/i);
  });

  it("rejects a high-ratio decompression bomb from central-directory metadata", async () => {
    const bomb = zipSync({ "manifest.json": new Uint8Array(11 * 1024 * 1024) }, { level: 9 });
    await expect(parseCocmodPackage(bomb)).rejects.toThrow(/compression ratio/i);
  });

  it("rejects assets whose declared digest is not their content digest", async () => {
    await expect(createCocmodPackage(fixtureModule(), {
      assets: [{
        schemaVersion: 1,
        assetId: `sha256:${"0".repeat(64)}`,
        mediaType: "audio/mpeg",
        byteLength: 3,
        extension: "mp3",
        bytes: new Uint8Array([1, 2, 3]),
      }],
    })).rejects.toThrow(/SHA-256/i);
  });

  it("rejects an asset whose declared MIME does not match its bytes", async () => {
    const fakeWebp = new TextEncoder().encode("this is not a WebP image");
    const hash = await digestHex(fakeWebp);
    await expect(createCocmodPackage(fixtureModule(), {
      assets: [{
        schemaVersion: 1,
        assetId: `sha256:${hash}`,
        mediaType: "image/webp",
        byteLength: fakeWebp.byteLength,
        width: 1,
        height: 1,
        extension: "webp",
        bytes: fakeWebp,
      }],
    })).rejects.toThrow(/MIME\/extension/i);
  });

  it("rejects trailing bytes outside the ZIP end-of-directory record", async () => {
    const valid = await createCocmodPackage(fixtureModule());
    const tampered = new Uint8Array(valid.byteLength + 1);
    tampered.set(valid);
    tampered[tampered.length - 1] = 0x41;

    await expect(parseCocmodPackage(tampered)).rejects.toThrow(/trailing ZIP data/i);
  });

  it("rejects audio larger than the native 64 MiB asset limit before hashing", async () => {
    const oversized = new Uint8Array(64 * 1024 * 1024 + 1);
    await expect(createCocmodPackage(fixtureModule(), {
      assets: [{
        schemaVersion: 1,
        assetId: `sha256:${"0".repeat(64)}`,
        mediaType: "audio/mpeg",
        byteLength: oversized.byteLength,
        extension: "mp3",
        bytes: oversized,
      }],
    })).rejects.toThrow(/64 MiB/i);
  });
});

function fixtureModule(): ModulePackageV1 {
  return {
    schemaVersion: 1,
    moduleId: "module-package-test",
    revision: 1,
    metadata: {
      title: "Package test",
      authors: [],
      language: "zh-CN",
      summary: "",
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    },
    overview: "",
    sourceDocuments: [],
    chapters: [],
    scenes: [],
    locations: [],
    npcs: [],
    clues: [],
    handouts: [],
    suggestedChecks: [],
    keeperNotes: [],
    relations: [],
    extensions: {},
  };
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function firstCentralDirectoryOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) return offset;
  }
  throw new Error("fixture ZIP has no central directory");
}
