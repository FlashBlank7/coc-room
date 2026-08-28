from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from coc_module_parser.client import (
    EmptyResponseError,
    InvalidStructureError,
    ProviderResponseError,
    SequenceExtractor,
)
from coc_module_parser.cache import CACHE_VERSION, CacheIdentity
from coc_module_parser.models import (
    CharacterV1,
    ClueV1,
    FragmentMetadataV1,
    HandoutV1,
    LocationV1,
    ModuleFragmentV1,
    NPCV1,
    ParseConfig,
    SceneV1,
    SourceRefV1,
)
from coc_module_parser.workflow import ModuleParser


SOURCE = "# 雾中车站\n\n## 月台\nNPC：林先生\n线索：一张旧车票\n检定：侦查（困难）"


def test_deterministic_workflow_runs_without_network() -> None:
    result = ModuleParser().parse(ParseConfig(source_text=SOURCE, mock=True))
    assert result.status == "ready_for_review"
    assert result.module.metadata.title == "雾中车站"
    assert [npc.name for npc in result.module.npcs] == ["林先生"]
    assert result.module.scenes[0].npc_ids == [result.module.npcs[0].id]
    assert result.module.clues[0].scene_ids == [result.module.scenes[0].id]
    assert result.module.chapters == []


def test_deterministic_mock_extracts_independent_handout_without_chapters() -> None:
    source = "# Test\n\n## Arrival\nHandout: Sealed invitation"
    result = ModuleParser().parse(ParseConfig(source_text=source, mock=True))

    assert result.module.chapters == []
    assert [item.title for item in result.module.handouts] == ["Sealed invitation"]
    assert result.module.scenes[0].handout_ids == [result.module.handouts[0].id]
    assert result.module.handouts[0].scene_ids == [result.module.scenes[0].id]
    assert result.module.handouts[0].source_refs[0].excerpt == "Handout: Sealed invitation"


def test_invalid_fragment_retries_only_failed_chunk() -> None:
    extractor = SequenceExtractor(
        [InvalidStructureError("bad"), EmptyResponseError("empty"), ModuleFragmentV1()]
    )
    result = ModuleParser(extractor).parse(
        ParseConfig(source_text="# Test", mock=True, max_retries=2)
    )
    assert extractor.calls == 3
    assert result.extraction_attempts == 3
    assert any(issue.code == "EXTRACTION_RETRIED" for issue in result.issues)
    assert result.status == "ready_for_review"


def test_non_retryable_provider_error_aborts_without_an_automatic_second_call() -> None:
    extractor = SequenceExtractor(
        [ProviderResponseError("provider unavailable", retryable=False)]
    )
    parser = ModuleParser(extractor)

    with pytest.raises(ProviderResponseError):
        parser.parse(ParseConfig(source_text="# Test", mock=True, max_retries=5))

    assert extractor.calls == 1


def test_codex_chunk_limit_fails_before_any_provider_call() -> None:
    extractor = SequenceExtractor([ModuleFragmentV1()])
    source = "\n\n".join(f"## Scene {index}\n" + ("x" * 900) for index in range(4))
    parser = ModuleParser(extractor)

    with pytest.raises(ProviderResponseError) as failure:
        parser.parse(
            ParseConfig(
                source_text=source,
                provider="codex",
                model="explicit-test-model",
                max_chunk_chars=1_000,
                chunk_overlap_chars=0,
                max_codex_chunks=1,
            )
        )

    assert failure.value.code == "CODEX_INPUT_TOO_LARGE"
    assert extractor.calls == 0


def test_codex_attempt_budget_returns_a_partial_draft_without_extra_calls() -> None:
    extractor = SequenceExtractor(
        [InvalidStructureError("first attempt was invalid"), ModuleFragmentV1()]
    )
    result = ModuleParser(extractor).parse(
        ParseConfig(
            source_text="# Test",
            provider="codex",
            model="explicit-test-model",
            max_retries=5,
            max_codex_attempts=1,
        )
    )

    assert extractor.calls == 1
    assert result.extraction_attempts == 1
    assert result.status == "needs_review"
    assert any(issue.code == "CODEX_CALL_LIMIT" for issue in result.issues)


