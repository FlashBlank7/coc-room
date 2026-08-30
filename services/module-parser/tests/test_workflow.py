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
    codex_evidence_output_schema,
    codex_world_output_schema,
)
from coc_module_parser.cache import CACHE_VERSION, CacheIdentity
from coc_module_parser.models import (
    CharacterV1,
    ClueV1,
    CodexEvidenceFragmentV1,
    CodexWorldFragmentV1,
    FragmentMetadataV1,
    HandoutV1,
    LocationV1,
    ModuleFragmentV1,
    NPCV1,
    ParseConfig,
    SceneV1,
    SourceRefV1,
)
from coc_module_parser.workflow import (
    CODEX_SOURCE_CHUNK_UTF8_SOFT_LIMIT,
    ModuleParser,
)


SOURCE = "# 雾中车站\n\n## 月台\nNPC：林先生\n线索：一张旧车票\n检定：侦查（困难）"


class StagedSequenceExtractor:
    name = "codex-staged-test"
    model = "gpt-test"
    base_url = "local://codex-test"
    extraction_prompt_version = "staged-test-v1"
    cacheable = True
    cache_max_output_tokens = 0
    max_output_tokens = 16_000
    supports_staged_codex = True

    def __init__(self, outcomes: list[tuple[str, object]]) -> None:
        self.outcomes = list(outcomes)
        self.calls: list[str] = []
        self.usage: dict[str, int] = {}

    @staticmethod
    def output_schema() -> dict[str, object]:
        return ModuleFragmentV1.model_json_schema(mode="validation")

    @staticmethod
    def stage_output_schema(stage: str) -> dict[str, object]:
        return (
            codex_world_output_schema()
            if stage == "world"
            else codex_evidence_output_schema()
        )

    def extract_stage(self, _chunk: object, *, stage: str, **kwargs: object) -> object:
        progress = kwargs.get("progress")
        expected_stage, outcome = self.outcomes.pop(0)
        assert stage == expected_stage
        self.calls.append(stage)
        if callable(progress):
            progress("started", {"elapsed_seconds": 0.0})
        if isinstance(outcome, Exception):
            raise outcome
        self.usage = {
            "completed_turns": 1,
            "input_tokens": 100 if stage == "world" else 80,
            "output_tokens": 20 if stage == "world" else 15,
        }
        if callable(progress):
            progress("completed", {"elapsed_seconds": 1.0, "usage": self.usage})
        return outcome

    def take_last_usage(self) -> dict[str, int]:
        usage = self.usage
        self.usage = {}
        return usage


def test_deterministic_workflow_runs_without_network() -> None:
    result = ModuleParser().parse(ParseConfig(source_text=SOURCE, mock=True))
    assert result.status == "ready_for_review"
    assert result.module.metadata.title == "雾中车站"
    assert [npc.name for npc in result.module.npcs] == ["林先生"]
    assert result.module.scenes[0].npc_ids == [result.module.npcs[0].id]
    assert result.module.clues[0].scene_ids == [result.module.scenes[0].id]
    assert result.module.chapters == []


def test_live_codex_segments_dense_multilingual_text_by_utf8_load() -> None:
    dense_source = "月" * 8_000
    progress: list[dict[str, object]] = []
    state = ModuleParser._segment(
        {
            "config": ParseConfig(
                source_text=dense_source,
                provider="codex",
                model="gpt-test",
            ),
            "normalized_text": dense_source,
            "reporter": lambda _stage, _fraction, _message, details: (
                progress.append(details) if details else None
            ),
        }
    )

    assert state["chunk_max_chars"] == 3_000
    assert max(len(chunk.text.encode("utf-8")) for chunk in state["chunks"]) <= (
        CODEX_SOURCE_CHUNK_UTF8_SOFT_LIMIT
    )
    assert progress[-1]["codex_utf8_soft_limit_applied"] is True
    assert progress[-1]["codex_source_chunk_utf8_soft_limit"] == (
        CODEX_SOURCE_CHUNK_UTF8_SOFT_LIMIT
    )


def test_live_codex_keeps_configured_cap_for_latin_text_within_byte_budget() -> None:
    latin_source = "a" * 8_000
    state = ModuleParser._segment(
        {
            "config": ParseConfig(
                source_text=latin_source,
                provider="codex",
                model="gpt-test",
            ),
            "normalized_text": latin_source,
            "reporter": lambda *_args: None,
        }
    )

    assert state["chunk_max_chars"] == 6_000


