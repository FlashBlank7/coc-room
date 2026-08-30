from __future__ import annotations

import io
import json

import pytest

from coc_module_parser import cli as cli_module
from coc_module_parser.cli import run_stream
from coc_module_parser.models import (
    IssueSeverity,
    LocationV1,
    ModuleMetadataV1,
    ModulePackageV1,
    NPCV1,
    ParseResultV1,
    ParseIssueV1,
    ProviderUsageV1,
    SourceDocumentV1,
)


def events(stream: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stream.getvalue().splitlines()]


def test_default_mode_processes_one_line_and_exits() -> None:
    requests = (
        json.dumps({"id": "one", "source_text": "# One", "mock": True})
        + "\n"
        + json.dumps({"id": "two", "source_text": "# Two", "mock": True})
        + "\n"
    )
    output = io.StringIO()
    assert run_stream(io.StringIO(requests), output) == 0
    emitted = events(output)
    assert {event["request_id"] for event in emitted} == {"one"}
    assert emitted[-1]["type"] == "result"


def test_loop_mode_processes_multiple_tasks() -> None:
    requests = "\n".join(
        json.dumps({"id": value, "type": "ping"}) for value in ("one", "two")
    )
    output = io.StringIO()
    assert run_stream(io.StringIO(requests), output, loop=True) == 0
    assert [event["request_id"] for event in events(output)] == ["one", "two"]


def test_flat_desktop_contract_and_progress_order() -> None:
    output = io.StringIO()
    request = {
        "id": "desktop",
        "api_key": "unused-secret",
        "source_text": "# Test\n## Scene",
        "model": "ignored-in-mock",
        "mock": True,
    }
    run_stream(io.StringIO(json.dumps(request) + "\n"), output)
    emitted = events(output)
    assert emitted[-1]["type"] == "result"
    assert emitted[-1]["module"]["metadata"]["title"] == "Test"
    assert emitted[-1]["module"]["schemaVersion"] == 1
    assert emitted[-1]["module"]["revision"] == 1
    assert [event["stage"] for event in emitted if event["type"] == "progress"] == [
        "normalize",
        "segment",
        "segment",
        "extract",
        "extract",
        "extract",
        "resolve_references",
        "validate",
        "summarize",
        "summarize",
    ]


def test_parse_request_accepts_bounded_codex_recovery_settings() -> None:
    config, _loaded = cli_module._parse_config(
        {
            "source_text": "# Test",
            "provider": "codex",
            "mock": True,
            "codex_timeout_seconds": 720,
            "codex_heartbeat_seconds": 20,
            "codex_auto_shrink_on_timeout": False,
            "codex_timeout_fallback_chunk_chars": 4_000,
            "codex_timeout_fallback_overlap_chars": 200,
        }
    )

    assert config.codex_timeout_seconds == 720
    assert config.codex_heartbeat_seconds == 20
    assert config.codex_auto_shrink_on_timeout is False
    assert config.codex_timeout_fallback_chunk_chars == 4_000
    assert config.codex_timeout_fallback_overlap_chars == 200


def test_sidecar_result_preserves_observed_codex_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    package = ModulePackageV1(
        module_id="module:usage",
        metadata=ModuleMetadataV1(title="Usage"),
        source=SourceDocumentV1(name="usage.md", sha256="a" * 64, char_count=6),
    )

    class StubParser:
        def parse(self, config: object, *, reporter: object) -> ParseResultV1:
            del config, reporter
            return ParseResultV1(
                status="ready_for_review",
                module=package,
                extraction_attempts=2,
                provider_usage=ProviderUsageV1(
                    completed_turns=2,
                    input_tokens=1_200,
                    cached_input_tokens=200,
                    output_tokens=300,
                    reasoning_output_tokens=40,
                ),
            )

    monkeypatch.setattr(cli_module, "ModuleParser", StubParser)
    output = io.StringIO()
    run_stream(
        io.StringIO(
            json.dumps({"id": "usage", "source_text": "# Test", "mock": True})
            + "\n"
        ),
        output,
    )

    assert events(output)[-1]["usage"] == {
        "calls": 2,
        "completedTurns": 2,
        "inputTokens": 1_200,
        "cachedInputTokens": 200,
        "outputTokens": 300,
        "reasoningOutputTokens": 40,
    }


def test_real_parse_refuses_an_empty_draft_when_no_fragment_validated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    package = ModulePackageV1(
        module_id="module:empty-provider-result",
        metadata=ModuleMetadataV1(title="Empty provider result"),
        source=SourceDocumentV1(name="empty.md", sha256="a" * 64, char_count=6),
    )

    class StubParser:
        def parse(self, config: object, *, reporter: object) -> ParseResultV1:
            del config, reporter
            return ParseResultV1(
                status="needs_review",
                module=package,
                extraction_attempts=1,
                validated_fragment_count=0,
                issues=[
                    ParseIssueV1(
                        severity=IssueSeverity.ERROR,
                        code="CODEX_NETWORK_UNAVAILABLE",
                        stage="extract",
                        message="private provider detail",
                        retryable=False,
                    )
                ],
            )

    monkeypatch.setattr(cli_module, "ModuleParser", StubParser)
    output = io.StringIO()
    run_stream(
        io.StringIO(
            json.dumps({"id": "empty", "source_text": "# Test", "provider": "codex"})
            + "\n"
        ),
        output,
    )

    final = events(output)[-1]
    assert final["type"] == "error"
    assert final["error"]["code"] == "CODEX_NETWORK_UNAVAILABLE"
    assert "module" not in final
    assert "private provider detail" not in json.dumps(final, ensure_ascii=False)


def test_sidecar_result_emits_player_descriptions_in_canonical_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    package = ModulePackageV1(
        module_id="module:public-copy",
        metadata=ModuleMetadataV1(title="Public copy"),
        source=SourceDocumentV1(
            name="public-copy.md", sha256="a" * 64, char_count=6
        ),
        locations=[
            LocationV1(
                id="location:hall",
                name="Hall",
                description="Keeper-only trapdoor details.",
                player_description="Faded portraits line a cold stone hall.",
            )
        ],
        npcs=[
            NPCV1(
                id="npc:host",
                name="Host",
                description="Keeper-only cult allegiance.",
                player_description="A pale host waits beside the fireplace.",
            )
        ],
    )

    class StubParser:
        def parse(self, config: object, *, reporter: object) -> ParseResultV1:
            del config, reporter
            return ParseResultV1(
                status="ready_for_review",
                module=package,
                extraction_attempts=1,
            )

    monkeypatch.setattr(cli_module, "ModuleParser", StubParser)
    output = io.StringIO()
    run_stream(
        io.StringIO(
            json.dumps({"id": "public-copy", "source_text": "# Test", "mock": True})
            + "\n"
        ),
        output,
    )
    module = events(output)[-1]["module"]

    assert module["locations"][0]["description"] == "Keeper-only trapdoor details."
    assert module["locations"][0]["playerDescription"] == (
        "Faded portraits line a cold stone hall."
    )
    assert module["npcs"][0]["description"] == "Keeper-only cult allegiance."
    assert module["npcs"][0]["playerDescription"] == (
        "A pale host waits beside the fireplace."
    )


def test_errors_never_echo_api_key() -> None:
    secret = "DO-NOT-ECHO-THIS-KEY"
    output = io.StringIO()
    request = {"id": "bad", "api_key": secret, "source_text": "", "mock": False}
    run_stream(io.StringIO(json.dumps(request) + "\n"), output)
    assert secret not in output.getvalue()
    assert events(output)[-1]["type"] == "error"
