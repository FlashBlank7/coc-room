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
    IssueSeverity,
    LocationV1,
    ModuleFragmentV1,
    NPCV1,
    ParseConfig,
    SceneV1,
    SourceRefV1,
)
from coc_module_parser.workflow import ModuleParser


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


def test_segment_uses_the_configured_chunk_size_for_all_providers() -> None:
    dense_source = "月" * 80_000
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

    assert state["chunk_max_chars"] == 30_000
    assert state["chunk_overlap_chars"] == 500
    assert max(len(chunk.text) for chunk in state["chunks"]) <= 30_000
    assert progress[-1] == {
        "chunk_count": len(state["chunks"]),
        "max_chunk_chars": 30_000,
        "overlap_chars": 500,
    }


def test_segment_honors_a_large_explicit_chunk_size_without_utf8_shrinking() -> None:
    dense_source = "月" * 50_000
    state = ModuleParser._segment(
        {
            "config": ParseConfig(
                source_text=dense_source,
                provider="codex",
                model="gpt-test",
                max_chunk_chars=100_000,
                chunk_overlap_chars=0,
            ),
            "normalized_text": dense_source,
            "reporter": lambda *_args: None,
        }
    )

    assert state["chunk_max_chars"] == 100_000
    assert len(state["chunks"]) == 1


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
        "slow evidence stage", retryable=True, code="CODEX_TIMEOUT"
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
    assert any(
        issue.code == "CODEX_TIMEOUT" and issue.retryable for issue in partial.issues
    )
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
        retryable=True,
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


def test_codex_timeout_exhausts_retries_records_error_and_later_chunks_continue() -> None:
    timeout = lambda: ProviderResponseError(
        "slow structured output",
        retryable=True,
        code="CODEX_TIMEOUT",
    )
    source = "\n\n".join(
        f"## Chunk {index}\n" + (chr(96 + index) * 900) for index in range(1, 4)
    )
    fragments = [
        ModuleFragmentV1(
            scenes=[SceneV1(id=f"scene:{index}", title=f"Chunk {index}")]
        )
        for index in range(2, 4)
    ]
    extractor = SequenceExtractor([timeout(), timeout(), *fragments])

    result = ModuleParser(extractor).parse(
        ParseConfig(
            source_text=source,
            provider="codex",
            model="explicit-test-model",
            max_chunk_chars=1_000,
            chunk_overlap_chars=0,
            max_retries=1,
        )
    )

    assert extractor.calls == 4
    assert result.extraction_attempts == 4
    assert result.status == "needs_review"
    assert {scene.title for scene in result.module.scenes} == {"Chunk 2", "Chunk 3"}
    issue = next(issue for issue in result.issues if issue.code == "CODEX_TIMEOUT")
    assert issue.severity == IssueSeverity.ERROR
    assert issue.chunk_id == "chunk-0001"
    assert issue.retryable is True


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


def test_failed_chunk_rerun_reuses_cached_validated_chunks(tmp_path: Path) -> None:
    source = "\n\n".join(
        f"## Chunk {index}\n" + (chr(96 + index) * 900) for index in range(1, 4)
    )
    fragments = [
        ModuleFragmentV1(
            scenes=[SceneV1(id=f"scene:{index}", title=f"Chunk {index}")]
        )
        for index in range(1, 4)
    ]
    config = ParseConfig(
        source_text=source,
        provider="codex",
        model="explicit-test-model",
        max_chunk_chars=1_000,
        chunk_overlap_chars=0,
        max_retries=0,
        cache_dir=tmp_path,
    )
    first = SequenceExtractor(
        [
            ProviderResponseError(
                "slow structured output", retryable=True, code="CODEX_TIMEOUT"
            ),
            fragments[1],
            fragments[2],
        ]
    )

    partial = ModuleParser(first).parse(config)

    assert first.calls == 3
    assert partial.status == "needs_review"
    assert any(issue.code == "CODEX_TIMEOUT" for issue in partial.issues)
    assert {scene.title for scene in partial.module.scenes} == {"Chunk 2", "Chunk 3"}

    resumed = SequenceExtractor([fragments[0]])
    result = ModuleParser(resumed).parse(config)

    assert resumed.calls == 1
    assert result.extraction_attempts == 1
    assert result.status == "ready_for_review"
    assert {scene.title for scene in result.module.scenes} == {
        "Chunk 1",
        "Chunk 2",
        "Chunk 3",
    }


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


