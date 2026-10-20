import { coc7CharacterSchema, type Coc7Character, type RoomWorldStateV2, type TableSeatV2, type CharacterBriefingV1 } from "@coc-room/protocol";
import { allocateExistingSkillValues, applyOccupationProfile, enableSkillAllocation, occupationProfiles } from "./character-skill-allocation";

/** Keep old rooms usable; once positions exist, only cards placed at the table are active. */
export function tableCharacters(world: RoomWorldStateV2): Coc7Character[] {
  if (!world.tableSeats?.size) return [...world.latestCharacters.values()];
  return [...world.tableSeats.values()].flatMap((seat) => {
    const card = seat.characterId ? world.latestCharacters.get(seat.characterId) : undefined;
    return card ? [card] : [];
  });
}

export function cardForTable(character: Coc7Character, seat: TableSeatV2, world: RoomWorldStateV2, forceCopy = false): Coc7Character {
  const ownerPeerId = seat.occupantSeatId ?? seat.keeperSeatId;
  const existing = world.latestCharacters.get(character.id);
  const elsewhere = [...world.tableSeats.values()].some((item) => item.tableSeatId !== seat.tableSeatId && item.characterId === character.id);
  return coc7CharacterSchema.parse({ ...character,
    id: forceCopy || elsewhere || (existing && existing.ownerPeerId !== ownerPeerId) ? crypto.randomUUID() : character.id,
    ownerPeerId, updatedAt: new Date().toISOString(),
  });
}

export function prepareGeneratedCharacter(character: Coc7Character, briefing?: CharacterBriefingV1): Coc7Character {
  let generated = coc7CharacterSchema.parse(character);
  if (briefing?.skillPointMode && !generated.creation) {
    generated = enableSkillAllocation(generated);
    const profile = occupationProfiles.find((item) => item.name === generated.occupation);
    if (profile) generated = allocateExistingSkillValues(applyOccupationProfile(generated, profile.name), briefing);
  }
  return generated;
}
