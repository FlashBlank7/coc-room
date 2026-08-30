import type { AssetDescriptorV1 } from "@coc-room/protocol";
import { describe, expect, it } from "vitest";

import { isSameAssetDescriptor } from "./asset-store";

const BASE: AssetDescriptorV1 = {
  schemaVersion: 1,
  assetId: `sha256:${"a".repeat(64)}`,
  mediaType: "image/webp",
  byteLength: 128,
  width: 8,
  height: 8,
};

describe("managed asset descriptor equality", () => {
  it("rejects forged metadata even when the content hash is reused", () => {
    expect(isSameAssetDescriptor(BASE, { ...BASE })).toBe(true);
    expect(isSameAssetDescriptor(BASE, { ...BASE, mediaType: "audio/mpeg" })).toBe(false);
    expect(isSameAssetDescriptor(BASE, { ...BASE, byteLength: 127 })).toBe(false);
    expect(isSameAssetDescriptor(BASE, { ...BASE, width: 16 })).toBe(false);
    expect(isSameAssetDescriptor(BASE, { ...BASE, durationMs: 1_000 })).toBe(false);
  });
});
