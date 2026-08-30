from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .models import ModulePackageV1, SourceRefV1
from .text import stable_id


ENTITY_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"


class CanonicalModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class CanonicalSourceReferenceV1(CanonicalModel):
    sourceId: str = Field(pattern=ENTITY_ID_PATTERN)
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    excerpt: str | None = Field(default=None, max_length=2_000)

    @model_validator(mode="after")
    def validate_range(self) -> CanonicalSourceReferenceV1:
        if self.end < self.start:
            raise ValueError("end must be greater than or equal to start")
        return self


class CanonicalMetadataV1(CanonicalModel):
    title: str = Field(min_length=1, max_length=240)
    authors: list[str] = Field(max_length=32)
    language: str = Field(min_length=2, max_length=35)
    source: str | None = Field(default=None, max_length=500)
    summary: str = Field(max_length=8_000)
    createdAt: str
    updatedAt: str

    @field_validator("authors")
    @classmethod
    def validate_authors(cls, values: list[str]) -> list[str]:
        for value in values:
            if not 1 <= len(value) <= 160:
                raise ValueError("author length must be between 1 and 160")
        return values

    @field_validator("createdAt", "updatedAt")
    @classmethod
    def validate_datetime(cls, value: str) -> str:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("must be an ISO 8601 datetime") from exc
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("datetime must include an offset")
        return value


class CanonicalSourceDocumentV1(CanonicalModel):
    id: str = Field(pattern=ENTITY_ID_PATTERN)
    name: str = Field(min_length=1, max_length=240)
    mediaType: Literal["text/plain", "text/markdown"]
    contentHash: str | None = Field(default=None, min_length=8, max_length=128)


class CanonicalChapterV1(CanonicalModel):
    id: str = Field(pattern=ENTITY_ID_PATTERN)
    title: str = Field(min_length=1, max_length=240)
    order: int = Field(ge=0)
    sceneIds: list[str] = Field(max_length=500)
    notes: str = Field(max_length=20_000)


class CanonicalEntityBase(CanonicalModel):
    id: str = Field(pattern=ENTITY_ID_PATTERN)
    name: str = Field(min_length=1, max_length=240)
    description: str = Field(max_length=20_000)
    sourceRefs: list[CanonicalSourceReferenceV1] = Field(max_length=100)


class CanonicalSceneV1(CanonicalEntityBase):
    synopsis: str = Field(max_length=20_000)
    locationIds: list[str] = Field(max_length=100)
    npcIds: list[str] = Field(max_length=200)
    clueIds: list[str] = Field(max_length=200)
    handoutIds: list[str] = Field(max_length=200)
    suggestedCheckIds: list[str] = Field(max_length=100)
    keeperNotes: str = Field(max_length=20_000)


class CanonicalLocationV1(CanonicalEntityBase):
    playerDescription: str | None = Field(default=None, max_length=20_000)
    aliases: list[str] = Field(max_length=50)

    @field_validator("aliases")
    @classmethod
    def validate_aliases(cls, values: list[str]) -> list[str]:
        if any(not 1 <= len(value) <= 160 for value in values):
            raise ValueError("location aliases must contain 1 to 160 characters")
        return values


class CanonicalCharacterV1(CanonicalModel):
    characteristics: dict[str, int]
    skills: dict[str, int]
    hitPoints: int | None = Field(default=None, ge=0, le=99)
    sanity: int | None = Field(default=None, ge=0, le=100)

    @field_validator("characteristics", "skills")
    @classmethod
    def validate_percentages(cls, values: dict[str, int]) -> dict[str, int]:
        if any(isinstance(value, bool) or not 0 <= value <= 100 for value in values.values()):
            raise ValueError("characteristic and skill values must be integers from 0 to 100")
        return values


class CanonicalNpcV1(CanonicalEntityBase):
    playerDescription: str | None = Field(default=None, max_length=20_000)
    role: str = Field(max_length=1_000)
    motivation: str = Field(max_length=4_000)
    traits: list[str] = Field(max_length=100)
    character: CanonicalCharacterV1 | None = None

    @field_validator("traits")
    @classmethod
    def validate_traits(cls, values: list[str]) -> list[str]:
        if any(not 1 <= len(value) <= 500 for value in values):
            raise ValueError("NPC traits must contain 1 to 500 characters")
        return values


class CanonicalClueV1(CanonicalEntityBase):
    revealText: str = Field(max_length=20_000)
    isCore: bool


