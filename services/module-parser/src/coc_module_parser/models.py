from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    field_validator,
    model_validator,
)


ENTITY_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
EXTENSION_NAMESPACE_PATTERN = r"^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)


class SourceRefV1(StrictModel):
    """Character offsets refer to the normalized source text."""

    chunk_id: str = Field(min_length=1, max_length=128)
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    excerpt: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def validate_range(self) -> SourceRefV1:
        if self.end <= self.start:
            raise ValueError("source reference end must be greater than start")
        return self


class SourceDocumentV1(StrictModel):
    name: str = Field(min_length=1, max_length=260)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    char_count: int = Field(ge=0)


class ModuleMetadataV1(StrictModel):
    title: str = Field(min_length=1, max_length=300)
    author: str | None = Field(default=None, max_length=200)
    system: Literal["CoC 7e"] = "CoC 7e"
    language: str | None = Field(default=None, max_length=35)
    tags: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("tags")
    @classmethod
    def unique_tags(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(value.strip() for value in values if value.strip()))


class ChapterV1(StrictModel):
    id: str = Field(pattern=ENTITY_ID_PATTERN)
    title: str = Field(min_length=1, max_length=300)
    summary: str = Field(default="", max_length=10_000)
    scene_ids: list[str] = Field(default_factory=list)


class LocationV1(StrictModel):
    id: str = Field(pattern=ENTITY_ID_PATTERN)
    name: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=30_000)
    features: list[str] = Field(default_factory=list)
    aliases: list[str] = Field(
        default_factory=list,
        max_length=50,
        description="Alternative names for this same place stated in the source.",
    )
    source_refs: list[SourceRefV1] = Field(default_factory=list)

    @field_validator("aliases")
    @classmethod
    def unique_aliases(cls, values: list[str]) -> list[str]:
        cleaned = list(dict.fromkeys(value.strip() for value in values if value.strip()))
        if any(len(value) > 160 for value in cleaned):
            raise ValueError("location aliases must contain at most 160 characters")
        return cleaned


class CharacterV1(StrictModel):
    characteristics: dict[str, int] = Field(default_factory=dict)
    skills: dict[str, int] = Field(default_factory=dict)
    hit_points: int | None = Field(default=None, ge=0, le=99)
    sanity: int | None = Field(default=None, ge=0, le=100)

    @field_validator("characteristics", "skills")
    @classmethod
    def validate_percentages(cls, values: dict[str, int]) -> dict[str, int]:
        if any(isinstance(value, bool) or not 0 <= value <= 100 for value in values.values()):
            raise ValueError("characteristic and skill values must be integers from 0 to 100")
        return values


class NPCV1(StrictModel):
    id: str = Field(pattern=ENTITY_ID_PATTERN)
    name: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=30_000)
    role: str = Field(default="", max_length=1_000)
    motivations: list[str] = Field(default_factory=list, max_length=100)
    traits: list[str] = Field(default_factory=list, max_length=100)
    character: CharacterV1 | None = Field(
        default=None,
        description="Only CoC statistics explicitly printed in the source; never infer values.",
    )
    source_refs: list[SourceRefV1] = Field(default_factory=list)

    @field_validator("traits")
    @classmethod
    def validate_traits(cls, values: list[str]) -> list[str]:
        cleaned = list(dict.fromkeys(value.strip() for value in values if value.strip()))
        if any(len(value) > 500 for value in cleaned):
            raise ValueError("NPC traits must contain at most 500 characters")
        return cleaned


class ClueV1(StrictModel):
    id: str = Field(pattern=ENTITY_ID_PATTERN)
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(
        min_length=1,
        max_length=30_000,
        description="Keeper-facing clue details, including hidden meaning and consequences.",
    )
    handout_text: str | None = Field(
        default=None,
        max_length=30_000,
        description=(
            "Exact player-safe text explicitly present in the source. Leave null when the "
            "source does not provide a handout or player-facing wording."
        ),
    )
    is_core: bool = Field(
        default=False,
        description="True only when the source makes this clue essential to progression.",
    )
    scene_ids: list[str] = Field(default_factory=list)
    location_ids: list[str] = Field(default_factory=list)
    source_refs: list[SourceRefV1] = Field(default_factory=list)


class CheckDifficulty(str, Enum):
    REGULAR = "regular"
    HARD = "hard"
    EXTREME = "extreme"


