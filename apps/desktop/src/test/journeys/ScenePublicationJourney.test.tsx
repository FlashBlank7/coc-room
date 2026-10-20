// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRoomCommandV2, HostEventSequencerV2, type KeeperGuideV1, type ModulePackageV1, type RoomEventProposalV2, type ScenePublicEntityV1 } from "@coc-room/protocol";
import { KeeperModuleWorkbenchV2 } from "../../components/room/v2/InvestigationWorkspaceV2";
import { generateKeeperGuide } from "../../ai/keeper-guide";
import { getRepository } from "../../data/repository";
import type { RoomSessionV2 } from "../../network/RoomSessionV2";
import { miniModule, miniHostSeat } from "../scenarios/mini-investigation";

vi.mock("../../ai/keeper-guide", () => ({ generateKeeperGuide: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const condition = { title: "登场时机", text: "KEEPER_ONLY_CONDITION", kind: "advice" as const, sources: [] };
const introductions = (late: boolean): ScenePublicEntityV1[] => [
  { kind: "location", entityId: "location-yangya", name: "扬屋", text: late ? "失踪后，屋内留下散乱的首饰。" : "扬屋是一处接待访客的会面场所。", when: { ...condition, text: late ? "映夜失踪之后再调查房间。" : "调查员初次抵达扬屋。" } },
  { kind: "npc", entityId: "npc-yingye", name: "映夜", text: late ? "映夜已经失踪。" : "映夜正等候你们。", when: condition },
];
function guide(): KeeperGuideV1 {
  return { schemaVersion: 1, truth: "", hook: "", clueTrail: [], timeline: [], endings: [], pacing: "", preparation: {
    truth: condition, hook: condition, essentials: [condition], playerBriefing: condition, cast: [], timeline: [], endings: [],
    scenes: [false, true].map((late) => ({ sceneId: late ? "scene-later" : "scene-meeting", purpose: condition, openingDraft: late ? "你们再次来到扬屋。" : "你们来听取委托。", publicEntities: introductions(late), actions: [], exits: [], pitfalls: [] })),
  } };
}
function fixture(withGuide = true): ModulePackageV1 {
  return { ...miniModule, moduleId: `module-scene-publications-${withGuide}`, scenes: [false, true].map((late) => ({ ...miniModule.scenes[0]!, id: late ? "scene-later" : "scene-meeting", name: late ? "失踪后调查" : "初次会面", locationIds: ["location-yangya"], npcIds: ["npc-yingye"], clueIds: [], playerDescription: late ? "你们再次来到扬屋。" : "你们来听取委托。" })),
    locations: [{ id: "location-yangya", name: "扬屋", description: "全局私密参考", sourceRefs: [], aliases: [], playerDescription: "GLOBAL_FUTURE_DESCRIPTION：映夜失踪后地上散落首饰。" }],
    npcs: [{ id: "npc-yingye", name: "映夜", description: "KP_SECRET_BIOGRAPHY", playerDescription: "GLOBAL_FUTURE_NPC：映夜已失踪。", role: "委托人", motivation: "秘密目的", traits: [], sourceRefs: [] }],
    ...(withGuide ? { keeperGuide: guide() } : {}),
  };
}
function room(id: string) {
  const authority = new HostEventSequencerV2(id);
  const submitConfirmed = vi.fn(async (proposal: RoomEventProposalV2) => { authority.commitCommand(createRoomCommandV2(id, miniHostSeat, proposal), miniHostSeat); return "accepted"; });
  const session = { isHost: true, localSeat: miniHostSeat, get world() { return authority.world; }, submitConfirmed } as unknown as RoomSessionV2;
  return { authority, session, submitConfirmed };
}

it("keeps unpublished opening drafts per scene across browsing and navigation, including an intentionally empty draft", async () => {
  const modulePackage = fixture();
  const { authority, session, submitConfirmed } = room("room-opening-drafts");
  const opening = () => screen.getByLabelText("玩家可见的开场描述") as HTMLTextAreaElement;
  const view = render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} session={session} world={authority.world} />);
  await waitFor(() => expect((screen.getByLabelText("玩家可见介绍：扬屋") as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(opening(), { target: { value: "KP 临场改写：侍女领你们进了会客室。" } });
  fireEvent.click(screen.getByRole("button", { name: "模组场景：失踪后调查" }));
  expect(opening().value).toBe("你们再次来到扬屋。");
  fireEvent.change(opening(), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "模组场景：初次会面" }));
  expect(opening().value).toBe("KP 临场改写：侍女领你们进了会客室。");
  expect(submitConfirmed).not.toHaveBeenCalled();
  const repository = await getRepository();
  const key = `room-publication:${JSON.stringify([authority.world.roomId, modulePackage.moduleId, modulePackage.revision])}`;
  await waitFor(async () => expect(await repository.getSetting(key)).toContain("KP 临场改写"));
  view.unmount();
  const restored = render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} session={session} world={authority.world} />);
  await waitFor(() => expect(opening().value).toBe("KP 临场改写：侍女领你们进了会客室。"));
  fireEvent.click(screen.getByRole("button", { name: "模组场景：失踪后调查" }));
  expect(opening().value).toBe("");
  expect(screen.getByRole("button", { name: "向所有人呈现这个场景" }).hasAttribute("disabled")).toBe(true);
  const otherRoom = room("room-opening-drafts-other");
  restored.rerender(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} session={otherRoom.session} world={otherRoom.authority.world} />);
  await waitFor(() => expect(opening().disabled).toBe(false));
  expect(opening().value).toBe("你们再次来到扬屋。");
  expect(submitConfirmed).not.toHaveBeenCalled();
});

