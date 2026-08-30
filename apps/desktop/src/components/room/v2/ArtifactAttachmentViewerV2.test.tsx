// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  type AssetDescriptorV1,
  type RoomArtifactV2,
  type RoomEntityV2,
} from "@coc-room/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ArtifactAttachmentViewerV2,
  VisibleEntityArtifactMediaV2,
} from "./ArtifactAttachmentViewerV2";

afterEach(cleanup);

describe("ArtifactAttachmentViewerV2", () => {
  it("never resolves an entity artifact that is absent from the projected world", async () => {
    const visibleImage = asset("1", "image/webp");
    const hiddenImage = asset("2", "image/webp");
    const visibleArtifact = artifact("artifact-visible-portrait", "公开肖像", visibleImage);
    const hiddenArtifact = artifact("artifact-hidden-portrait", "秘密肖像", hiddenImage);
    const entity: RoomEntityV2 = {
      schemaVersion: 2,
      entityId: "npc-harbour-master",
      revision: 1,
      kind: "npc",
      name: "港务员",
      description: "站在登记室门前。",
      artifactIds: [visibleArtifact.artifactId, hiddenArtifact.artifactId],
      audience: { kind: "room" },
      data: {},
      extensions: {},
    };
    // The current seat's projection intentionally does not contain the secret
    // artifact, even though its opaque ID remains on the independently visible
    // entity snapshot.
    const projectedArtifacts = new Map([[visibleArtifact.artifactId, visibleArtifact]]);
    const resolveAsset = vi.fn().mockResolvedValue("blob:visible-portrait");

    render(<VisibleEntityArtifactMediaV2
      entity={entity}
      artifacts={projectedArtifacts}
      resolveAsset={resolveAsset}
    />);

    expect(await screen.findByRole("img", { name: "公开肖像，图片附件 1" })).toBeTruthy();
    await waitFor(() => expect(resolveAsset).toHaveBeenCalledOnce());
    expect(resolveAsset).toHaveBeenCalledWith(visibleImage);
    expect(resolveAsset).not.toHaveBeenCalledWith(hiddenImage);
    expect(screen.queryByLabelText("秘密肖像的附件")).toBeNull();
  });

  it("offers controls for audio and a download fallback for ordinary files", async () => {
    const audio = { ...asset("3", "audio/ogg"), durationMs: 65_000 };
    const document = asset("4", "application/pdf");
    const value: RoomArtifactV2 = {
      ...artifact("artifact-mixed-files", "访谈资料", audio),
      attachments: [audio, document],
    };
    const resolveAsset = vi.fn(async (candidate: AssetDescriptorV1) => `blob:${candidate.assetId}`);

    render(<ArtifactAttachmentViewerV2 artifact={value} resolveAsset={resolveAsset} />);

    expect(await screen.findByLabelText("访谈资料，音频附件 1")).toBeTruthy();
    expect(screen.getByRole("link", { name: "下载音频" }).getAttribute("download")).toBe("访谈资料-1.ogg");
    expect(screen.getByRole("link", { name: "打开或下载文件" }).getAttribute("download")).toBe("访谈资料-2.pdf");
  });
});

function artifact(artifactId: string, title: string, attachment: AssetDescriptorV1): RoomArtifactV2 {
  return {
    schemaVersion: 2,
    artifactId,
    revision: 1,
    kind: "image",
    title,
    description: "",
    body: "",
    attachments: [attachment],
    audience: { kind: "room" },
    locked: true,
    archived: false,
    extensions: {},
  };
}

function asset(hex: string, mediaType: string): AssetDescriptorV1 {
  return {
    schemaVersion: 1,
    assetId: `sha256:${hex.repeat(64)}`,
    mediaType,
    byteLength: 4_096,
    ...(mediaType.startsWith("image/") ? { width: 640, height: 480 } : {}),
  };
}
