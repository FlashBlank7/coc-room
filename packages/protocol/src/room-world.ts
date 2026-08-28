import type { Coc7Character } from "./schemas/character.js";
import type {
  ContentRevealedPayloadV1,
  PlayerVisibleLocationV1,
  PlayerVisibleNpcV1,
  RoomEventV1,
} from "./schemas/room.js";
import { roomEventSchema } from "./schemas/room.js";

export interface ActiveRoomModuleV1 {
  readonly moduleId: string;
  readonly revision: number;
  readonly title: string;
}

export interface RoomWorldStateV1 {
  readonly activeModule?: ActiveRoomModuleV1;
  readonly locations: ReadonlyMap<string, PlayerVisibleLocationV1>;
  readonly npcsByLocation: ReadonlyMap<string, ReadonlyMap<string, PlayerVisibleNpcV1>>;
  readonly currentLocationByCharacterId: ReadonlyMap<string, string>;
  readonly latestCharacters: ReadonlyMap<string, Coc7Character>;
  readonly locationContent: ReadonlyMap<string, readonly ContentRevealedPayloadV1[]>;
}

/**
 * Reduces confirmed room events into the current player-visible world.
 *
 * Module switches clear every module-bound projection while character cards
 * remain room-scoped. Events are sorted by host sequence, so a later publish
 * replaces an earlier location/NPC snapshot even when input is out of order.
 */
export function deriveRoomWorldState(candidateEvents: readonly RoomEventV1[]): RoomWorldStateV1 {
  const events = roomEventSchema.array().parse(candidateEvents);
  assertSingleOrderedHistory(events);

  let activeModule: ActiveRoomModuleV1 | undefined;
  const locations = new Map<string, PlayerVisibleLocationV1>();
  const npcsByLocation = new Map<string, Map<string, PlayerVisibleNpcV1>>();
  const npcLocationById = new Map<string, string>();
  const currentLocationByCharacterId = new Map<string, string>();
  const latestCharacters = new Map<string, Coc7Character>();
  const contentByLocation = new Map<string, Map<string, ContentRevealedPayloadV1>>();

  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type === "character.updated") {
      latestCharacters.set(event.payload.character.id, event.payload.character);
      continue;
    }

    if (event.type === "module.switched") {
      activeModule = { ...event.payload };
      locations.clear();
      npcsByLocation.clear();
      npcLocationById.clear();
      currentLocationByCharacterId.clear();
      contentByLocation.clear();
      continue;
    }

    if (event.type === "location.published") {
      if (!matchesActiveModule(activeModule, event.payload.moduleId, event.payload.revision)) continue;
      const location = event.payload.location;
      locations.set(location.id, location);
      if (!npcsByLocation.has(location.id)) npcsByLocation.set(location.id, new Map());
      if (!contentByLocation.has(location.id)) contentByLocation.set(location.id, new Map());
      continue;
    }

    if (event.type === "npc.published") {
      if (!matchesActiveModule(activeModule, event.payload.moduleId, event.payload.revision)) continue;
      const location = locations.get(event.payload.locationId);
      if (location?.name !== event.payload.locationName) continue;

      const previousLocationId = npcLocationById.get(event.payload.npc.id);
      if (previousLocationId !== undefined && previousLocationId !== event.payload.locationId) {
        npcsByLocation.get(previousLocationId)?.delete(event.payload.npc.id);
      }
      const locationNpcs = npcsByLocation.get(event.payload.locationId) ?? new Map();
      locationNpcs.set(event.payload.npc.id, event.payload.npc);
      npcsByLocation.set(event.payload.locationId, locationNpcs);
      npcLocationById.set(event.payload.npc.id, event.payload.locationId);
      continue;
    }

    if (event.type === "location.entered") {
      if (!matchesActiveModule(activeModule, event.payload.moduleId, event.payload.revision)) continue;
      const location = locations.get(event.payload.locationId);
      const character = latestCharacters.get(event.payload.characterId);
      if (
        location?.name !== event.payload.locationName ||
        character?.name !== event.payload.characterName
      ) {
        continue;
      }
      currentLocationByCharacterId.set(event.payload.characterId, event.payload.locationId);
      continue;
    }

    if (event.type === "content.revealed" && event.payload.locationId !== undefined) {
      if (!matchesActiveModule(activeModule, event.payload.moduleId, event.payload.revision)) continue;
      if (!locations.has(event.payload.locationId)) continue;
      const locationContent = contentByLocation.get(event.payload.locationId) ?? new Map();
      locationContent.set(event.payload.contentId, event.payload);
      contentByLocation.set(event.payload.locationId, locationContent);
    }
  }

  const readonlyNpcs = new Map<string, ReadonlyMap<string, PlayerVisibleNpcV1>>();
  for (const [locationId, npcs] of npcsByLocation) readonlyNpcs.set(locationId, new Map(npcs));
  const readonlyContent = new Map<string, readonly ContentRevealedPayloadV1[]>();
  for (const [locationId, contents] of contentByLocation) {
    readonlyContent.set(locationId, [...contents.values()]);
  }

  return {
    ...(activeModule === undefined ? {} : { activeModule }),
    locations: new Map(locations),
    npcsByLocation: readonlyNpcs,
    currentLocationByCharacterId: new Map(currentLocationByCharacterId),
    latestCharacters: new Map(latestCharacters),
    locationContent: readonlyContent,
  };
}

function matchesActiveModule(
  activeModule: ActiveRoomModuleV1 | undefined,
  moduleId: string,
  revision: number,
): boolean {
  return activeModule?.moduleId === moduleId && activeModule.revision === revision;
}

function assertSingleOrderedHistory(events: readonly RoomEventV1[]): void {
  const roomIds = new Set<string>();
  const eventIds = new Set<string>();
  const sequences = new Set<number>();
  for (const event of events) {
    roomIds.add(event.roomId);
    if (eventIds.has(event.eventId)) throw new Error(`Duplicate event ID: ${event.eventId}`);
    if (sequences.has(event.sequence)) throw new Error(`Duplicate event sequence: ${event.sequence}`);
    eventIds.add(event.eventId);
    sequences.add(event.sequence);
  }
  if (roomIds.size > 1) throw new Error("Cannot derive room world state from multiple rooms");
}