it("keeps the same location's later state out of the opening and isolates handwritten copy per scene", async () => {
  const modulePackage = fixture();
  const { authority, session, submitConfirmed } = room("room-stage-isolation");
  const view = render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} session={session} world={authority.world} />);
  const input = () => screen.getByLabelText("玩家可见介绍：扬屋") as HTMLTextAreaElement;
  await waitFor(() => expect(input().disabled).toBe(false));
  expect(input().value).toBe(introductions(false)[0]!.text);
  expect(input().value).not.toContain("失踪");
  fireEvent.change(input(), { target: { value: "你们在扬屋的会客室落座。" } });
  fireEvent.click(screen.getByRole("button", { name: "向所有人呈现这个场景" }));
  await waitFor(() => expect(authority.world.activeSceneEntityId).toBeTruthy());
  view.rerender(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} session={session} world={authority.world} />);
  fireEvent.click(screen.getByRole("button", { name: "让地点在当前情境登场" }));
  await waitFor(() => expect([...authority.world.entities.values()].some((entity) => entity.description === "你们在扬屋的会客室落座。")).toBe(true));
  expect(submitConfirmed.mock.calls.filter(([proposal]) => proposal.type === "entity.upserted" && proposal.payload.entity.kind === "location")).toHaveLength(1);
  expect(JSON.stringify(submitConfirmed.mock.calls)).not.toMatch(/GLOBAL_FUTURE|KEEPER_ONLY_CONDITION|KP_SECRET/);
  view.rerender(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} session={session} world={authority.world} />);
  const before = submitConfirmed.mock.calls.length;
  expect(screen.getByRole("button", { name: "已呈现，修改后可更新" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "已呈现，修改后可更新" }));
  expect(submitConfirmed).toHaveBeenCalledTimes(before);
  fireEvent.change(screen.getByLabelText("玩家可见的开场描述"), { target: { value: "侍女送来了茶水。" } });
  fireEvent.click(screen.getByRole("button", { name: "更新当前情境" }));
  await waitFor(() => expect(submitConfirmed).toHaveBeenCalledTimes(before + 1));
  expect(submitConfirmed.mock.calls.at(-1)![0].type).toBe("entity.upserted");
  fireEvent.click(screen.getByRole("button", { name: "模组场景：失踪后调查" }));
  expect(input().value).toBe(introductions(true)[0]!.text);
  fireEvent.change(input(), { target: { value: "后来调查时，现场的首饰已经被收走。" } });
  fireEvent.click(screen.getByRole("button", { name: "模组场景：初次会面" }));
  expect(input().value).toBe("你们在扬屋的会客室落座。");
  const repository = await getRepository();
  const key = `room-publication:${JSON.stringify([authority.world.roomId, modulePackage.moduleId, modulePackage.revision])}`;
  await waitFor(async () => expect(await repository.getSetting(key)).toContain("首饰已经被收走"));
  view.unmount();
  render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} session={session} world={authority.world} />);
  await waitFor(() => expect(input().value).toBe("你们在扬屋的会客室落座。"));
  fireEvent.click(screen.getByRole("button", { name: "模组场景：失踪后调查" }));
  expect(input().value).toBe("后来调查时，现场的首饰已经被收走。");
});

