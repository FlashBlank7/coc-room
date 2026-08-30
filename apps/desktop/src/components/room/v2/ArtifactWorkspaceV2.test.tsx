// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createRoomWorldStateV2,
  type AssetDescriptorV1,
  type RoomArtifactV2,
  type RoomWorldStateV2,
  type SeatV2,
} from "@coc-room/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoomCommandRejectedError, type RoomSessionV2 } from "../../../network/RoomSessionV2";
import { ArtifactWorkspaceV2 } from "./ArtifactWorkspaceV2";
import { mergeAttachmentsV2, mergeTextFieldV2 } from "./artifact-workspace-helpers";

afterEach(cleanup);

describe("ArtifactWorkspaceV2", () => {
  it("uses deterministic three-way field merging", () => {
    expect(mergeTextFieldV2("base", "base", "theirs")).toBe("theirs");
    expect(mergeTextFieldV2("base", "ours", "base")).toBe("ours");
    expect(mergeTextFieldV2("base", "same", "same")).toBe("same");
    expect(mergeTextFieldV2("base", "ours", "theirs")).toContain("另一位成员刚保存的内容");

    const base = [asset("a")];
    const ours = [...base, asset("b")];
    const theirs = [...base, asset("c")];
    expect(mergeAttachmentsV2(base, ours, theirs).map(({ assetId }) => assetId)).toEqual([
      asset("a").assetId,
      asset("b").assetId,
      asset("c").assetId,
    ]);
  });

  it("creates an attachment-only clue and retains the imported local asset", async () => {
    const image = asset("d");
    const submitConfirmed = vi.fn(async () => undefined);
    const retainAssetReference = vi.fn(async () => undefined);
    const selectAsset = vi.fn(async () => ({ asset: image, deduplicated: false }));
    const emptyWorld = createRoomWorldStateV2("room_artifact_workspace");
    const session = {
      isHost: false,
      isAuthenticated: true,
      localSeat: PLAYER,
      world: emptyWorld,
      submitConfirmed,
    } as unknown as RoomSessionV2;

    render(<ArtifactWorkspaceV2
      world={emptyWorld}
      session={session}
      listMode="supporting-materials"
      assetPickerAvailable
      selectAsset={selectAsset}
      retainAssetReference={retainAssetReference}
    />);
    fireEvent.click(screen.getByRole("button", { name: "新增线索或资料" }));
    expect(screen.getByRole("textbox", { name: "新资料标题" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "新资料正文" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加图片附件" }));
    expect(await screen.findByText(/^图片 ·/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "新资料标题" }), { target: { value: "旧照片" } });
    fireEvent.click(screen.getByRole("button", { name: "公开到调查案卷" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledOnce());
    expect(submitConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      type: "artifact.upserted",
      payload: expect.objectContaining({
        artifact: expect.objectContaining({ kind: "clue", body: "", attachments: [image] }),
      }),
    }));
    await waitFor(() => expect(retainAssetReference).toHaveBeenCalledWith(expect.objectContaining({
      assetId: image.assetId,
      ownerType: "artifact",
      ownerRevision: 1,
    })));
  });

  it("shows public clues only in the case file while keeping private clues and shared writing reachable", () => {
    const values = [
      namedArtifact("public-clue", "clue", "公开线索", { kind: "room" }),
      namedArtifact("private-clue", "clue", "我的私密线索", { kind: "seats", seatIds: [PLAYER.seatId] }),
      namedArtifact("handout", "handout", "共同手记", { kind: "room" }),
      namedArtifact("note", "note", "推理笔记", { kind: "room" }),
      namedArtifact("background", "map-background", "内部地图背景", { kind: "room" }),
    ];
    const world = {
      ...createRoomWorldStateV2("room_artifact_case_file"),
      artifacts: new Map(values.map((value) => [value.artifactId, value])),
    };

    const { unmount } = render(<ArtifactWorkspaceV2
      world={world}
      readOnly
      listMode="supporting-materials"
      heading="手记与笔记"
    />);

    expect(screen.getByLabelText("手记与笔记")).toBeTruthy();
    expect(screen.queryByText("公开线索")).toBeNull();
    expect(screen.getByText("我的私密线索")).toBeTruthy();
    expect(screen.getByText("共同手记")).toBeTruthy();
    expect(screen.getByText("推理笔记")).toBeTruthy();
    expect(screen.queryByText("内部地图背景")).toBeNull();
    expect(screen.queryByText(/handout · r\d/i)).toBeNull();
    unmount();
  });

  it("keeps an attachment card understandable when projected media cannot be resolved", async () => {
    const image = asset("e");
    const attachmentOnly: RoomArtifactV2 = {
      ...artifact(1, ""),
      artifactId: "artifact-unavailable-photo",
      title: "受潮的合影",
      kind: "handout",
      attachments: [image],
    };
    const resolveAsset = vi.fn().mockRejectedValue(new Error("transfer unavailable"));

    render(<ArtifactWorkspaceV2
      world={worldWith(attachmentOnly)}
      readOnly
      resolveAsset={resolveAsset}
    />);

    expect(await screen.findByText("图片附件暂时无法载入")).toBeTruthy();
    expect(screen.getByText(/资源可能仍在传输/)).toBeTruthy();
    expect(screen.getByText(/image\/webp/)).toBeTruthy();
    expect(resolveAsset).toHaveBeenCalledOnce();
    expect(resolveAsset).toHaveBeenCalledWith(image);
  });

  it("focuses the edit title and restores the originating button after Escape", async () => {
    const base = artifact(1, "基线正文");
    const world = worldWith(base);
    const session = {
      isHost: false,
      isAuthenticated: true,
      localSeat: PLAYER,
      world,
      submitConfirmed: vi.fn(async () => undefined),
    } as unknown as RoomSessionV2;

    render(<ArtifactWorkspaceV2 world={world} session={session} />);
    const editButton = screen.getByRole("button", { name: "编辑内容" });
    fireEvent.click(editButton);

    const title = screen.getByRole("textbox", { name: "标题" });
    await waitFor(() => expect(document.activeElement).toBe(title));

    fireEvent.keyDown(title, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(editButton));
    expect(screen.queryByRole("textbox", { name: "标题" })).toBeNull();
  });

  it("opens a three-way merge instead of silently overwriting a newer revision", async () => {
    const base = artifact(1, "基线正文");
    const theirs = artifact(2, "房主当前正文");
    let sessionWorld = worldWith(base);
    const submitConfirmed = vi.fn(async () => {
      sessionWorld = worldWith(theirs);
      throw new RoomCommandRejectedError("revision conflict", "CONFLICT");
    });
    const session = {
      isHost: false,
      isAuthenticated: true,
      localSeat: PLAYER,
      get world() { return sessionWorld; },
      submitConfirmed,
    } as unknown as RoomSessionV2;

    render(<ArtifactWorkspaceV2 world={worldWith(base)} session={session} />);
    const editButton = screen.getByRole("button", { name: "编辑内容" });
    fireEvent.click(editButton);
    const body = screen.getByLabelText("正文");
    fireEvent.change(body, { target: { value: "玩家草稿正文" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    const alert = await screen.findByRole("alert");
    const heading = screen.getByRole("heading", { name: "保存前，请先看看另一位成员的修改" });
    expect(alert.getAttribute("aria-labelledby")).toBe(heading.id);
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByText("房主当前正文")).toBeTruthy();
    expect(screen.getByText("玩家草稿正文")).toBeTruthy();
    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledOnce());

    fireEvent.keyDown(heading, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(editButton));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

const PLAYER: SeatV2 = {
  seatId: "seat-player",
  role: "player",
  displayName: "调查员",
  extensions: {},
};

function artifact(revision: number, body: string): RoomArtifactV2 {
  return {
    schemaVersion: 2,
    artifactId: "artifact-shared-clue",
    revision,
    kind: "clue",
    title: "共享线索",
    description: "",
    body,
    attachments: [],
    audience: { kind: "room" },
    locked: false,
    archived: false,
    extensions: {},
  };
}

function namedArtifact(
  artifactId: string,
  kind: RoomArtifactV2["kind"],
  title: string,
  audience: RoomArtifactV2["audience"],
): RoomArtifactV2 {
  return {
    ...artifact(2, `${title}正文`),
    artifactId,
    kind,
    title,
    audience,
  };
}

function worldWith(value: RoomArtifactV2): RoomWorldStateV2 {
  return {
    ...createRoomWorldStateV2("room_artifact_workspace"),
    lastSequence: value.revision,
    artifacts: new Map([[value.artifactId, value]]),
  };
}

function asset(hex: string): AssetDescriptorV1 {
  return {
    schemaVersion: 1,
    assetId: `sha256:${hex.repeat(64)}`,
    mediaType: "image/webp",
    byteLength: 12,
    width: 2,
    height: 2,
  };
}