def test_live_codex_combines_two_validated_stages_and_reuses_stage_cache(
    tmp_path: Path,
) -> None:
    source = "test"
    source_ref = SourceRefV1(
        chunk_id="chunk-0001", start=0, end=4, excerpt=source
    )
    world = CodexWorldFragmentV1(
        scenes=[
            SceneV1(
                id="scene:raw",
                title="Archive visit",
                location_ids=["Archive"],
                handout_ids=["Letter"],
                source_refs=[source_ref],
            )
        ],
        locations=[
            LocationV1(
                id="location:raw",
                name="Archive",
                description="A concealed mechanism is behind the shelves.",
                player_description="Dusty shelves rise beneath a cracked skylight.",
                source_refs=[source_ref],
            )
        ],
        npcs=[
            NPCV1(
                id="npc:raw",
                name="Keeper",
                player_description="An ink-stained keeper waits at the desk.",
                character=CharacterV1(characteristics={"INT": 80}),
                source_refs=[source_ref],
            )
        ],
    )
    evidence = CodexEvidenceFragmentV1(
        clues=[
            ClueV1(
                id="clue:raw",
                title="Ledger",
                content="The ledger identifies the cult.",
                handout_text="A list of unfamiliar names.",
                scene_ids=["Archive visit"],
                source_refs=[source_ref],
            )
        ],
        handouts=[
            HandoutV1(
                id="handout:raw",
                title="Letter",
                content="Complete player-facing letter.",
                scene_ids=["Archive visit"],
                source_refs=[source_ref],
            )
        ],
    )
    config = ParseConfig(
        source_text=source,
        provider="codex",
        model="gpt-test",
        max_retries=0,
        cache_dir=tmp_path,
    )
    progress: list[dict[str, object]] = []
    first = StagedSequenceExtractor([("world", world), ("evidence", evidence)])

    result = ModuleParser(first).parse(
        config,
        reporter=lambda _stage, _fraction, _message, details: (
            progress.append(details) if details else None
        ),
    )

    assert first.calls == ["world", "evidence"]
    assert result.extraction_attempts == 2
    assert result.validated_fragment_count == 1
    assert result.provider_usage.completed_turns == 2
    assert result.provider_usage.input_tokens == 180
    assert result.provider_usage.output_tokens == 35
    assert result.module.locations[0].player_description == (
        "Dusty shelves rise beneath a cracked skylight."
    )
    assert result.module.npcs[0].player_description == (
        "An ink-stained keeper waits at the desk."
    )
    assert result.module.clues[0].handout_text == "A list of unfamiliar names."
    assert result.module.handouts[0].content == "Complete player-facing letter."
    assert result.module.scenes[0].handout_ids == [result.module.handouts[0].id]
    assert all(
        item.source_refs == [source_ref]
        for item in (
            result.module.scenes
            + result.module.locations
            + result.module.npcs
            + result.module.clues
            + result.module.handouts
        )
    )
    assert {
        details["codex_stage"]
        for details in progress
        if details.get("event") == "codex_started"
    } == {"world", "evidence"}

    cache_payloads = [
        json.loads(path.read_text("utf-8")) for path in tmp_path.rglob("*.json")
    ]
    assert {payload["stage"] for payload in cache_payloads} == {"world", "evidence"}
    assert {
        payload["identity"]["extraction_stage"] for payload in cache_payloads
    } == {"world", "evidence"}
    assert len({payload["identity"]["schema_sha256"] for payload in cache_payloads}) == 2

    replay = StagedSequenceExtractor([])
    replayed = ModuleParser(replay).parse(config)
    assert replay.calls == []
    assert replayed.extraction_attempts == 0
    assert replayed.validated_fragment_count == 1
    assert replayed.module.model_dump(mode="json") == result.module.model_dump(mode="json")


def test_live_codex_evidence_timeout_never_merges_cached_world_stage(
    tmp_path: Path,
) -> None:
    world = CodexWorldFragmentV1(
        locations=[LocationV1(id="location:raw", name="Never partially merged")]
    )
    timeout = ProviderResponseError(
        "slow evidence stage", retryable=False, code="CODEX_TIMEOUT"
    )
    config = ParseConfig(
        source_text="test",
        provider="codex",
        model="gpt-test",
        max_retries=0,
        cache_dir=tmp_path,
    )
    first = StagedSequenceExtractor([("world", world), ("evidence", timeout)])

    partial = ModuleParser(first).parse(config)

    assert first.calls == ["world", "evidence"]
    assert partial.extraction_attempts == 2
    assert partial.validated_fragment_count == 0
    assert partial.module.locations == []
    assert partial.status == "needs_review"
    assert any(issue.code == "CODEX_TIMEOUT" for issue in partial.issues)
    cache_payloads = [
        json.loads(path.read_text("utf-8")) for path in tmp_path.rglob("*.json")
    ]
    assert [payload["stage"] for payload in cache_payloads] == ["world"]

    evidence = CodexEvidenceFragmentV1(
        clues=[ClueV1(id="clue:raw", title="Recovered", content="Recovered")]
    )
    resumed = StagedSequenceExtractor([("evidence", evidence)])
    complete = ModuleParser(resumed).parse(config)

    assert resumed.calls == ["evidence"]
    assert complete.extraction_attempts == 1
    assert complete.validated_fragment_count == 1
    assert [item.name for item in complete.module.locations] == ["Never partially merged"]
    assert [item.title for item in complete.module.clues] == ["Recovered"]


