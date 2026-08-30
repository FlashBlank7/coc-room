// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AssetDescriptorV1 } from "@coc-room/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardBackgroundPublisherV2 } from "./BoardBackgroundPublisherV2";

const asset: AssetDescriptorV1 = {
  schemaVersion: 1,
  assetId: `sha256:${"a".repeat(64)}`,
  mediaType: "image/webp",
  byteLength: 1_048_576,
  width: 1_600,
  height: 900,
};

afterEach(cleanup);

describe("BoardBackgroundPublisherV2", () => {
  it("keeps a selected image local until the keeper explicitly confirms publication", async () => {
    const onPublish = vi.fn().mockResolvedValue(undefined);
    const selectAsset = vi.fn().mockResolvedValue({ asset, deduplicated: false });
    const resolvePreview = vi.fn().mockResolvedValue("blob:local-background");

    render(<BoardBackgroundPublisherV2
      boardName="镇区地图"
      hasPublishedBackground={false}
      selectAsset={selectAsset}
      resolvePreview={resolvePreview}
      onPublish={onPublish}
    />);

    expect(screen.getByText(/点击“确认公开背景”前，玩家不会收到这张图/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "选择背景图" }));

    const preview = await screen.findByLabelText("待发布背景图");
    expect(onPublish).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(preview);
    expect(screen.getByRole("img", { name: "镇区地图的待发布背景预览" }).getAttribute("src")).toBe("blob:local-background");
    expect(preview.textContent).toContain("仅 KP 可见");
    expect(preview.textContent).toContain("1600 × 900");

    fireEvent.click(screen.getByRole("button", { name: "确认公开背景" }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledWith(asset));
    expect(screen.queryByLabelText("待发布背景图")).toBeNull();
  });

  it("can discard a local preview without publishing and restores focus", async () => {
    const onPublish = vi.fn();
    render(<BoardBackgroundPublisherV2
      boardName="旧宅"
      hasPublishedBackground
      selectAsset={vi.fn().mockResolvedValue({ asset, deduplicated: true })}
      resolvePreview={vi.fn().mockResolvedValue("blob:replacement")}
      onPublish={onPublish}
    />);

    fireEvent.click(screen.getByRole("button", { name: "选择新背景图" }));
    await screen.findByLabelText("待发布背景图");
    fireEvent.click(screen.getByRole("button", { name: "放弃预览" }));

    expect(onPublish).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("待发布背景图")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "选择新背景图" })));
  });

  it("keeps the preview available when publication fails", async () => {
    const onError = vi.fn();
    render(<BoardBackgroundPublisherV2
      boardName="剧院"
      hasPublishedBackground={false}
      selectAsset={vi.fn().mockResolvedValue({ asset, deduplicated: false })}
      resolvePreview={vi.fn().mockResolvedValue("blob:theater")}
      onPublish={vi.fn().mockRejectedValue(new Error("房间暂时离线"))}
      onError={onError}
    />);

    fireEvent.click(screen.getByRole("button", { name: "选择背景图" }));
    await screen.findByLabelText("待发布背景图");
    fireEvent.click(screen.getByRole("button", { name: "确认公开背景" }));

    expect((await screen.findByRole("alert")).textContent).toContain("背景没有公开，预览仍保留在本机");
    expect(screen.getByLabelText("待发布背景图")).toBeTruthy();
    expect(onError).toHaveBeenLastCalledWith("房间暂时离线");
  });

  it("lets the keeper preview an active-module asset without reopening the file picker", async () => {
    const selectAsset = vi.fn();
    const resolvePreview = vi.fn().mockResolvedValue("blob:module-map");
    const onPublish = vi.fn().mockResolvedValue(undefined);
    render(<BoardBackgroundPublisherV2
      boardName="终幕剧院"
      hasPublishedBackground={false}
      availableAssets={[{ asset, label: "模组图片 1 · 1600 × 900" }]}
      selectAsset={selectAsset}
      resolvePreview={resolvePreview}
      onPublish={onPublish}
    />);

    fireEvent.click(screen.getByText("从模组素材选择（1）"));
    fireEvent.click(screen.getByRole("button", { name: "预览模组素材：模组图片 1 · 1600 × 900" }));

    expect(await screen.findByLabelText("待发布背景图")).toBeTruthy();
    expect(resolvePreview).toHaveBeenCalledWith(asset);
    expect(selectAsset).not.toHaveBeenCalled();
    expect(onPublish).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认公开背景" }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledWith(asset));
  });
});
