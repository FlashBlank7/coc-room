from __future__ import annotations

import io
import json

from coc_module_parser.cli import run_stream


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


def test_errors_never_echo_api_key() -> None:
    secret = "DO-NOT-ECHO-THIS-KEY"
    output = io.StringIO()
    request = {"id": "bad", "api_key": secret, "source_text": "", "mock": False}
    run_stream(io.StringIO(json.dumps(request) + "\n"), output)
    assert secret not in output.getvalue()
    assert events(output)[-1]["type"] == "error"