def test_live_codex_stall_returns_repairable_partial_without_more_calls(
    tmp_path: Path,
) -> None:
    world = CodexWorldFragmentV1(
        locations=[LocationV1(id="location:raw", name="Cached world stage")]
    )
    stalled = ProviderResponseError(
        "sanitized repeated error event",
        retryable=False,
        code="CODEX_CLI_STALLED",
    )
    extractor = StagedSequenceExtractor(
        [("world", world), ("evidence", stalled)]
    )

    result = ModuleParser(extractor).parse(
        ParseConfig(
            source_text="x" * 8_000,
            provider="codex",
            model="gpt-test",
            max_retries=0,
            cache_dir=tmp_path,
        )
    )

    assert extractor.calls == ["world", "evidence"]
    assert result.status == "needs_review"
    assert result.validated_fragment_count == 0
    assert result.module.locations == []
    assert any(issue.code == "CODEX_CLI_STALLED" for issue in result.issues)
    cached = [json.loads(path.read_text("utf-8")) for path in tmp_path.rglob("*.json")]
    assert [payload["stage"] for payload in cached] == ["world"]


def test_live_codex_budget_does_not_start_an_unfinishable_two_stage_chunk() -> None:
    extractor = StagedSequenceExtractor([])
    result = ModuleParser(extractor).parse(
        ParseConfig(
            source_text="test",
            provider="codex",
            model="gpt-test",
            max_codex_attempts=1,
        )
    )

    assert extractor.calls == []
    assert result.extraction_attempts == 0
    assert result.validated_fragment_count == 0
    assert any(issue.code == "CODEX_CALL_LIMIT" for issue in result.issues)


def test_first_chunk_probe_populates_the_same_stage_cache_used_by_full_parse(
    tmp_path: Path,
) -> None:
    source = "x" * 8_000
    base = ParseConfig(
        source_text=source,
        provider="codex",
        model="gpt-test",
        max_retries=0,
        max_chunk_chars=6_000,
        chunk_overlap_chars=250,
        codex_timeout_fallback_chunk_chars=6_000,
        codex_timeout_fallback_overlap_chars=250,
        cache_dir=tmp_path,
    )
    probe_extractor = StagedSequenceExtractor(
        [
            (
                "world",
                CodexWorldFragmentV1(
                    scenes=[SceneV1(id="scene:first", title="First chunk")]
                ),
            ),
            ("evidence", CodexEvidenceFragmentV1()),
        ]
    )
    probe = ModuleParser(probe_extractor).parse(
        base.model_copy(update={"codex_probe_first_chunk": True})
    )

    assert probe_extractor.calls == ["world", "evidence"]
    assert probe.validated_fragment_count == 1

    full_extractor = StagedSequenceExtractor(
        [
            (
                "world",
                CodexWorldFragmentV1(
                    scenes=[SceneV1(id="scene:second", title="Second chunk")]
                ),
            ),
            ("evidence", CodexEvidenceFragmentV1()),
        ]
    )
    full = ModuleParser(full_extractor).parse(base)

    assert full_extractor.calls == ["world", "evidence"]
    assert full.extraction_attempts == 2
    assert full.validated_fragment_count == 2
    assert {scene.title for scene in full.module.scenes} == {
        "First chunk",
        "Second chunk",
    }


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