def test_scene_check_references_relink_by_difficulty_or_materialize() -> None:
    from coc_module_parser.models import CheckDifficulty, SuggestedCheckV1

    fragment = ModuleFragmentV1(
        metadata=FragmentMetadataV1(title="Test"),
        scenes=[
            SceneV1(
                id="raw-scene",
                title="Station",
                suggested_check_ids=["聆听困难", "神秘学", "侦察极难"],
                source_refs=[
                    SourceRefV1(chunk_id="chunk-0001", start=0, end=2, excerpt="te")
                ],
            )
        ],
        suggested_checks=[
            SuggestedCheckV1(
                id="raw-check",
                skill="聆听",
                source_refs=[
                    SourceRefV1(chunk_id="chunk-0001", start=2, end=4, excerpt="st")
                ],
            )
        ],
    )
    result = ModuleParser(SequenceExtractor([fragment])).parse(
        ParseConfig(source_text="test", mock=True)
    )
    scene = result.module.scenes[0]
    checks = {check.id: check for check in result.module.suggested_checks}
    assert len(scene.suggested_check_ids) == 3
    linked = [checks[check_id] for check_id in scene.suggested_check_ids]
    listen = next(check for check in linked if check.skill == "聆听")
    occult = next(check for check in linked if check.skill == "神秘学")
    spot = next(check for check in linked if check.skill == "侦察")
    assert listen.id == next(
        check.id for check in result.module.suggested_checks if check.skill == "聆听"
    )
    assert occult.difficulty == CheckDifficulty.REGULAR
    assert spot.difficulty == CheckDifficulty.EXTREME
    assert any(issue.code == "CHECK_REFERENCE_RELINKED" for issue in result.issues)
    assert any(issue.code == "CHECK_REFERENCE_MATERIALIZED" for issue in result.issues)
    assert not any(
        issue.code == "UNRESOLVED_REFERENCE" and "checks" in issue.message
        for issue in result.issues
    )


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


def test_evidence_scene_links_survive_different_world_stage_labels() -> None:
    from coc_module_parser.models import ClueV1, SuggestedCheckV1, CheckDifficulty
    fragment = ModuleFragmentV1(
        scenes=[SceneV1(id="office", title="Office", clue_ids=["Old newspaper"], suggested_check_ids=["心理学普通成功"]),
                SceneV1(id="warehouse", title="Warehouse", suggested_check_ids=["普通心理学成功"])],
        clues=[ClueV1(id="report", title="Accident report", content="Read without a roll", scene_ids=["office"])],
        suggested_checks=[SuggestedCheckV1(id="office-psych", skill="心理学", scene_id="office", success="Only knows he is hiding something"),
                          SuggestedCheckV1(id="warehouse-psych", skill="心理学", scene_id="warehouse", difficulty=CheckDifficulty.HARD, success="Different person's reaction")],
    )
    result = ModuleParser(SequenceExtractor([fragment])).parse(ParseConfig(source_text="test", mock=True))
    office, warehouse = result.module.scenes
    assert office.clue_ids == [result.module.clues[0].id]
    checks = {check.id: check for check in result.module.suggested_checks}
    assert len(checks) == 2
    assert [checks[id].success for id in office.suggested_check_ids] == ["Only knows he is hiding something"]
    assert [checks[id].success for id in warehouse.suggested_check_ids] == ["Different person's reaction"]
    assert checks[warehouse.suggested_check_ids[0]].difficulty == CheckDifficulty.HARD


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