class SuggestedCheckV1(StrictModel):
    id: str = Field(pattern=ENTITY_ID_PATTERN)
    skill: str = Field(min_length=1, max_length=200)
    difficulty: CheckDifficulty = CheckDifficulty.REGULAR
    purpose: str = Field(default="", max_length=2_000)
    success: str = Field(default="", max_length=10_000)
    failure: str = Field(default="", max_length=10_000)
    scene_id: str | None = None
    source_refs: list[SourceRefV1] = Field(default_factory=list)


class SceneV1(StrictModel):
    id: str = Field(pattern=ENTITY_ID_PATTERN)
    title: str = Field(min_length=1, max_length=300)
    summary: str = Field(default="", max_length=30_000)
    location_ids: list[str] = Field(default_factory=list)
    npc_ids: list[str] = Field(default_factory=list)
    clue_ids: list[str] = Field(default_factory=list)
    handout_ids: list[str] = Field(default_factory=list, max_length=200)
    suggested_check_ids: list[str] = Field(default_factory=list)
    keeper_notes: list[str] = Field(default_factory=list)
    source_refs: list[SourceRefV1] = Field(default_factory=list)


class HandoutV1(StrictModel):
    id: str = Field(pattern=ENTITY_ID_PATTERN)
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(default="", max_length=20_000)
    content: str = Field(
        min_length=1,
        max_length=50_000,
        description="Exact player-facing document text from the source, not a keeper summary.",
    )
    scene_ids: list[str] = Field(default_factory=list)
    source_refs: list[SourceRefV1] = Field(default_factory=list)


class EntityRelationV1(StrictModel):
    source_id: str = Field(pattern=ENTITY_ID_PATTERN)
    target_id: str = Field(pattern=ENTITY_ID_PATTERN)
    relation: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2_000)
    source_refs: list[SourceRefV1] = Field(default_factory=list)


class KeeperNoteV1(StrictModel):
    id: str = Field(pattern=ENTITY_ID_PATTERN)
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(min_length=1, max_length=30_000)
    scene_ids: list[str] = Field(default_factory=list)
    source_refs: list[SourceRefV1] = Field(default_factory=list)


def _validate_extensions(value: dict[str, Any]) -> dict[str, Any]:
    import re

    invalid = [key for key in value if not re.fullmatch(EXTENSION_NAMESPACE_PATTERN, key)]
    if invalid:
        raise ValueError(
            "extension keys must be reverse-domain-like namespaces; invalid: "
            + ", ".join(sorted(invalid))
        )
    return value


