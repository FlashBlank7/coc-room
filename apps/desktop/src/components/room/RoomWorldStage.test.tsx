// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Coc7Character } from "@coc-room/protocol";

import { RoomWorldStage, type PublishedRoomLocation, type PublishedRoomNpc } from "./RoomWorldStage";

const locations: PublishedRoomLocation[] = [
  { id: "location-theater", name: "观止剧场", description: "灯光落在空荡的舞台上。" },
  { id: "location-garden", name: "蝶园", description: "夜风吹动庭院里的花叶。" },
];

const npcs: PublishedRoomNpc[] = [
  { id: "npc-hana", name: "花小路", description: "一位神色谨慎的演员。" },
  { id: "npc-keeper-secret", name: "未在场人物", description: "不会出现在当前地点。" },
];

afterEach(cleanup);

describe("RoomWorldStage", () => {
  it("uses the investigator's current location and renders only the supplied public world", () => {
    const own = createCharacter("character-own", "peer-local", "林若岚");
    const other = createCharacter("character-other", "peer-other", "周启明");

    render(
      <RoomWorldStage
        locations={locationMap()}
        npcsByLocation={new Map([
          ["location-theater", new Map([["npc-hana", npcs[0]!]])],
          ["location-garden", new Map([["npc-keeper-secret", npcs[1]!]])],
        ])}
        latestCharacters={new Map([[own.id, own], [other.id, other]])}
        currentLocationByCharacterId={new Map([
          [own.id, "location-theater"],
          [other.id, "location-garden"],
        ])}
        locationContent={new Map([["location-theater", [{
          moduleId: "module-butterfly",
          revision: 1,
          contentId: "clue-ticket",
          contentType: "clue" as const,
          title: "沾血的票根",
          body: "日期被人用墨水涂掉了。",
          locationId: "location-theater",
        }]]])}
        localPeerId="peer-local"
        onEnterLocation={() => undefined}
      />,
    );

    expect(screen.getByRole("heading", { name: "观止剧场" })).toBeTruthy();
    expect(screen.getByText("灯光落在空荡的舞台上。")).toBeTruthy();
    expect(screen.getByText("林若岚")).toBeTruthy();
    expect(screen.getByText("花小路")).toBeTruthy();
    expect(screen.getByText("沾血的票根")).toBeTruthy();
    expect(screen.getByText("日期被人用墨水涂掉了。")).toBeTruthy();
    expect(screen.queryByText("周启明")).toBeNull();
    expect(screen.queryByText("未在场人物")).toBeNull();
    expect(screen.getByTestId("location-backdrop").getAttribute("style")).toContain("gradient");
    expect((screen.getByRole("button", { name: /林若岚 已在此地/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lets a player inspect a public location and enter it with their own character", () => {
    const own = createCharacter("character-own", "peer-local", "林若岚");
    const onSelectLocation = vi.fn();
    const onEnterLocation = vi.fn();

    render(
      <RoomWorldStage
        locations={locationMap()}
        npcsByLocation={new Map()}
        latestCharacters={new Map([[own.id, own]])}
        currentLocationByCharacterId={new Map([[own.id, "location-theater"]])}
        localPeerId="peer-local"
        onSelectLocation={onSelectLocation}
        onEnterLocation={onEnterLocation}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看地点：蝶园" }));
    expect(onSelectLocation).toHaveBeenCalledWith("location-garden");
    expect(screen.getByRole("heading", { name: "蝶园" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "让 林若岚 进入此地" }));
    expect(onEnterLocation).toHaveBeenCalledWith(own, locations[1]);
  });

  it("supports choosing between multiple locally owned investigators", () => {
    const first = createCharacter("character-first", "peer-local", "林若岚");
    const second = createCharacter("character-second", "peer-local", "许文彬");
    const onEnterLocation = vi.fn();

    render(
      <RoomWorldStage
        locations={locationMap()}
        npcsByLocation={new Map()}
        latestCharacters={new Map([[first.id, first], [second.id, second]])}
        currentLocationByCharacterId={new Map([[first.id, "location-theater"]])}
        localPeerId="peer-local"
        selectedLocationId="location-garden"
        onEnterLocation={onEnterLocation}
      />,
    );

    fireEvent.change(screen.getByLabelText("选择进入地点的调查员"), {
      target: { value: second.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "让 许文彬 进入此地" }));
    expect(onEnterLocation).toHaveBeenCalledWith(second, locations[1]);
  });

  it("explains missing characters and disables movement while the room is unavailable", () => {
    const { rerender } = render(
      <RoomWorldStage
        locations={locationMap()}
        npcsByLocation={new Map()}
        latestCharacters={new Map()}
        currentLocationByCharacterId={new Map()}
        localPeerId="peer-local"
        onEnterLocation={vi.fn()}
      />,
    );

    expect((screen.getByRole("button", { name: "先创建自己的调查员角色卡" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/在角色卡页面保存自己的调查员/)).toBeTruthy();

    const own = createCharacter("character-own", "peer-local", "林若岚");
    rerender(
      <RoomWorldStage
        locations={locationMap()}
        npcsByLocation={new Map()}
        latestCharacters={new Map([[own.id, own]])}
        currentLocationByCharacterId={new Map()}
        localPeerId="peer-local"
        disabled
        disabledReason="房主离线，房间已暂停"
        onEnterLocation={vi.fn()}
      />,
    );

    expect((screen.getByRole("button", { name: "房主离线，房间已暂停" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("房主离线，房间已暂停")).toHaveLength(2);
  });

  it("reconstructs an empty or read-only stage without exposing actions", () => {
    const { rerender } = render(
      <RoomWorldStage
        locations={new Map()}
        npcsByLocation={new Map()}
        latestCharacters={new Map()}
        currentLocationByCharacterId={new Map()}
        localPeerId="peer-local"
        readOnly
      />,
    );
    expect(screen.getByText("这份本地记录中没有已公开地点。")).toBeTruthy();

    rerender(
      <RoomWorldStage
        locations={locationMap()}
        npcsByLocation={new Map()}
        latestCharacters={new Map()}
        currentLocationByCharacterId={new Map()}
        localPeerId="peer-local"
        readOnly
      />,
    );
    expect(screen.queryByText(/进入此地/)).toBeNull();
  });
});

function locationMap(): ReadonlyMap<string, PublishedRoomLocation> {
  return new Map(locations.map((location) => [location.id, location]));
}

function createCharacter(id: string, ownerPeerId: string, name: string): Coc7Character {
  return {
    schemaVersion: 1,
    id,
    ownerPeerId,
    name,
    playerName: ownerPeerId,
    occupation: "记者",
    age: 28,
    residence: "东京",
    birthplace: "上海",
    characteristics: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 60, pow: 60, edu: 60, luck: 50 },
    derived: {
      hitPoints: 10,
      maxHitPoints: 10,
      magicPoints: 12,
      maxMagicPoints: 12,
      sanity: 60,
      maxSanity: 99,
      movementRate: 8,
      build: 0,
      damageBonus: "0",
    },
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
    updatedAt: "2026-08-28T00:00:00.000Z",
    extensions: {},
  };
}
