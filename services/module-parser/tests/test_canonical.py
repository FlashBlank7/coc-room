from __future__ import annotations

from datetime import datetime, timezone
from copy import deepcopy

import pytest
from pydantic import ValidationError

from coc_module_parser.canonical import CanonicalModulePackageV1, to_canonical_package
from coc_module_parser.models import (
    CharacterV1,
    ClueV1,
    HandoutV1,
    LocationV1,
    ModuleMetadataV1,
    ModulePackageV1,
    NPCV1,
    SceneV1,
    SourceDocumentV1,
    SourceRefV1,
)


TOP_LEVEL_KEYS = {
    "schemaVersion",
    "moduleId",
    "revision",
    "metadata",
    "overview",
    "sourceDocuments",
    "chapters",
    "scenes",
    "locations",
    "npcs",
    "clues",
    "handouts",
    "suggestedChecks",
    "keeperNotes",
    "relations",
    "extensions",
}


def test_canonical_output_matches_shared_protocol_shape() -> None:
    source_ref = SourceRefV1(chunk_id="chunk-0001", start=0, end=4, excerpt="test")
    internal = ModulePackageV1(
        module_id="module:test",
        metadata=ModuleMetadataV1(title="Test", author="Author", language="zh-CN"),
        source=SourceDocumentV1(name="test.docx", sha256="a" * 64, char_count=4),
        overview="Summary",
        scenes=[
            SceneV1(
                id="scene:test",
                title="Scene",
                location_ids=["location:test"],
                npc_ids=["npc:test"],
                clue_ids=["clue:test"],
                handout_ids=["handout:test"],
                source_refs=[source_ref],
            )
        ],
        locations=[
            LocationV1(
                id="location:test",
                name="Archive",
                aliases=["Old Library", "West Annex"],
                source_refs=[source_ref],
            )
        ],
        npcs=[
            NPCV1(
                id="npc:test",
                name="Keeper",
                traits=["stern", "ink-stained hands"],
                character=CharacterV1(
                    characteristics={"STR": 55, "INT": 80},
                    skills={"Library Use": 70},
                    hit_points=11,
                    sanity=62,
                ),
                source_refs=[source_ref],
            )
        ],
        clues=[
            ClueV1(
                id="clue:test",
                title="Letter",
                content="A letter",
                handout_text="Read me",
                is_core=True,
                scene_ids=["scene:test"],
                source_refs=[source_ref],
            )
        ],
        handouts=[
            HandoutV1(
                id="handout:test",
                title="Invitation",
                description="A sealed invitation",
                content="Come at midnight.",
                scene_ids=["scene:test"],
                source_refs=[source_ref],
            )
        ],
    )
    canonical = to_canonical_package(
        internal,
        normalized_text="test",
        source_media_type="text/markdown",
        generated_at=datetime(2026, 8, 27, 10, 0, tzinfo=timezone.utc),
    )
    payload = canonical.model_dump(mode="json", exclude_none=True)

    assert set(payload) == TOP_LEVEL_KEYS
    assert payload["schemaVersion"] == 1
    assert payload["metadata"] == {
        "title": "Test",
        "authors": ["Author"],
        "language": "zh-CN",
        "summary": "Summary",
        "createdAt": "2026-08-27T10:00:00.000Z",
        "updatedAt": "2026-08-27T10:00:00.000Z",
    }
    assert set(payload["sourceDocuments"][0]) == {"id", "name", "mediaType", "contentHash"}
    assert set(payload["scenes"][0]) == {
        "id",
        "name",
        "description",
        "sourceRefs",
        "synopsis",
        "locationIds",
        "npcIds",
        "clueIds",
        "handoutIds",
        "suggestedCheckIds",
        "keeperNotes",
    }
    assert payload["chapters"] == []
    assert payload["locations"][0]["aliases"] == ["Old Library", "West Annex"]
    assert payload["npcs"][0]["traits"] == ["stern", "ink-stained hands"]
    assert payload["npcs"][0]["character"] == {
        "characteristics": {"STR": 55, "INT": 80},
        "skills": {"Library Use": 70},
        "hitPoints": 11,
        "sanity": 62,
    }
    assert payload["scenes"][0]["handoutIds"] == [
        "handout:test",
        next(item["id"] for item in payload["handouts"] if item["id"] != "handout:test"),
    ]
    assert payload["handouts"][0]["content"] == "Come at midnight."
    assert payload["handouts"][0]["sourceRefs"] == payload["scenes"][0]["sourceRefs"]
    assert payload["clues"][0]["revealText"] == "Read me"
    assert payload["clues"][0]["isCore"] is True
    assert payload["scenes"][0]["sourceRefs"][0]["sourceId"] == payload["sourceDocuments"][0]["id"]
    assert CanonicalModulePackageV1.model_validate(payload) == canonical


def test_keeper_clue_is_not_player_visible_without_explicit_handout() -> None:
    internal = ModulePackageV1(
        module_id="module:hidden",
        metadata=ModuleMetadataV1(title="Hidden"),
        source=SourceDocumentV1(name="hidden.md", sha256="b" * 64, char_count=10),
        clues=[ClueV1(id="clue:hidden", title="Secret", content="Keeper solution")],
    )
    canonical = to_canonical_package(
        internal,
        normalized_text="secret",
        source_media_type="text/markdown",
        generated_at=datetime(2026, 8, 27, 10, 0, tzinfo=timezone.utc),
    )
    assert canonical.clues[0].description == "Keeper solution"
    assert canonical.clues[0].revealText == ""
    assert canonical.handouts == []


def test_canonical_validation_is_strict_and_ids_are_globally_unique() -> None:
    internal = ModulePackageV1(
        module_id="module:strict",
        metadata=ModuleMetadataV1(title="Strict"),
        source=SourceDocumentV1(name="strict.md", sha256="c" * 64, char_count=10),
        scenes=[SceneV1(id="shared:id", title="Scene")],
        clues=[ClueV1(id="clue:one", title="Clue", content="Secret")],
    )
    canonical = to_canonical_package(
        internal,
        normalized_text="strict",
        source_media_type="text/markdown",
        generated_at=datetime(2026, 8, 27, 10, 0, tzinfo=timezone.utc),
    )
    payload = canonical.model_dump(mode="json")
    coerced = deepcopy(payload)
    coerced["revision"] = "1"
    with pytest.raises(ValidationError):
        CanonicalModulePackageV1.model_validate(coerced)

    duplicate = deepcopy(payload)
    duplicate["clues"][0]["id"] = "shared:id"
    with pytest.raises(ValidationError, match="shared"):
        CanonicalModulePackageV1.model_validate(duplicate)