def test_first_codex_timeout_resegments_once_without_duplicate_fragments() -> None:
    timeout = ProviderResponseError(
        "slow structured output",
        retryable=False,
        code="CODEX_TIMEOUT",
    )
    fragments = [
        ModuleFragmentV1(
            scenes=[SceneV1(id=f"scene:{index}", title=f"Part {index}")]
        )
        for index in range(1, 4)
    ]
    extractor = SequenceExtractor([timeout, *fragments])
    progress: list[tuple[str, dict[str, object] | None]] = []

    result = ModuleParser(extractor).parse(
        ParseConfig(
            source_text="x" * 8_000,
            provider="codex",
            model="explicit-test-model",
            max_chunk_chars=12_000,
            chunk_overlap_chars=0,
            codex_timeout_fallback_chunk_chars=6_000,
            codex_timeout_fallback_overlap_chars=0,
            max_retries=0,
        ),
        reporter=lambda stage, _fraction, _message, details: progress.append(
            (stage, details)
        ),
    )

    assert extractor.calls == 4
    assert result.extraction_attempts == 4
    assert result.status == "ready_for_review"
    assert {scene.title for scene in result.module.scenes} == {
        "Part 1",
        "Part 2",
        "Part 3",
    }
    assert any(issue.code == "CODEX_TIMEOUT_RESEGMENTED" for issue in result.issues)
    assert any(
        details and details.get("event") == "codex_timeout_resegmented"
        for stage, details in progress
        if stage == "extract"
    )


def test_workflow_forwards_codex_lifecycle_heartbeats_and_aggregates_usage() -> None:
    class ObservableExtractor:
        name = "observable-codex"
        model = "gpt-test"
        extraction_prompt_version = "observable-v1"
        cacheable = False
        max_output_tokens = 16_000

        def __init__(self) -> None:
            self.usage: dict[str, int] = {}

        @staticmethod
        def output_schema() -> dict[str, object]:
            return ModuleFragmentV1.model_json_schema(mode="validation")

        def extract(self, _chunk: object, **kwargs: object) -> ModuleFragmentV1:
            progress = kwargs["progress"]
            assert callable(progress)
            progress("started", {"elapsed_seconds": 0.0})
            progress("waiting", {"elapsed_seconds": 15.0})
            self.usage = {
                "completed_turns": 1,
                "input_tokens": 100,
                "output_tokens": 25,
            }
            progress("completed", {"elapsed_seconds": 16.0, "usage": self.usage})
            return ModuleFragmentV1()

        def take_last_usage(self) -> dict[str, int]:
            usage = self.usage
            self.usage = {}
            return usage

    reported: list[dict[str, object]] = []
    result = ModuleParser(ObservableExtractor()).parse(
        ParseConfig(source_text="# Test", provider="codex", model="gpt-test", mock=True),
        reporter=lambda _stage, _fraction, _message, details: (
            reported.append(details) if details else None
        ),
    )

    assert [
        details["event"]
        for details in reported
        if isinstance(details.get("event"), str)
        and str(details["event"]).startswith("codex_")
    ] == ["codex_started", "codex_waiting", "codex_completed"]
    assert result.provider_usage.completed_turns == 1
    assert result.provider_usage.input_tokens == 100
    assert result.provider_usage.output_tokens == 25


def test_codex_timeout_resume_reuses_split_plan_and_validated_child_cache(
    tmp_path: Path,
) -> None:
    timeout = lambda: ProviderResponseError(
        "slow structured output",
        retryable=False,
        code="CODEX_TIMEOUT",
    )
    config = ParseConfig(
        source_text="x" * 8_000,
        provider="codex",
        model="explicit-test-model",
        max_chunk_chars=12_000,
        chunk_overlap_chars=0,
        codex_timeout_fallback_chunk_chars=6_000,
        codex_timeout_fallback_overlap_chars=0,
        max_retries=0,
        cache_dir=tmp_path,
    )
    first = SequenceExtractor(
        [
            timeout(),
            ModuleFragmentV1(
                scenes=[SceneV1(id="scene:one", title="Cached child")]
            ),
            timeout(),
        ]
    )

    partial = ModuleParser(first).parse(config)

    assert first.calls == 3
    assert partial.status == "needs_review"
    assert any(issue.code == "CODEX_TIMEOUT" for issue in partial.issues)
    assert len(list((tmp_path / "plans").rglob("*.json"))) == 1

    resumed = SequenceExtractor(
        [
            ModuleFragmentV1(
                scenes=[SceneV1(id="scene:two", title="Resumed child 2")]
            ),
            ModuleFragmentV1(
                scenes=[SceneV1(id="scene:three", title="Resumed child 3")]
            ),
        ]
    )
    result = ModuleParser(resumed).parse(config)

    assert resumed.calls == 2
    assert result.extraction_attempts == 2
    assert result.status == "ready_for_review"
    assert {scene.title for scene in result.module.scenes} == {
        "Cached child",
        "Resumed child 2",
        "Resumed child 3",
    }
    assert any(issue.code == "CODEX_SPLIT_PLAN_RESTORED" for issue in result.issues)


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
    assert CACHE_VERSION == "module-fragment-cache-v5-codex-staged"


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
