// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coc7CharacterSchema,
  type Coc7Character,
  type ParticipantV1,
  type RoomEventV1,
} from "@coc-room/protocol";
import type { RoomRecord } from "../data/repository";
import { deriveCoc7Stats } from "../lib/character-derivation";
import type { RoomSession } from "../network/RoomSession";
import { useAppStore } from "../store/app-store";
import { CharactersView } from "./CharactersView";

const playerRoom = createRoom("player", "player-local");

beforeEach(() => {
  useAppStore.setState({
    activeView: "characters",
    currentRoom: playerRoom,
    events: [],
    participants: [],
    paths: {},
    connectionError: undefined,
  });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().leaveRoom();
});

describe("CharactersView permissions and editing", () => {
  it("lets a player build and submit a complete own character with live derived values", async () => {
    const { session, submit } = createSession("player", "player-local", "Alice");
    render(<CharactersView session={session} />);

    fireEvent.click(screen.getByRole("button", { name: "新建我的角色" }));
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "林蝶" } });
    fireEvent.change(screen.getByLabelText("玩家"), { target: { value: "Alice" } });
    fireEvent.change(screen.getByLabelText("职业"), { target: { value: "记者" } });
    fireEvent.change(screen.getByLabelText(/^年龄/), { target: { value: "42" } });
    fireEvent.change(screen.getByLabelText("居住地"), { target: { value: "东京" } });
    fireEvent.change(screen.getByLabelText("出生地"), { target: { value: "横滨" } });

    expect(derivedValue("最大 HP")).toContain("10");
    fireEvent.change(screen.getByLabelText("体质 CON"), { target: { value: "80" } });
    expect(derivedValue("最大 HP")).toContain("13");
    fireEvent.change(screen.getByLabelText(/^当前生命 HP/), { target: { value: "12" } });

    fireEvent.click(screen.getByRole("button", { name: "添加技能" }));
    fireEvent.change(screen.getByLabelText("技能名"), { target: { value: "克苏鲁神话" } });
    fireEvent.change(screen.getByLabelText("基础值"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("当前值"), { target: { value: "20" } });
    fireEvent.click(screen.getByLabelText("成长标记"));
    expect(derivedValue("最大 SAN")).toContain("79");

    fireEvent.click(screen.getByLabelText("重伤"));
    fireEvent.click(screen.getByRole("button", { name: "添加物品" }));
    fireEvent.change(screen.getByLabelText("物品名"), { target: { value: "折叠相机" } });
    fireEvent.change(screen.getByLabelText("数量"), { target: { value: "2" } });
    fireEvent.click(screen.getByLabelText("已装备"));
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "装有一卷未冲洗的胶片。" } });
    fireEvent.change(screen.getByLabelText("个人描述"), { target: { value: "总穿着深色风衣。" } });
    fireEvent.change(screen.getByLabelText("自由记录"), { target: { value: "在庭院里见过蝶影。" } });

    fireEvent.click(screen.getByRole("button", { name: "保存并同步" }));

    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const [commandType, commandPayload] = submit.mock.calls[0]!;
    expect(commandType).toBe("character.update");
    const character = (commandPayload as { character: Coc7Character }).character;
    expect(coc7CharacterSchema.parse(character)).toEqual(character);
    expect(character).toMatchObject({
      ownerPeerId: "player-local",
      name: "林蝶",
      playerName: "Alice",
      occupation: "记者",
      age: 42,
      residence: "东京",
      birthplace: "横滨",
      characteristics: { con: 80 },
      derived: { hitPoints: 12, maxHitPoints: 13, maxSanity: 79, movementRate: 7 },
      status: { majorWound: true },
      background: { personalDescription: "总穿着深色风衣。" },
      notes: "在庭院里见过蝶影。",
    });
    expect(character.skills[0]).toMatchObject({ name: "克苏鲁神话", baseValue: 5, value: 20, checked: true });
    expect(character.inventory[0]).toMatchObject({ name: "折叠相机", quantity: 2, equipped: true });
  });

  it("keeps another player's character read-only for a player", () => {
    const own = createCharacter("own", "player-local", "我的调查员", "Alice");
    const other = createCharacter("other", "other-player", "他人调查员", "Bob");
    useAppStore.setState({ events: [characterEvent(own, 1), characterEvent(other, 2)] });
    const { session, submit } = createSession("player", "player-local", "Alice");
    render(<CharactersView session={session} />);

    fireEvent.click(screen.getByRole("button", { name: /他人调查员/ }));

    expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("他人调查员");
    expect((screen.getByLabelText("姓名") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "添加技能" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "保存并同步" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("只有角色所有者与主持人可以修改这张角色卡。")).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it("lets the host correct any player's character without changing ownership", async () => {
    const hostRoom = createRoom("host", "host-local");
    const other = createCharacter("other", "other-player", "待修正调查员", "Bob");
    useAppStore.setState({ currentRoom: hostRoom, events: [characterEvent(other, 1)] });
    const { session, submit } = createSession("host", "host-local", "Keeper");
    render(<CharactersView session={session} />);

    fireEvent.click(screen.getByRole("button", { name: /待修正调查员/ }));
    const name = screen.getByLabelText("姓名") as HTMLInputElement;
    expect(name.disabled).toBe(false);
    fireEvent.change(name, { target: { value: "已修正调查员" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并同步" }));

    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const character = (submit.mock.calls[0]![1] as { character: Coc7Character }).character;
    expect(character.name).toBe("已修正调查员");
    expect(character.ownerPeerId).toBe("other-player");
  });

  it("disables creation, editing, and saving for an offline local record", () => {
    render(<CharactersView />);

    expect(screen.getByText("本地记录为只读；重新连接房间后才能新建或修改角色卡。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "新建我的角色" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("姓名") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "保存并同步" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

function createRoom(localRole: RoomRecord["localRole"], localPeerId: string): RoomRecord {
  return {
    id: "character-room",
    name: "角色测试房间",
    localRole,
    localPeerId,
    hostPeerId: localRole === "host" ? localPeerId : "host-local",
    inviteToken: "saved-token",
    relayUrl: "ws://127.0.0.1:8787/v1/rooms/character-room/ws",
    lastSeq: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createSession(role: ParticipantV1["role"], peerId: string, displayName: string) {
  const submit = vi.fn(async (_type: string, _payload: unknown) => undefined);
  const session = {
    participant: { peerId, displayName, role },
    isHost: role === "host",
    submit,
  } as unknown as RoomSession;
  return { session, submit };
}

function createCharacter(
  id: string,
  ownerPeerId: string,
  name: string,
  playerName: string,
): Coc7Character {
  const characteristics: Coc7Character["characteristics"] = {
    str: 50,
    con: 50,
    siz: 50,
    dex: 50,
    app: 50,
    int: 50,
    pow: 50,
    edu: 50,
    luck: 50,
  };
  return coc7CharacterSchema.parse({
    schemaVersion: 1,
    id,
    ownerPeerId,
    name,
    playerName,
    occupation: "记者",
    age: 25,
    residence: "",
    birthplace: "",
    characteristics,
    derived: deriveCoc7Stats({ characteristics, age: 25, skills: [] }),
    skills: [],
    status: {
      temporaryInsanity: false,
      indefiniteInsanity: false,
      majorWound: false,
      dying: false,
      unconscious: false,
    },
    inventory: [],
    background: {
      personalDescription: "",
      ideologyAndBeliefs: "",
      significantPeople: "",
      meaningfulLocations: "",
      treasuredPossessions: "",
      traits: "",
      injuriesAndScars: "",
      phobiasAndManias: "",
      arcaneTomesSpellsAndArtifacts: "",
      encountersWithStrangeEntities: "",
    },
    notes: "",
    updatedAt: "2026-01-01T00:00:00.000Z",
    extensions: {},
  });
}

function characterEvent(character: Coc7Character, sequence: number): RoomEventV1 {
  return {
    protocolVersion: 1,
    roomId: "character-room",
    eventId: `character-event-${sequence}`,
    sequence,
    sender: { peerId: "host-local", displayName: "Keeper", role: "host" },
    type: "character.updated",
    occurredAt: `2026-01-01T00:00:0${sequence}.000Z`,
    payload: { character },
  };
}

function derivedValue(label: string): string {
  return screen.getByText(label).parentElement?.textContent ?? "";
}
