from __future__ import annotations

import io
import json

import pytest

from coc_module_parser import cli as cli_module
from coc_module_parser.cli import run_stream
from coc_module_parser.models import (
    LocationV1,
    ModuleMetadataV1,
    ModulePackageV1,
    NPCV1,
    ParseResultV1,
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
        "resolve_references",
        "validate",
        "summarize",
        "summarize",
    ]


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