def test_codex_attempt_budget_still_loads_later_cached_chunks(tmp_path: Path) -> None:
    source = "\n\n".join(
        f"## Chunk {index}\n" + (chr(96 + index) * 900) for index in range(1, 4)
    )
    fragments = [
        ModuleFragmentV1(
            scenes=[SceneV1(id=f"scene:{index}", title=f"Chunk {index}")]
        )
        for index in range(1, 4)
    ]
    base_config = ParseConfig(
        source_text=source,
        provider="codex",
        model="explicit-test-model",
        max_chunk_chars=1_000,
        chunk_overlap_chars=0,
        max_retries=0,
        cache_dir=tmp_path,
    )
    warm_extractor = SequenceExtractor(
        [InvalidStructureError("first chunk failed"), fragments[1], fragments[2]]
    )
    ModuleParser(warm_extractor).parse(base_config)
    assert warm_extractor.calls == 3

    replay_extractor = SequenceExtractor([fragments[0]])
    result = ModuleParser(replay_extractor).parse(
        base_config.model_copy(update={"max_codex_attempts": 1})
    )

    assert replay_extractor.calls == 1
    assert result.extraction_attempts == 1
    assert {scene.title for scene in result.module.scenes} == {
        "Chunk 1",
        "Chunk 2",
        "Chunk 3",
    }
    assert not any(issue.code == "CODEX_CALL_LIMIT" for issue in result.issues)


def test_chunk_retry_preserves_lossless_entity_fields() -> None:
    source = "retry evidence"
    source_ref = SourceRefV1(
        chunk_id="chunk-0001", start=0, end=len(source), excerpt=source
    )
    fragment = ModuleFragmentV1(
        scenes=[
            SceneV1(
                id="scene:raw",
                title="Arrival",
                handout_ids=["handout:raw"],
                source_refs=[source_ref],
            )
        ],
        locations=[
            LocationV1(
                id="location:raw",
                name="Archive",
                aliases=["Old Library"],
                source_refs=[source_ref],
            )
        ],
        npcs=[
            NPCV1(
                id="npc:raw",
                name="Keeper",
                traits=["stern"],
                character=CharacterV1(
                    characteristics={"INT": 80}, skills={"Library Use": 70}
                ),
                source_refs=[source_ref],
            )
        ],
        clues=[
            ClueV1(
                id="clue:raw",
                title="Key",
                content="Essential clue",
                is_core=True,
                source_refs=[source_ref],
            )
        ],
        handouts=[
            HandoutV1(
                id="handout:raw",
                title="Letter",
                content="Player text",
                scene_ids=["scene:raw"],
                source_refs=[source_ref],
            )
        ],
    )
    extractor = SequenceExtractor([InvalidStructureError("retry me"), fragment])

    result = ModuleParser(extractor).parse(
        ParseConfig(source_text=source, mock=True, max_retries=1)
    )

    assert result.module.locations[0].aliases == ["Old Library"]
    assert result.module.npcs[0].traits == ["stern"]
    assert result.module.npcs[0].character == fragment.npcs[0].character
    assert result.module.clues[0].is_core is True
    assert result.module.handouts[0].content == "Player text"
    assert result.module.handouts[0].source_refs == [source_ref]
    assert any(issue.code == "EXTRACTION_RETRIED" for issue in result.issues)


def test_exhausted_retry_returns_valid_partial_draft() -> None:
    extractor = SequenceExtractor(
        [EmptyResponseError("empty"), EmptyResponseError("empty")]
    )
    result = ModuleParser(extractor).parse(
        ParseConfig(source_text="# Test", mock=True, max_retries=1)
    )
    assert result.status == "needs_review"
    assert result.module.metadata.title == "Test"
    assert result.module.scenes == []
    assert result.issues[-1].code == "EMPTY_RESPONSE"


def test_source_heading_wins_over_model_fragment_suffix() -> None:
    fragment = ModuleFragmentV1(
        metadata=FragmentMetadataV1(title="见世之蝶 (Fragment 1)")
    )
    result = ModuleParser(SequenceExtractor([fragment])).parse(
        ParseConfig(source_text="# 见世之蝶\n\n正文", mock=True)
    )
    assert result.module.metadata.title == "见世之蝶"


def test_reference_resolution_accepts_ids_or_visible_names() -> None:
    fragment = ModuleFragmentV1(
        metadata=FragmentMetadataV1(title="Test"),
        scenes=[
            SceneV1(
                id="raw-scene",
                title="Station",
                npc_ids=["Raw NPC", "missing"],
                source_refs=[
                    SourceRefV1(chunk_id="chunk-0001", start=0, end=2, excerpt="te")
                ],
            )
        ],
        npcs=[
            NPCV1(
                id="raw-npc",
                name="Raw NPC",
                source_refs=[
                    SourceRefV1(chunk_id="chunk-0001", start=2, end=4, excerpt="st")
                ],
            )
        ],
    )
    result = ModuleParser(SequenceExtractor([fragment])).parse(
        ParseConfig(source_text="test", mock=True)
    )
    assert result.module.scenes[0].npc_ids == [result.module.npcs[0].id]
    assert any(issue.code == "UNRESOLVED_REFERENCE" for issue in result.issues)