class ModulePackageV1(StrictModel):
    schema_version: Literal["1.0"] = "1.0"
    module_id: str = Field(pattern=ENTITY_ID_PATTERN)
    metadata: ModuleMetadataV1
    source: SourceDocumentV1
    overview: str = Field(default="", max_length=50_000)
    chapters: list[ChapterV1] = Field(default_factory=list)
    scenes: list[SceneV1] = Field(default_factory=list)
    locations: list[LocationV1] = Field(default_factory=list)
    npcs: list[NPCV1] = Field(default_factory=list)
    clues: list[ClueV1] = Field(default_factory=list)
    handouts: list[HandoutV1] = Field(default_factory=list, max_length=5_000)
    suggested_checks: list[SuggestedCheckV1] = Field(default_factory=list)
    keeper_notes: list[KeeperNoteV1] = Field(default_factory=list)
    relations: list[EntityRelationV1] = Field(default_factory=list)
    extensions: dict[str, Any] = Field(default_factory=dict)

    _extensions = field_validator("extensions")(_validate_extensions)

    @model_validator(mode="after")
    def validate_references(self) -> ModulePackageV1:
        collections: list[tuple[str, list[Any]]] = [
            ("chapter", self.chapters),
            ("scene", self.scenes),
            ("location", self.locations),
            ("npc", self.npcs),
            ("clue", self.clues),
            ("handout", self.handouts),
            ("suggested_check", self.suggested_checks),
            ("keeper_note", self.keeper_notes),
        ]
        seen: dict[str, str] = {}
        for kind, items in collections:
            for item in items:
                if item.id in seen:
                    raise ValueError(
                        f"duplicate entity id {item.id!r} in {seen[item.id]} and {kind}"
                    )
                seen[item.id] = kind

        scene_ids = {item.id for item in self.scenes}
        location_ids = {item.id for item in self.locations}
        npc_ids = {item.id for item in self.npcs}
        clue_ids = {item.id for item in self.clues}
        handout_ids = {item.id for item in self.handouts}
        check_ids = {item.id for item in self.suggested_checks}

        def require(values: list[str], allowed: set[str], context: str) -> None:
            unknown = sorted(set(values) - allowed)
            if unknown:
                raise ValueError(f"{context} references unknown ids: {', '.join(unknown)}")

        for chapter in self.chapters:
            require(chapter.scene_ids, scene_ids, f"chapter {chapter.id}")
        for scene in self.scenes:
            require(scene.location_ids, location_ids, f"scene {scene.id} locations")
            require(scene.npc_ids, npc_ids, f"scene {scene.id} npcs")
            require(scene.clue_ids, clue_ids, f"scene {scene.id} clues")
            require(scene.handout_ids, handout_ids, f"scene {scene.id} handouts")
            require(
                scene.suggested_check_ids,
                check_ids,
                f"scene {scene.id} suggested checks",
            )
        for clue in self.clues:
            require(clue.scene_ids, scene_ids, f"clue {clue.id} scenes")
            require(clue.location_ids, location_ids, f"clue {clue.id} locations")
        for handout in self.handouts:
            require(handout.scene_ids, scene_ids, f"handout {handout.id} scenes")
        for check in self.suggested_checks:
            if check.scene_id is not None:
                require([check.scene_id], scene_ids, f"suggested check {check.id}")
        for note in self.keeper_notes:
            require(note.scene_ids, scene_ids, f"keeper note {note.id}")
        all_ids = set(seen)
        for relation in self.relations:
            require([relation.source_id], all_ids, "relation source")
            require([relation.target_id], all_ids, "relation target")

        for item in (
            self.scenes
            + self.locations
            + self.npcs
            + self.clues
            + self.handouts
            + self.suggested_checks
            + self.keeper_notes
            + self.relations
        ):
            for ref in item.source_refs:
                if ref.end > self.source.char_count:
                    raise ValueError(
                        f"source reference {ref.start}:{ref.end} exceeds document length"
                    )
        return self


class FragmentMetadataV1(StrictModel):
    title: str | None = Field(default=None, max_length=300)
    author: str | None = Field(default=None, max_length=200)
    language: str | None = Field(default=None, max_length=35)
    tags: list[str] = Field(default_factory=list, max_length=50)


class ModuleFragmentV1(StrictModel):
    """Schema requested from the model for one source chunk."""

    schema_version: Literal["1.0"] = "1.0"
    metadata: FragmentMetadataV1 = Field(default_factory=FragmentMetadataV1)
    overview_notes: list[str] = Field(default_factory=list)
    scenes: list[SceneV1] = Field(default_factory=list)
    locations: list[LocationV1] = Field(default_factory=list)
    npcs: list[NPCV1] = Field(default_factory=list)
    clues: list[ClueV1] = Field(default_factory=list)
    handouts: list[HandoutV1] = Field(default_factory=list, max_length=5_000)
    suggested_checks: list[SuggestedCheckV1] = Field(default_factory=list)
    keeper_notes: list[KeeperNoteV1] = Field(default_factory=list)
    relations: list[EntityRelationV1] = Field(default_factory=list)
    extensions: dict[str, Any] = Field(default_factory=dict)

    _extensions = field_validator("extensions")(_validate_extensions)


class IssueSeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


class ParseIssueV1(StrictModel):
    severity: IssueSeverity
    code: str = Field(pattern=r"^[A-Z][A-Z0-9_]{1,63}$")
    stage: str = Field(min_length=1, max_length=80)
    message: str = Field(min_length=1, max_length=2_000)
    entity_id: str | None = None
    chunk_id: str | None = None
    retryable: bool = False
    source_ref: SourceRefV1 | None = None


class ParseResultV1(StrictModel):
    status: Literal["ready_for_review", "needs_review"]
    module: ModulePackageV1
    issues: list[ParseIssueV1] = Field(default_factory=list)
    extraction_attempts: int = Field(ge=0)


