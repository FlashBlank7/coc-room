from __future__ import annotations

import hashlib

import pytest
from pydantic import ValidationError

from coc_module_parser.models import (
    LocationV1,
    ModuleMetadataV1,
    ModulePackageV1,
    NPCV1,
    ParseConfig,
    SceneV1,
    SourceDocumentV1,
    apply_manual_corrections,
    migrate_module_package,
)


def package() -> ModulePackageV1:
    text = "test"
    return ModulePackageV1(
        module_id="module:test",
        metadata=ModuleMetadataV1(title="Test"),
        source=SourceDocumentV1(
            name="test.md",
            sha256=hashlib.sha256(text.encode()).hexdigest(),
            char_count=len(text),
        ),
    )


def test_module_package_rejects_unknown_reference() -> None:
    with pytest.raises(ValidationError, match="unknown ids"):
        ModulePackageV1(
            **package().model_dump(exclude={"scenes"}),
            scenes=[SceneV1(id="scene:test", title="Test", npc_ids=["npc:missing"])],
        )


def test_migrates_pre_v1_camel_case_shape() -> None:
    old = package().model_dump(mode="json")
    old.pop("metadata")
    old["title"] = "Legacy title"
    old["author"] = "Legacy author"
    old["schemaVersion"] = "0.1"
    old["moduleId"] = old.pop("module_id")
    old["source"]["charCount"] = old["source"].pop("char_count")
    old.pop("schema_version")
    old["locations"] = [
        {
            "id": "location:legacy",
            "name": "Legacy hall",
            "playerDescription": "A long hall with faded wallpaper.",
        }
    ]
    old["npcs"] = [
        {
            "id": "npc:legacy",
            "name": "Legacy host",
            "playerDescription": "A host wearing a grey coat.",
        }
    ]

    migrated = migrate_module_package(old)

    assert migrated.schema_version == "1.0"
    assert migrated.metadata.title == "Legacy title"
    assert migrated.metadata.author == "Legacy author"
    assert migrated.locations[0].player_description == (
        "A long hall with faded wallpaper."
    )
    assert migrated.npcs[0].player_description == "A host wearing a grey coat."


@pytest.mark.parametrize("model", [LocationV1, NPCV1])
def test_player_description_is_optional_and_bounded(
    model: type[LocationV1] | type[NPCV1],
) -> None:
    assert model(id="entity:test", name="Test").player_description is None
    assert model(
        id="entity:test", name="Test", player_description="  \n"
    ).player_description is None
    assert model(
        id="entity:test", name="Test", player_description="x" * 20_000
    ).player_description == "x" * 20_000
    with pytest.raises(ValidationError, match="20000"):
        model(id="entity:test", name="Test", player_description="x" * 20_001)


def test_manual_corrections_replace_lists_and_revalidate() -> None:
    corrected = apply_manual_corrections(
        package(),
        {"metadata": {"title": "Edited"}, "extensions": {"org.coc-room.notes": {"x": 1}}},
    )
    assert corrected.metadata.title == "Edited"
    assert corrected.extensions["org.coc-room.notes"] == {"x": 1}


def test_extensions_require_namespace() -> None:
    with pytest.raises(ValidationError, match="namespace"):
        apply_manual_corrections(package(), {"extensions": {"bgm": {}}})


def test_codex_provider_does_not_require_an_api_key() -> None:
    config = ParseConfig(source_text="# Test", provider="codex", model="")
    assert config.provider == "codex"
    assert config.api_key is None
    assert config.codex_timeout_seconds == 900.0
    assert config.codex_heartbeat_seconds == 15.0
    assert config.codex_auto_shrink_on_timeout is True
    assert config.codex_timeout_fallback_chunk_chars == 6_000


@pytest.mark.parametrize(
    "updates",
    [
        {"codex_timeout_seconds": 29.9},
        {"codex_timeout_seconds": 1_800.1},
        {"codex_heartbeat_seconds": 4.9},
        {"codex_heartbeat_seconds": 60.1},
        {
            "codex_timeout_fallback_chunk_chars": 2_000,
            "codex_timeout_fallback_overlap_chars": 2_000,
        },
    ],
)
def test_codex_recovery_settings_have_hard_bounds(updates: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        ParseConfig(
            source_text="# Test",
            provider="codex",
            model="",
            **updates,
        )


def test_deepseek_provider_still_requires_an_api_key() -> None:
    with pytest.raises(ValidationError, match="api_key"):
        ParseConfig(source_text="# Test", provider="deepseek")