def test_cache_reuses_validated_fragment_and_never_contains_key(tmp_path: Path) -> None:
    secret = "SUPER-SECRET-SHOULD-NOT-BE-CACHED"
    extractor = SequenceExtractor([ModuleFragmentV1()])
    config = ParseConfig(
        source_text="# Cache",
        mock=True,
        api_key=secret,
        cache_dir=tmp_path,
    )
    parser = ModuleParser(extractor)
    parser.parse(config)
    parser.parse(config)
    assert extractor.calls == 1
    cache_text = "\n".join(path.read_text("utf-8") for path in tmp_path.rglob("*.json"))
    assert secret not in cache_text


def test_non_cacheable_extractor_never_reuses_an_implicit_provider_default(
    tmp_path: Path,
) -> None:
    extractor = SequenceExtractor([ModuleFragmentV1(), ModuleFragmentV1()])
    extractor.cacheable = False
    config = ParseConfig(source_text="# Cache", mock=True, cache_dir=tmp_path)
    parser = ModuleParser(extractor)

    parser.parse(config)
    parser.parse(config)

    assert extractor.calls == 2
    assert list(tmp_path.rglob("*.json")) == []


def test_cache_identity_includes_provider_and_generation_settings(tmp_path: Path) -> None:
    source = "# Cache identity"
    first = SequenceExtractor([ModuleFragmentV1()])
    ModuleParser(first).parse(
        ParseConfig(
            source_text=source,
            mock=True,
            base_url="https://provider-one.example/v1/",
            max_output_tokens=4_000,
            cache_dir=tmp_path,
        )
    )

    changed_url = SequenceExtractor([ModuleFragmentV1()])
    ModuleParser(changed_url).parse(
        ParseConfig(
            source_text=source,
            mock=True,
            base_url="https://provider-two.example/v1",
            max_output_tokens=4_000,
            cache_dir=tmp_path,
        )
    )
    changed_tokens = SequenceExtractor([ModuleFragmentV1()])
    ModuleParser(changed_tokens).parse(
        ParseConfig(
            source_text=source,
            mock=True,
            base_url="https://provider-one.example/v1",
            max_output_tokens=8_000,
            cache_dir=tmp_path,
        )
    )

    assert first.calls == 1
    assert changed_url.calls == 1
    assert changed_tokens.calls == 1
    identities = [
        json.loads(path.read_text("utf-8"))["identity"]
        for path in tmp_path.rglob("*.json")
    ]
    assert {identity["base_url"] for identity in identities} == {
        "https://provider-one.example/v1",
        "https://provider-two.example/v1",
    }
    assert {identity["max_output_tokens"] for identity in identities} == {4_000, 8_000}


def test_cache_identity_includes_extraction_prompt_version(tmp_path: Path) -> None:
    config = ParseConfig(source_text="# Prompt version", mock=True, cache_dir=tmp_path)
    first = SequenceExtractor([ModuleFragmentV1()])
    first.extraction_prompt_version = "privacy-prompt-v1"
    ModuleParser(first).parse(config)

    changed_prompt = SequenceExtractor([ModuleFragmentV1()])
    changed_prompt.extraction_prompt_version = "privacy-prompt-v2"
    ModuleParser(changed_prompt).parse(config)

    assert first.calls == 1
    assert changed_prompt.calls == 1
    identities = [
        json.loads(path.read_text("utf-8"))["identity"]
        for path in tmp_path.rglob("*.json")
    ]
    assert {identity["extraction_prompt_version"] for identity in identities} == {
        "privacy-prompt-v1",
        "privacy-prompt-v2",
    }
    assert CACHE_VERSION == "module-fragment-cache-v4-player-visible-descriptions"


def test_player_description_schema_cache_version_cannot_reuse_v3_entries() -> None:
    current = CacheIdentity(
        source_sha256="a" * 64,
        chunk_id="chunk-0001",
        chunk_sha256="b" * 64,
        chunk_start=0,
        chunk_end=10,
        max_chunk_chars=1_000,
        overlap_chars=0,
        extractor="deepseek-responses",
        model="test-model",
        base_url="https://example.invalid",
        max_output_tokens=1_000,
        extraction_prompt_version="v4",
        schema_sha256="c" * 64,
    )
    old = replace(current, cache_version="module-fragment-cache-v3-lossless-entities")

    assert current.cache_version == CACHE_VERSION
    assert current.key() != old.key()


