// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRoomWorldStateV2 } from "@coc-room/protocol";
import type { RoomSessionV2 } from "../../network/RoomSessionV2";
import { CharacterBriefingEditor } from "./CharacterBriefingEditor";

afterEach(cleanup);

it("publishes only the explicitly previewed public brief and rules, without changing default visibility", async () => {
  const world = { ...createRoomWorldStateV2(), defaultVisibility: "secret" as const };
  const submitConfirmed = vi.fn().mockResolvedValue("saved");
  const session = { isHost: true, submitConfirmed } as unknown as RoomSessionV2;
  render(<CharacterBriefingEditor session={session} world={world} />);
  fireEvent.click(screen.getByText("本团车卡说明与点数要求"));
  fireEvent.change(screen.getByLabelText("本团公开车卡说明"), { target: { value: "1920 年代，受邀调查失踪事件。" } });
  fireEvent.change(screen.getByLabelText("本团推荐技能"), { target: { value: "侦查、聆听" } });
  fireEvent.click(screen.getByText("配置自动核算的房规"));
  fireEvent.change(screen.getByLabelText("技能购点总预算（不含基础值）"), { target: { value: "300" } });
  fireEvent.click(screen.getByRole("button", { name: "预览本团要求" }));
  expect(submitConfirmed).not.toHaveBeenCalled();
  expect(screen.getByLabelText("车卡要求公开预览").textContent).toContain("300");
  fireEvent.click(screen.getByRole("button", { name: "确认发布给玩家" }));
  await waitFor(() => expect(submitConfirmed).toHaveBeenCalledWith({ type: "room.settings.updated", audience: { kind: "room" }, payload: { defaultVisibility: "secret", characterBriefing: { text: "1920 年代，受邀调查失踪事件。", recommendedSkills: ["侦查", "聆听"], skillBudget: 300, skillPointMode: "occupation-interest" } } }));
});
