// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";

import type { AssetDescriptorV1 } from "@coc-room/protocol";
import { miniModule } from "../../test/scenarios/mini-investigation";
import { SOURCE_ATTACHMENTS_NAMESPACE } from "../../lib/module-source-assets";
import { ModuleSourceAssetsPanel } from "./ModuleSourceAssetsPanel";

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:source-preview") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ModuleSourceAssetsPanel", () => {
  it("requires the exact original ZIP when only path-free attachment metadata remains", async () => {
    const source = await sourceMetadata(pngBytes());
    render(<ModuleSourceAssetsPanel
      modulePackage={withSource(source)}
      onChange={vi.fn()}
    />);

    expect(screen.getByText("重新选择原 ZIP 后可预览")).toBeTruthy();
    expect((screen.getByRole("button", { name: "收入这张素材" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/收入素材不会设成背景，也不会发给玩家/)).toBeTruthy();
  });

  it("previews a hash-matched ZIP locally and imports only after explicit confirmation", async () => {
    const png = pngBytes();
    const source = await sourceMetadata(png);
    const archive = zipSync({ "scenario.pdf": Uint8Array.from([1]), "art/cover.png": png });
    const buffer = new ArrayBuffer(archive.byteLength);
    new Uint8Array(buffer).set(archive);
    const sourceFile = new File([buffer], "scenario.zip", { type: "application/zip" });
    Object.defineProperty(sourceFile, "arrayBuffer", { value: async () => buffer });
    const imported: AssetDescriptorV1 = {
      schemaVersion: 1,
      assetId: `sha256:${"b".repeat(64)}`,
      mediaType: "image/webp",
      byteLength: 100,
      width: 1_200,
      height: 800,
    };
    const onChange = vi.fn();
    const importAsset = vi.fn().mockResolvedValue({ asset: imported, deduplicated: false });
    const addReference = vi.fn().mockResolvedValue(undefined);

    render(<ModuleSourceAssetsPanel
      modulePackage={withSource(source)}
      sourceFile={sourceFile}
      onChange={onChange}
      importAsset={importAsset}
      addReference={addReference}
    />);

    expect(await screen.findByRole("img", { name: "源图片 1 预览" })).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "收入这张素材" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(importAsset).toHaveBeenCalledWith(png, "image/png");
    expect(addReference).toHaveBeenCalledWith(expect.objectContaining({ ownerType: "module", slot: `source-image:${source.sha256}` }));
    expect(onChange.mock.calls[0]?.[0].extensions[SOURCE_ATTACHMENTS_NAMESPACE]).toMatchObject({ status: "imported_unbound" });
  });
});

function withSource(source: Awaited<ReturnType<typeof sourceMetadata>>) {
  return {
    ...miniModule,
    moduleId: "module-source-assets-panel",
    extensions: {
      [SOURCE_ATTACHMENTS_NAMESPACE]: { status: "detected_not_imported", items: [source] },
    },
  };
}

function pngBytes(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
}

async function sourceMetadata(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { kind: "image" as const, sha256, mediaType: "image/png", byteLength: bytes.byteLength, width: 1_200, height: 800 };
}
