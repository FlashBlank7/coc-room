// @vitest-environment jsdom
// Opt-in component journey using an existing real module file. No model call,
// browser automation or transport is involved; relay coverage runs separately.
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HostEventSequencerV2, createRoomCommandV2, modulePackageSchema, type RoomEventProposalV2 } from "@coc-room/protocol";
import { getRepository } from "../../data/repository";
import { RoomSessionV2 } from "../../network/RoomSessionV2";
import { useAppStore } from "../../store/app-store";
import { ModulesView } from "../../views/ModulesView";
import { KeeperModuleWorkbenchV2 } from "../../components/room/v2/InvestigationWorkspaceV2";
import { miniHostSeat, miniPlayerSeat, miniRoomRecord } from "../scenarios/mini-investigation";

afterEach(() => { cleanup(); useAppStore.getState().leaveRoom(); vi.restoreAllMocks(); });

it.skipIf(!process.env.COC_REVIEW_MODULE)("imports an existing module as basic material, finds a clue and retains a handwritten opening before explicitly publishing it", async () => {
  const original = modulePackageSchema.parse(JSON.parse(readFileSync(process.env.COC_REVIEW_MODULE!, "utf8")));
  // Exercise the basic result independently of the optional reference material.
  const modulePackage = { ...original, moduleId: `import-review-${crypto.randomUUID()}`, keeperGuide: undefined };
  const firstScene = modulePackage.scenes[0]!;
  const secondScene = modulePackage.scenes[1]!;
  const clue = modulePackage.clues.find((entry) => firstScene.clueIds.includes(entry.id) && entry.revealText.trim())
    ?? modulePackage.clues.find((entry) => entry.revealText.trim())!;
  expect(firstScene).toBeDefined(); expect(secondScene).toBeDefined(); expect(clue).toBeDefined();
  const room = miniRoomRecord("host");
  const authority = new HostEventSequencerV2(room.id);
  const session = new RoomSessionV2({ room, displayName: miniHostSeat.displayName, repository: {} as never, transport: {} as never });
  vi.spyOn(session, "world", "get").mockImplementation(() => authority.world);
  const submit = async (proposal: RoomEventProposalV2) => {
    authority.commitCommand(createRoomCommandV2(room.id, miniHostSeat, proposal), miniHostSeat);
    return "confirmed";
  };
  vi.spyOn(session, "submit").mockImplementation(submit);
  const confirmed = vi.spyOn(session, "submitConfirmed").mockImplementation(submit);
  useAppStore.setState({ currentRoom: room, activeView: "modules", modules: [], participants: [], paths: {} });
  const repository = await getRepository();
  await repository.deleteModuleDraft("active-module-editor");
  const library = render(<ModulesView session={session} />);
  const content = JSON.stringify(modulePackage);
  const file = new File([content], "existing-basic.cocmod.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => content });
  fireEvent.change(screen.getByLabelText("导入模组包文件"), { target: { files: [file] } });
  const browser = await screen.findByLabelText(`${modulePackage.metadata.title}模组内容浏览`);
  const imported = useAppStore.getState().modules.find((entry) => entry.moduleId === modulePackage.moduleId)!;
  expect(imported.scenes).toEqual(original.scenes);
  expect(imported.clues).toEqual(original.clues);
  expect(imported.npcs).toEqual(original.npcs);
  expect(imported.extensions).toEqual(original.extensions);
  expect(imported.keeperGuide).toBeUndefined();
  expect(screen.queryByLabelText("第一次带这个模组")).toBeNull();
  fireEvent.click(within(browser).getByRole("tab", { name: /^NPC/ }));
  expect(within(browser).getAllByText(original.npcs[0]!.name).length).toBeGreaterThan(0);
  fireEvent.click(screen.getAllByRole("button", { name: `用于本次跑团并回到现场：${modulePackage.metadata.title}` })[0]!);
  await waitFor(() => expect(authority.world.activeModule?.moduleId).toBe(modulePackage.moduleId));
  await waitFor(() => expect(useAppStore.getState().activeView).toBe("room"));
  library.unmount();

  const desk = () => <KeeperModuleWorkbenchV2 modulePackage={imported} session={session} world={authority.world} />;
  const view = render(desk());
  await waitFor(() => expect(screen.getByLabelText("玩家可见的开场描述").hasAttribute("disabled")).toBe(false));
  fireEvent.change(screen.getByLabelText("搜索全部模组线索"), { target: { value: clue.name } });
  const results = screen.getByLabelText("模组线索搜索结果");
  expect(within(results).getByLabelText(`模组线索：${clue.name}`)).toBeTruthy();
  const opening = "体验检查：门被推开，接待者请你们入座。";
  fireEvent.change(screen.getByLabelText("玩家可见的开场描述"), { target: { value: opening } });
  fireEvent.click(screen.getByRole("button", { name: `模组场景：${secondScene.name}` }));
  fireEvent.click(screen.getByRole("button", { name: `模组场景：${firstScene.name}` }));
  expect((screen.getByLabelText("玩家可见的开场描述") as HTMLTextAreaElement).value).toBe(opening);
  expect(confirmed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "向所有人呈现这个场景" }));
  await waitFor(() => expect(authority.world.entities.get(authority.world.activeSceneEntityId!)?.description).toBe(opening));
  view.rerender(desk());
  expect(screen.getByRole("button", { name: "已呈现，修改后可更新" }).hasAttribute("disabled")).toBe(true);
  const row = within(screen.getByLabelText("模组线索搜索结果")).getByLabelText(`模组线索：${clue.name}`);
  if (firstScene.clueIds.includes(clue.id)) fireEvent.click(within(row).getByRole("button", { name: "公开到调查案卷" }));
  else {
    fireEvent.click(within(row).getByRole("button", { name: "跨场景发布…" }));
    fireEvent.click(within(row).getByRole("button", { name: "确认跨场景公开" }));
  }
  await waitFor(() => expect([...authority.world.artifacts.values()].some((entry) => entry.body === clue.revealText)).toBe(true));
  const playerViews = JSON.stringify(authority.viewsAfter(miniPlayerSeat, 0));
  expect(playerViews).toContain(opening);
  expect(playerViews).toContain(clue.revealText);
  expect(playerViews).not.toContain('"keeperNotes"');
  expect(playerViews).not.toContain('"sourceRefs"');
  await repository.deleteModule(modulePackage.moduleId);
});
