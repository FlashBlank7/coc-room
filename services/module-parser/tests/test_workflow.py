from __future__ import annotations

import json
from pathlib import Path

from coc_module_parser.client import (
    EmptyResponseError,
    InvalidStructureError,
    SequenceExtractor,
)
from coc_module_parser.models import (
    FragmentMetadataV1,
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
                source_refs=[SourceRefV1(chunk_id="chunk-0001", start=0, end=2)],
            )
        ],
        npcs=[
            NPCV1(
                id="raw-npc",
                name="Raw NPC",
                source_refs=[SourceRefV1(chunk_id="chunk-0001", start=2, end=4)],
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


def test_overlapping_chunks_merge_nested_source_references() -> None:
    first = ModuleFragmentV1(
        scenes=[
            SceneV1(
                id="scene-one",
                title="Repeated",
                source_refs=[SourceRefV1(chunk_id="chunk-0001", start=0, end=4)],
            )
        ]
    )
    second = ModuleFragmentV1(
        scenes=[
            SceneV1(
                id="scene-two",
                title="Repeated",
                source_refs=[SourceRefV1(chunk_id="chunk-0002", start=100, end=104)],
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
