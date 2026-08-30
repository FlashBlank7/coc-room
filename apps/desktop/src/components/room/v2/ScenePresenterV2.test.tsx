// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoomWorldStateV2, type RoomEntityV2 } from "@coc-room/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoomSessionV2 } from "../../../network/RoomSessionV2";
import { ManualScenePresenterV2 } from "./ScenePresenterV2";

afterEach(cleanup);

describe("ManualScenePresenterV2", () => {
  it("presents a durable public situation without a module or board", async () => {
    const world = createRoomWorldStateV2("room-manual-opening");
    const submitConfirmed = vi.fn().mockResolvedValue("confirmed");
    const session = { isHost: true, world, submitConfirmed } as unknown as RoomSessionV2;

    render(<ManualScenePresenterV2 world={world} session={session} />);
    expect(screen.getByLabelText("即兴呈现当前情境").id).toBe("manual-scene-presenter");
    fireEvent.change(screen.getByLabelText("当前情境名称"), { target: { value: "雨夜的剧院后门" } });
    fireEvent.change(screen.getByLabelText("当前情境公开描述"), { target: { value: "铁皮棚被雨点敲得发响，门缝透出暖黄灯光。" } });
    fireEvent.click(screen.getByRole("button", { name: "把开场公开给所有玩家" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledTimes(2));
    const upsert = submitConfirmed.mock.calls[0]?.[0];
    expect(upsert).toMatchObject({
      type: "entity.upserted",
      audience: { kind: "room" },
      payload: { entity: { kind: "scene", name: "雨夜的剧院后门", description: "铁皮棚被雨点敲得发响，门缝透出暖黄灯光。", data: { roomRole: "manual-current-scene" } } },
    });
    expect(submitConfirmed.mock.calls[1]?.[0]).toMatchObject({
      type: "scene.focused",
      payload: { sceneEntityId: upsert.payload.entity.entityId },
    });
    expect(screen.getByRole("status").textContent).toContain("已经成为所有玩家看到的当前情境");
  });

  it("updates the existing manual situation instead of creating a disconnected scene", async () => {
    const base = createRoomWorldStateV2("room-manual-update");
    const scene: RoomEntityV2 = { schemaVersion: 2, entityId: "scene-manual", revision: 3, kind: "scene", name: "门外", description: "雨仍在下。", artifactIds: [], audience: { kind: "room" }, data: { roomRole: "manual-current-scene" }, extensions: {} };
    const world = { ...base, entities: new Map([[scene.entityId, scene]]), activeSceneEntityId: scene.entityId };
    const submitConfirmed = vi.fn().mockResolvedValue("confirmed");
    const session = { isHost: true, world, submitConfirmed } as unknown as RoomSessionV2;

    render(<ManualScenePresenterV2 world={world} session={session} />);
    fireEvent.change(screen.getByLabelText("当前情境公开描述"), { target: { value: "门已经打开，潮湿的走廊伸向黑暗。" } });
    fireEvent.click(screen.getByRole("button", { name: "把更新公开给所有玩家" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledOnce());
    expect(submitConfirmed.mock.calls[0]?.[0]).toMatchObject({ type: "entity.upserted", payload: { entity: { entityId: scene.entityId, revision: 4, description: "门已经打开，潮湿的走廊伸向黑暗。" } } });
    expect(screen.getByRole("status").textContent).toContain("最新描述已经公开给所有玩家");
  });

  it("does not publish an incomplete or unchanged situation", () => {
    const base = createRoomWorldStateV2("room-manual-unchanged");
    const scene: RoomEntityV2 = { schemaVersion: 2, entityId: "scene-manual", revision: 1, kind: "scene", name: "门外", description: "雨仍在下。", artifactIds: [], audience: { kind: "room" }, data: { roomRole: "manual-current-scene" }, extensions: {} };
    const world = { ...base, entities: new Map([[scene.entityId, scene]]), activeSceneEntityId: scene.entityId };
    const submitConfirmed = vi.fn();
    const session = { isHost: true, world, submitConfirmed } as unknown as RoomSessionV2;

    render(<ManualScenePresenterV2 world={world} session={session} />);
    expect((screen.getByRole("button", { name: "当前描述已是最新" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("当前情境公开描述"), { target: { value: "" } });
    expect(screen.getByText(/填写标题和玩家可见描述后/)).toBeTruthy();
    expect(submitConfirmed).not.toHaveBeenCalled();
  });
});