class ParseConfig(StrictModel):
    source_text: str = Field(min_length=1, max_length=5_000_000)
    source_name: str = Field(default="pasted-text.md", min_length=1, max_length=260)
    source_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    source_media_type: Literal["text/plain", "text/markdown"] = "text/markdown"
    provider: Literal["deepseek", "codex"] = "deepseek"
    model: str = Field(default="deepseek-v4-flash", max_length=100)
    mock: bool = False
    api_key: SecretStr | None = Field(default=None, exclude=True, repr=False)
    base_url: str = Field(default="https://api.deepseek.com", max_length=500)
    codex_executable: Path | None = None
    max_chunk_chars: int = Field(default=12_000, ge=1_000, le=100_000)
    chunk_overlap_chars: int = Field(default=500, ge=0, le=10_000)
    max_retries: int = Field(default=2, ge=0, le=5)
    max_output_tokens: int = Field(default=16_000, ge=1_000, le=64_000)
    max_codex_chunks: int = Field(default=64, ge=1, le=128)
    max_codex_attempts: int = Field(default=96, ge=1, le=192)
    cache_dir: Path | None = None
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @model_validator(mode="after")
    def validate_chunking(self) -> ParseConfig:
        if self.chunk_overlap_chars >= self.max_chunk_chars:
            raise ValueError("chunk_overlap_chars must be smaller than max_chunk_chars")
        if not self.mock and self.provider == "deepseek" and self.api_key is None:
            raise ValueError("api_key is required for the DeepSeek provider")
        if not self.mock and self.provider == "deepseek" and not self.model.strip():
            raise ValueError("model is required for the DeepSeek provider")
        if self.generated_at.tzinfo is None or self.generated_at.utcoffset() is None:
            raise ValueError("generated_at must include a timezone offset")
        return self


_MIGRATION_KEY_ALIASES = {
    "moduleId": "module_id",
    "schemaVersion": "schema_version",
    "suggestedChecks": "suggested_checks",
    "keeperNotes": "keeper_notes",
    "sourceRefs": "source_refs",
    "sceneIds": "scene_ids",
    "locationIds": "location_ids",
    "npcIds": "npc_ids",
    "clueIds": "clue_ids",
    "handoutIds": "handout_ids",
    "suggestedCheckIds": "suggested_check_ids",
    "handoutText": "handout_text",
    "isCore": "is_core",
    "hitPoints": "hit_points",
    "sceneId": "scene_id",
    "sourceId": "source_id",
    "targetId": "target_id",
    "charCount": "char_count",
    "chunkId": "chunk_id",
}


def _rename_legacy_keys(value: Any) -> Any:
    if isinstance(value, list):
        return [_rename_legacy_keys(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {
        _MIGRATION_KEY_ALIASES.get(key, key): _rename_legacy_keys(item)
        for key, item in value.items()
    }


def migrate_module_package(payload: dict[str, Any]) -> ModulePackageV1:
    """Migrate the single pre-v1 draft shape, then validate the canonical package."""

    migrated = _rename_legacy_keys(deepcopy(payload))
    version = str(migrated.get("schema_version", "0.1"))
    if version not in {"0.1", "1.0"}:
        raise ValueError(f"unsupported module schema version: {version}")
    if version == "0.1":
        title = migrated.pop("title", None)
        author = migrated.pop("author", None)
        metadata = migrated.setdefault("metadata", {})
        if title is not None:
            metadata.setdefault("title", title)
        if author is not None:
            metadata.setdefault("author", author)
        migrated["schema_version"] = "1.0"
        migrated.setdefault("chapters", [])
        migrated.setdefault("keeper_notes", [])
        migrated.setdefault("extensions", {})
    return ModulePackageV1.model_validate(migrated)


def _deep_merge(base: Any, updates: Any) -> Any:
    if isinstance(base, dict) and isinstance(updates, dict):
        merged = deepcopy(base)
        for key, value in updates.items():
            merged[key] = _deep_merge(merged.get(key), value)
        return merged
    return deepcopy(updates)


def apply_manual_corrections(
    package: ModulePackageV1 | dict[str, Any], updates: dict[str, Any]
) -> ModulePackageV1:
    """Apply editor changes; lists are intentionally replaced as atomic values."""

    current = (
        package.model_dump(mode="json")
        if isinstance(package, ModulePackageV1)
        else deepcopy(package)
    )
    return ModulePackageV1.model_validate(_deep_merge(current, updates))
