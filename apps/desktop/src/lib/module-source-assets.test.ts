import { describe, expect, it } from "vitest";

import type { AssetDescriptorV1 } from "@coc-room/protocol";
import { miniModule } from "../test/scenarios/mini-investigation";
import {
  SOURCE_ATTACHMENTS_NAMESPACE,
  moduleSourceImages,
  withImportedModuleSourceImage,
} from "./module-source-assets";
import { storedCocmodContents } from "./cocmod-package";

describe("module source assets", () => {
  it("moves a validated source image into the package asset list without binding or publishing it", () => {
    const source = {
      kind: "image" as const,
      sha256: "a".repeat(64),
      mediaType: "image/png",
      byteLength: 1_024,
      width: 1_200,
      height: 800,
    };
    const modulePackage = {
      ...miniModule,
      extensions: {
        [SOURCE_ATTACHMENTS_NAMESPACE]: { status: "detected_not_imported", items: [source] },
      },
    };
    const imported: AssetDescriptorV1 = {
      schemaVersion: 1,
      assetId: `sha256:${"b".repeat(64)}`,
      mediaType: "image/webp",
      byteLength: 800,
      width: 1_200,
      height: 800,
    };

    const next = withImportedModuleSourceImage(modulePackage, source, imported);

    expect(moduleSourceImages(next)).toMatchObject({ importedCount: 1, pendingCount: 0 });
    expect(next.extensions[SOURCE_ATTACHMENTS_NAMESPACE]).toMatchObject({ status: "imported_unbound" });
    expect(storedCocmodContents(next).assets).toEqual([{ ...imported, extension: "webp" }]);
    expect(next.scenes).toEqual(modulePackage.scenes);
  });

  it("does not accept an image that was not identified by the validated parser result", () => {
    const modulePackage = {
      ...miniModule,
      extensions: {
        [SOURCE_ATTACHMENTS_NAMESPACE]: {
          status: "detected_not_imported",
          items: [{ kind: "image", sha256: "a".repeat(64), mediaType: "image/png", byteLength: 10, width: 1, height: 1 }],
        },
      },
    };
    const other = { kind: "image" as const, sha256: "c".repeat(64), mediaType: "image/png", byteLength: 10, width: 1, height: 1 };
    const imported: AssetDescriptorV1 = { schemaVersion: 1, assetId: `sha256:${"d".repeat(64)}`, mediaType: "image/webp", byteLength: 10, width: 1, height: 1 };

    expect(() => withImportedModuleSourceImage(modulePackage, other, imported)).toThrow("不在当前模组");
  });
});