it("organizes only the current scene of an old package in place and preserves an in-progress handwritten introduction", async () => {
  const modulePackage = fixture(false);
  const { authority, session, submitConfirmed } = room("room-stage-generation");
  let finish!: (guide: KeeperGuideV1) => void;
  vi.mocked(generateKeeperGuide).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} session={session} world={authority.world} />);
  await waitFor(() => expect((screen.getByLabelText("玩家可见介绍：扬屋") as HTMLTextAreaElement).disabled).toBe(false));
  expect((screen.getByLabelText("玩家可见介绍：扬屋") as HTMLTextAreaElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "整理本幕人物与地点介绍" }));
  await waitFor(() => expect(generateKeeperGuide).toHaveBeenCalledOnce());
  expect(vi.mocked(generateKeeperGuide).mock.calls[0]![0].modulePackage.scenes.map((scene) => scene.id)).toEqual(["scene-meeting"]);
  expect(vi.mocked(generateKeeperGuide).mock.calls[0]![0].preparationScope).toBe("scene-publications");
  fireEvent.change(screen.getByLabelText("玩家可见介绍：扬屋"), { target: { value: "KP 手写的会面场所。" } });
  finish(guide());
  await waitFor(() => expect((screen.getByLabelText("玩家可见介绍：映夜") as HTMLTextAreaElement).value).toBe("映夜正等候你们。"));
  expect((screen.getByLabelText("玩家可见介绍：扬屋") as HTMLTextAreaElement).value).toBe("KP 手写的会面场所。");
  expect(submitConfirmed).not.toHaveBeenCalled();
  expect(modulePackage.keeperGuide).toBeUndefined();
  expect(screen.getByLabelText("本幕登场参考：映夜").textContent).toContain("KEEPER_ONLY_CONDITION");
  fireEvent.click(screen.getByText("准备一起登场的内容"));
  fireEvent.click(screen.getByRole("checkbox", { name: "映夜" }));
  fireEvent.click(screen.getByRole("button", { name: "预览一起登场" }));
  const preview = screen.getByLabelText("成组呈现公开预览");
  expect(preview.textContent).toContain("映夜正等候你们。");
  expect(preview.textContent).not.toMatch(/GLOBAL_FUTURE|KEEPER_ONLY_CONDITION|KP_SECRET/);
  fireEvent.click(within(preview).getByRole("button", { name: "确认呈现场景与 1 项内容" }));
  await waitFor(() => expect([...authority.world.entities.values()].some((entity) => entity.kind === "npc")).toBe(true));
  expect(JSON.stringify(submitConfirmed.mock.calls)).not.toMatch(/GLOBAL_FUTURE|KEEPER_ONLY_CONDITION|KP_SECRET/);
});

it("publishes the chosen player-known alias and keeps a handwritten name scoped to its scene", async () => {
  const modulePackage = fixture();
  modulePackage.npcs[0]!.name = "KP_SECRET_REAL_NAME";
  modulePackage.keeperGuide!.preparation!.scenes[0]!.publicEntities = [introductions(false)[0]!,
    { kind: "npc", entityId: "npc-yingye", name: "蒙面访客", text: "一位蒙面访客正在等候。", when: condition },
    { kind: "npc", entityId: "npc-yingye", name: "蝴蝶", text: "访客自称蝴蝶。", when: { ...condition, text: "KEEPER_ONLY_NAME_CONDITION" } },
  ];
  const { authority, session, submitConfirmed } = room("room-public-alias");
  const view = render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} session={session} world={authority.world} />);
  const name = () => screen.getByLabelText("玩家可见名称：KP_SECRET_REAL_NAME") as HTMLInputElement;
  await waitFor(() => expect(name().disabled).toBe(false));
  expect(name().value).toBe("");
  fireEvent.click(screen.getAllByRole("button", { name: "采用本幕介绍：KP_SECRET_REAL_NAME" })[1]!);
  expect(name().value).toBe("蝴蝶");
  fireEvent.change(name(), { target: { value: "自称蝴蝶的访客" } });
  fireEvent.click(screen.getByText("准备一起登场的内容"));
  fireEvent.click(screen.getByRole("checkbox", { name: "自称蝴蝶的访客" }));
  fireEvent.click(screen.getByRole("button", { name: "预览一起登场" }));
  const preview = screen.getByLabelText("成组呈现公开预览");
  expect(preview.textContent).toContain("自称蝴蝶的访客");
  expect(preview.textContent).not.toContain("KP_SECRET_REAL_NAME");
  fireEvent.click(within(preview).getByRole("button", { name: "确认呈现场景与 1 项内容" }));
  await waitFor(() => expect([...authority.world.entities.values()].some((entity) => entity.name === "自称蝴蝶的访客")).toBe(true));
  expect(JSON.stringify(submitConfirmed.mock.calls)).not.toMatch(/KP_SECRET|KEEPER_ONLY/);
  view.rerender(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} session={session} world={authority.world} />);
  fireEvent.click(screen.getByRole("button", { name: "模组场景：失踪后调查" }));
  expect(name().value).toBe("映夜");
  fireEvent.click(screen.getByRole("button", { name: "模组场景：初次会面" }));
  expect(name().value).toBe("自称蝴蝶的访客");
});