class CanonicalHandoutV1(CanonicalEntityBase):
    title: str = Field(min_length=1, max_length=240)
    content: str = Field(max_length=50_000)


class CanonicalSuggestedCheckV1(CanonicalModel):
    id: str = Field(pattern=ENTITY_ID_PATTERN)
    skill: str = Field(min_length=1, max_length=160)
    difficulty: Literal["regular", "hard", "extreme"]
    purpose: str = Field(max_length=4_000)
    onSuccess: str = Field(max_length=8_000)
    onFailure: str = Field(max_length=8_000)
    sourceRefs: list[CanonicalSourceReferenceV1] = Field(max_length=100)


class CanonicalKeeperNoteV1(CanonicalModel):
    id: str = Field(pattern=ENTITY_ID_PATTERN)
    title: str = Field(min_length=1, max_length=240)
    content: str = Field(max_length=50_000)
    relatedEntityIds: list[str] = Field(max_length=200)
    sourceRefs: list[CanonicalSourceReferenceV1] = Field(max_length=100)


class CanonicalRelationV1(CanonicalModel):
    id: str = Field(pattern=ENTITY_ID_PATTERN)
    fromEntityId: str = Field(pattern=ENTITY_ID_PATTERN)
    toEntityId: str = Field(pattern=ENTITY_ID_PATTERN)
    kind: str = Field(min_length=1, max_length=120)
    description: str = Field(max_length=4_000)
    sourceRefs: list[CanonicalSourceReferenceV1] = Field(max_length=100)


class CanonicalModulePackageV1(CanonicalModel):
    """Python mirror of packages/protocol/src/schemas/module.ts."""

    schemaVersion: Literal[1] = 1
    moduleId: str = Field(pattern=ENTITY_ID_PATTERN)
    revision: int = Field(gt=0)
    metadata: CanonicalMetadataV1
    overview: str = Field(max_length=50_000)
    sourceDocuments: list[CanonicalSourceDocumentV1] = Field(max_length=100)
    chapters: list[CanonicalChapterV1] = Field(max_length=500)
    scenes: list[CanonicalSceneV1] = Field(max_length=2_000)
    locations: list[CanonicalLocationV1] = Field(max_length=2_000)
    npcs: list[CanonicalNpcV1] = Field(max_length=5_000)
    clues: list[CanonicalClueV1] = Field(max_length=5_000)
    handouts: list[CanonicalHandoutV1] = Field(max_length=5_000)
    suggestedChecks: list[CanonicalSuggestedCheckV1] = Field(max_length=5_000)
    keeperNotes: list[CanonicalKeeperNoteV1] = Field(max_length=5_000)
    relations: list[CanonicalRelationV1] = Field(max_length=20_000)
    extensions: dict[str, Any]

    @model_validator(mode="after")
    def validate_references(self) -> CanonicalModulePackageV1:
        collections: dict[str, list[Any]] = {
            "sourceDocuments": self.sourceDocuments,
            "chapters": self.chapters,
            "scenes": self.scenes,
            "locations": self.locations,
            "npcs": self.npcs,
            "clues": self.clues,
            "handouts": self.handouts,
            "suggestedChecks": self.suggestedChecks,
            "keeperNotes": self.keeperNotes,
            "relations": self.relations,
        }
        ids: dict[str, set[str]] = {}
        for name, items in collections.items():
            values = [item.id for item in items]
            if len(values) != len(set(values)):
                raise ValueError(f"duplicate entity id in {name}")
            ids[name] = set(values)

        globally_unique_collections = (
            "chapters",
            "scenes",
            "locations",
            "npcs",
            "clues",
            "handouts",
            "suggestedChecks",
            "keeperNotes",
        )
        seen_entity_ids: dict[str, str] = {}
        for name in globally_unique_collections:
            for entity_id in ids[name]:
                previous = seen_entity_ids.get(entity_id)
                if previous is not None:
                    raise ValueError(
                        f"entity id {entity_id!r} is shared by {previous} and {name}"
                    )
                seen_entity_ids[entity_id] = name

        def require(values: list[str], allowed: set[str], context: str) -> None:
            unknown = set(values) - allowed
            if unknown:
                raise ValueError(f"{context} has unknown references: {sorted(unknown)}")

        for chapter in self.chapters:
            require(chapter.sceneIds, ids["scenes"], f"chapter {chapter.id}")
        for scene in self.scenes:
            require(scene.locationIds, ids["locations"], f"scene {scene.id}")
            require(scene.npcIds, ids["npcs"], f"scene {scene.id}")
            require(scene.clueIds, ids["clues"], f"scene {scene.id}")
            require(scene.handoutIds, ids["handouts"], f"scene {scene.id}")
            require(scene.suggestedCheckIds, ids["suggestedChecks"], f"scene {scene.id}")
        all_entity_ids = set().union(
            ids["chapters"],
            ids["scenes"],
            ids["locations"],
            ids["npcs"],
            ids["clues"],
            ids["handouts"],
            ids["suggestedChecks"],
            ids["keeperNotes"],
        )
        for note in self.keeperNotes:
            require(note.relatedEntityIds, all_entity_ids, f"keeper note {note.id}")
        for relation in self.relations:
            require([relation.fromEntityId, relation.toEntityId], all_entity_ids, relation.id)
        entities_with_sources = (
            self.scenes
            + self.locations
            + self.npcs
            + self.clues
            + self.handouts
            + self.suggestedChecks
            + self.keeperNotes
            + self.relations
        )
        for entity in entities_with_sources:
            require(
                [reference.sourceId for reference in entity.sourceRefs],
                ids["sourceDocuments"],
                f"source refs for {entity.id}",
            )
        return self


