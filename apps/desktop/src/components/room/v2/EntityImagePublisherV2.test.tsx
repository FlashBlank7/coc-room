// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AssetDescriptorV1 } from "@coc-room/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EntityImagePublisherV2 } from "./EntityImagePublisherV2";

const asset: AssetDescriptorV1 = {
  schemaVersion: 1,
  assetId: `sha256:${"d".repeat(64)}`,
  mediaType: "image/webp",
  byteLength: 262_144,
  width: 800,
  height: 800,
};

afterEach(cleanup);

describe("EntityImagePublisherV2", () => {
  it("keeps the descriptor local through selection and preview, then publishes only after confirmation", async () => {
    const onPublish = vi.fn().mockResolvedValue(undefined);
    render(<EntityImagePublisherV2
      entity={{ name: "守门人" }}
      hasPublishedImage={false}
      selectAsset={vi.fn().mockResolvedValue({ asset, deduplicated: false })}
      resolvePreview={vi.fn().mockResolvedValue("blob:keeper-only-portrait")}
      onPublish={onPublish}
    />);

    expect(screen.getByText(/确认绑定并公开.*玩家不会收到这张图或它的资源描述/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "选择实体图片" }));

    const preview = await screen.findByLabelText("待绑定实体图片");
    expect(onPublish).not.toHaveBeenCalled();
    expect(preview.textContent).toContain("仅 KP 可见");
    expect(screen.getByRole("img", { name: "守门人的待绑定图片预览" }).getAttribute("src")).toBe("blob:keeper-only-portrait");

    fireEvent.click(screen.getByRole("button", { name: "确认绑定并公开" }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledWith(asset));
    expect(screen.queryByLabelText("待绑定实体图片")).toBeNull();
  });
});
