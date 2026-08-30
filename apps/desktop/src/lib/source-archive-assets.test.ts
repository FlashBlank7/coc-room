import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import type { ParserSourceAttachment } from "./module-parser";
import { extractValidatedSourceArchiveImages } from "./source-archive-assets";

describe("source archive image recovery", () => {
  it("recovers only parser-approved images by content hash without exposing archive paths", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const archive = zipSync({
      "scenario.pdf": Uint8Array.from([1, 2, 3, 4]),
      "art/cover.png": png,
      "__MACOSX/art/._cover.png": Uint8Array.from([9, 9, 9]),
    });
    const source = await metadata(png, "image/png");

    const images = await extractValidatedSourceArchiveImages(archive, [source]);

    expect(images).toHaveLength(1);
    expect(images[0]?.source).toEqual(source);
    expect(images[0]?.bytes).toEqual(png);
    expect(images[0]).not.toHaveProperty("path");
    expect(images[0]).not.toHaveProperty("name");
  });

  it("rejects a different archive instead of pairing images by filename or order", async () => {
    const approved = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const replaced = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);
    const source = await metadata(approved, "image/png");

    await expect(extractValidatedSourceArchiveImages(zipSync({ "cover.png": replaced }), [source]))
      .rejects.toThrow("解析结果不一致");
  });

  it("rejects traversal-shaped archive member names even though no files are written", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const source = await metadata(png, "image/png");

    await expect(extractValidatedSourceArchiveImages(zipSync({ "../cover.png": png }), [source]))
      .rejects.toThrow("不安全路径");
  });
});

async function metadata(bytes: Uint8Array, mediaType: ParserSourceAttachment["mediaType"]): Promise<ParserSourceAttachment> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { kind: "image", sha256, mediaType, byteLength: bytes.byteLength, width: 800, height: 600 };
}