def _timestamp(value: datetime) -> str:
    return (
        value.astimezone(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _source_refs(
    values: list[SourceRefV1], source_id: str
) -> list[CanonicalSourceReferenceV1]:
    return [
        CanonicalSourceReferenceV1(
            sourceId=source_id,
            start=value.start,
            end=value.end,
            excerpt=value.excerpt or None,
        )
        for value in values[:100]
    ]


def _append_features(description: str, features: list[str]) -> str:
    if not features:
        return description[:100_000]
    suffix = "\n\n" + "\n".join(f"- {value}" for value in features)
    return (description + suffix)[:100_000]


def _unique_ids(values: list[str], limit: int) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))[:limit]


def to_canonical_package(
    package: ModulePackageV1,
    *,
    normalized_text: str,
    source_media_type: Literal["text/plain", "text/markdown"],
    generated_at: datetime,
) -> CanonicalModulePackageV1:
    source_id = stable_id("source", package.source.sha256)
    generated = _timestamp(generated_at)
    used_handout_ids = {
        item.id
        for item in (
            package.chapters
            + package.scenes
            + package.locations
            + package.npcs
            + package.clues
            + package.handouts
            + package.suggested_checks
            + package.keeper_notes
        )
    }
    handout_by_clue: dict[str, str] = {}
    for clue in package.clues:
        if not clue.handout_text:
            continue
        suffix = 0
        candidate = stable_id("handout", clue.id)
        while candidate in used_handout_ids:
            suffix += 1
            candidate = stable_id("handout", f"{clue.id}:{suffix}")
        used_handout_ids.add(candidate)
        handout_by_clue[clue.id] = candidate

    independent_handouts = [
        CanonicalHandoutV1(
            id=handout.id,
            name=handout.title,
            title=handout.title,
            description=handout.description,
            content=handout.content,
            sourceRefs=_source_refs(handout.source_refs, source_id),
        )
        for handout in package.handouts
    ]
    legacy_clue_handouts = [
        CanonicalHandoutV1(
            id=handout_by_clue[clue.id],
            name=clue.title[:240],
            title=clue.title[:240],
            description=clue.content[:100_000],
            content=(clue.handout_text or "")[:200_000],
            sourceRefs=_source_refs(clue.source_refs, source_id),
        )
        for clue in package.clues
        if clue.id in handout_by_clue
    ]
    handouts = (independent_handouts + legacy_clue_handouts)[:5_000]
    emitted_handout_ids = {handout.id for handout in handouts}
    handouts_by_scene: dict[str, list[str]] = {}
    for handout in package.handouts:
        if handout.id not in emitted_handout_ids:
            continue
        for scene_id in handout.scene_ids:
            handouts_by_scene.setdefault(scene_id, []).append(handout.id)
    overview = package.overview[:200_000]
    source_summary = re.sub(
        r"(?m)^<!-- coc-room-pdf-page:\d+ -->\s*",
        "",
        normalized_text,
    ).strip()
    summary = (package.overview or source_summary)[:50_000]
    authors = [package.metadata.author[:160]] if package.metadata.author else []
    language = package.metadata.language or "zh-CN"
    if len(language) < 2:
        language = "zh-CN"

    return CanonicalModulePackageV1(
        schemaVersion=1,
        moduleId=package.module_id,
        revision=1,
        metadata=CanonicalMetadataV1(
            title=package.metadata.title[:240],
            authors=authors,
            language=language[:35],
            summary=summary,
            createdAt=generated,
            updatedAt=generated,
        ),
        overview=overview,
        sourceDocuments=[
            CanonicalSourceDocumentV1(
                id=source_id,
                name=package.source.name[:240],
                mediaType=source_media_type,
                contentHash=package.source.sha256,
            )
        ],
        chapters=[
            CanonicalChapterV1(
                id=chapter.id,
                title=chapter.title[:240],
                order=index,
                sceneIds=chapter.scene_ids[:500],
                notes=chapter.summary[:100_000],
            )
            for index, chapter in enumerate(package.chapters[:500])
        ],
        scenes=[
            CanonicalSceneV1(
                id=scene.id,
                name=scene.title[:240],
                description=scene.summary[:100_000],
                synopsis=scene.summary[:100_000],
                locationIds=scene.location_ids[:100],
                npcIds=scene.npc_ids[:200],
                clueIds=scene.clue_ids[:200],
                handoutIds=_unique_ids(
                    [
                        *[
                            handout_id
                            for handout_id in scene.handout_ids
                            if handout_id in emitted_handout_ids
                        ],
                        *handouts_by_scene.get(scene.id, []),
                        *[
                            handout_by_clue[clue_id]
                            for clue_id in scene.clue_ids
                            if clue_id in handout_by_clue
                            and handout_by_clue[clue_id] in emitted_handout_ids
                        ],
                    ],
                    200,
                ),
                suggestedCheckIds=scene.suggested_check_ids[:100],
                keeperNotes="\n\n".join(scene.keeper_notes)[:100_000],
                sourceRefs=_source_refs(scene.source_refs, source_id),
            )
            for scene in package.scenes[:2_000]
        ],
        locations=[
            CanonicalLocationV1(
                id=location.id,
                name=location.name[:240],
                description=_append_features(location.description, location.features),
                playerDescription=location.player_description,
                aliases=location.aliases,
                sourceRefs=_source_refs(location.source_refs, source_id),
            )
            for location in package.locations[:2_000]
        ],
        npcs=[
            CanonicalNpcV1(
                id=npc.id,
                name=npc.name[:240],
                description=npc.description[:100_000],
                playerDescription=npc.player_description,
                role=npc.role[:1_000],
                motivation="\n".join(npc.motivations)[:20_000],
                traits=[trait[:500] for trait in npc.traits[:100] if trait],
                character=(
                    CanonicalCharacterV1(
                        characteristics=npc.character.characteristics,
                        skills=npc.character.skills,
                        hitPoints=npc.character.hit_points,
                        sanity=npc.character.sanity,
                    )
                    if npc.character is not None
                    else None
                ),
                sourceRefs=_source_refs(npc.source_refs, source_id),
            )
            for npc in package.npcs[:5_000]
        ],
        clues=[
            CanonicalClueV1(
                id=clue.id,
                name=clue.title[:240],
                description=clue.content[:100_000],
                revealText=(clue.handout_text or "")[:100_000],
                isCore=clue.is_core,
                sourceRefs=_source_refs(clue.source_refs, source_id),
            )
            for clue in package.clues[:5_000]
        ],
        handouts=handouts,
        suggestedChecks=[
            CanonicalSuggestedCheckV1(
                id=check.id,
                skill=check.skill[:160],
                difficulty=check.difficulty.value,
                purpose=check.purpose[:20_000],
                onSuccess=check.success[:50_000],
                onFailure=check.failure[:50_000],
                sourceRefs=_source_refs(check.source_refs, source_id),
            )
            for check in package.suggested_checks[:5_000]
        ],
        keeperNotes=[
            CanonicalKeeperNoteV1(
                id=note.id,
                title=note.title[:240],
                content=note.content[:200_000],
                relatedEntityIds=note.scene_ids[:200],
                sourceRefs=_source_refs(note.source_refs, source_id),
            )
            for note in package.keeper_notes[:5_000]
        ],
        relations=[
            CanonicalRelationV1(
                id=stable_id(
                    "relation",
                    f"{relation.source_id}|{relation.target_id}|{relation.relation}",
                ),
                fromEntityId=relation.source_id,
                toEntityId=relation.target_id,
                kind=relation.relation[:120],
                description=relation.description[:20_000],
                sourceRefs=_source_refs(relation.source_refs, source_id),
            )
            for relation in package.relations[:20_000]
        ],
        extensions=package.extensions,
    )