def test_cross_chunk_merge_preserves_structured_fields_and_validated_refs() -> None:
    first_evidence = "alpha evidence"
    second_evidence = "beta evidence"
    source = first_evidence + ("x" * (1_000 - len(first_evidence))) + second_evidence
    first_ref = SourceRefV1(
        chunk_id="chunk-0001",
        start=0,
        end=len(first_evidence),
        excerpt=first_evidence,
    )
    # A real model sometimes returns chunk-local offsets despite the prompt.
    second_ref = SourceRefV1(
        chunk_id="chunk-0002",
        start=0,
        end=len(second_evidence),
        excerpt=second_evidence,
    )
    first = ModuleFragmentV1(
        scenes=[
            SceneV1(
                id="scene:first",
                title="Arrival",
                location_ids=["Old Library"],
                handout_ids=["handout:first"],
                source_refs=[first_ref],
            )
        ],
        locations=[
            LocationV1(
                id="location:first",
                name="Archive",
                aliases=["Old Library"],
                source_refs=[first_ref],
            )
        ],
        npcs=[
            NPCV1(
                id="npc:first",
                name="Keeper",
                traits=["stern"],
                character=CharacterV1(characteristics={"STR": 60}),
                source_refs=[first_ref],
            )
        ],
        clues=[
            ClueV1(
                id="clue:first",
                title="Key",
                content="Essential clue",
                is_core=False,
                source_refs=[first_ref],
            )
        ],
        handouts=[
            HandoutV1(
                id="handout:first",
                title="Letter",
                content="Player text",
                scene_ids=["scene:first"],
                source_refs=[first_ref],
            )
        ],
    )
    second = ModuleFragmentV1(
        scenes=[
            SceneV1(
                id="scene:second",
                title="Arrival",
                location_ids=["West Annex"],
                handout_ids=["Letter"],
                source_refs=[second_ref],
            )
        ],
        locations=[
            LocationV1(
                id="location:second",
                name="Archive",
                player_description="Rows of dusty books surround a west-facing window.",
                aliases=["West Annex"],
                source_refs=[second_ref],
            )
        ],
        npcs=[
            NPCV1(
                id="npc:second",
                name="Keeper",
                player_description="A quiet keeper with ink-stained cuffs.",
                traits=["quiet"],
                character=CharacterV1(
                    skills={"Spot Hidden": 55}, hit_points=12, sanity=70
                ),
                source_refs=[second_ref],
            )
        ],
        clues=[
            ClueV1(
                id="clue:second",
                title="Key",
                content="Essential clue",
                is_core=True,
                source_refs=[second_ref],
            )
        ],
        handouts=[
            HandoutV1(
                id="handout:second",
                title="Letter",
                description="A complete player-facing letter",
                content="Player text",
                source_refs=[second_ref],
            )
        ],
    )

    result = ModuleParser(SequenceExtractor([first, second])).parse(
        ParseConfig(
            source_text=source,
            mock=True,
            max_chunk_chars=1_000,
            chunk_overlap_chars=0,
        )
    )

    assert result.module.chapters == []
    assert result.module.locations[0].aliases == ["Old Library", "West Annex"]
    assert result.module.locations[0].player_description == (
        "Rows of dusty books surround a west-facing window."
    )
    assert result.module.scenes[0].location_ids == [result.module.locations[0].id]
    assert result.module.npcs[0].traits == ["stern", "quiet"]
    assert result.module.npcs[0].player_description == (
        "A quiet keeper with ink-stained cuffs."
    )
    assert result.module.npcs[0].character == CharacterV1(
        characteristics={"STR": 60},
        skills={"Spot Hidden": 55},
        hit_points=12,
        sanity=70,
    )
    assert result.module.clues[0].is_core is True
    assert result.module.handouts[0].description == "A complete player-facing letter"
    assert result.module.scenes[0].handout_ids == [result.module.handouts[0].id]
    assert result.module.handouts[0].scene_ids == [result.module.scenes[0].id]
    for entity in (
        result.module.scenes
        + result.module.locations
        + result.module.npcs
        + result.module.clues
        + result.module.handouts
    ):
        assert [(ref.start, ref.end) for ref in entity.source_refs] == [
            (0, len(first_evidence)),
            (1_000, 1_000 + len(second_evidence)),
        ]


def test_overlapping_chunks_merge_nested_source_references() -> None:
    first = ModuleFragmentV1(
        scenes=[
            SceneV1(
                id="scene-one",
                title="Repeated",
                source_refs=[
                    SourceRefV1(chunk_id="chunk-0001", start=0, end=4, excerpt="xxxx")
                ],
            )
        ]
    )
    second = ModuleFragmentV1(
        scenes=[
            SceneV1(
                id="scene-two",
                title="Repeated",
                source_refs=[
                    SourceRefV1(chunk_id="chunk-0002", start=100, end=104, excerpt="xxxx")
                ],
            )
        ]
    )
    result = ModuleParser(SequenceExtractor([first, second])).parse(
        ParseConfig(
            source_text="x" * 1_500,
            mock=True,
            max_chunk_chars=1_000,
            chunk_overlap_chars=100,
        )
    )
    assert len(result.module.scenes) == 1
    assert len(result.module.scenes[0].source_refs) == 2
    assert any(issue.code == "DUPLICATE_ENTITY_MERGED" for issue in result.issues)
