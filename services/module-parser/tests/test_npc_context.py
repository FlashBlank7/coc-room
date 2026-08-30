from __future__ import annotations

import io
import json

import pytest
from pydantic import ValidationError

from coc_module_parser.cli import run_stream
from coc_module_parser.npc_context import (
    MAX_NPC_CONTEXT_MESSAGE_CHARS,
    NpcReplyOutputV1,
    PrepareNpcReplyTaskV1,
    build_npc_context,
    npc_reply_output_schema,
)


def _task(**updates: object) -> PrepareNpcReplyTaskV1:
    payload: dict[str, object] = {
        "provider": "codex",
        "model": "",
        "npcCard": {"id": "npc:host", "name": "The Host"},
        "pins": [],
        "messages": [],
    }
    payload.update(updates)
    return PrepareNpcReplyTaskV1.model_validate(payload)


def _events(output: io.StringIO) -> list[dict[str, object]]:
    return [json.loads(line) for line in output.getvalue().splitlines()]


def test_context_keeps_only_the_latest_40_messages_in_chronological_order() -> None:
    messages = [
        {"id": f"m-{index}", "role": "human", "content": str(index)}
        for index in range(45)
    ]
    context = build_npc_context(_task(messages=messages))

    assert len(context.messages) == 40
    assert [message.id for message in context.messages] == [
        f"m-{index}" for index in range(5, 45)
    ]
    assert context.selection.available_message_count == 45
    assert context.selection.omitted_message_count == 5


def test_context_keeps_complete_messages_and_does_not_backfill_across_a_gap() -> None:
    messages = [
        {"id": "old-small", "role": "human", "content": "a" * 10},
        {"id": "does-not-fit", "role": "npc", "content": "b" * 10_000},
        {"id": "newest", "role": "human", "content": "c" * 15_000},
    ]
    context = build_npc_context(_task(messages=messages))

    assert [message.id for message in context.messages] == ["newest"]
    assert context.messages[0].truncated_prefix is False
    assert context.selection.message_char_count == 15_000
    assert context.selection.omitted_message_count == 2


def test_oversized_newest_message_keeps_its_latest_unicode_code_points() -> None:
    prefix = "discard-me"
    newest = prefix + "🦋" * MAX_NPC_CONTEXT_MESSAGE_CHARS
    context = build_npc_context(
        _task(messages=[{"id": "latest", "role": "human", "content": newest}])
    )

    assert context.messages[0].content == "🦋" * MAX_NPC_CONTEXT_MESSAGE_CHARS
    assert len(context.messages[0].content) == MAX_NPC_CONTEXT_MESSAGE_CHARS
    assert context.messages[0].truncated_prefix is True
    assert context.selection.truncated_newest_message is True


def test_task_rejects_more_than_twelve_explicit_pins() -> None:
    pins = [
        {"id": f"pin-{index}", "title": "Pin", "content": "Only this data"}
        for index in range(13)
    ]
    with pytest.raises(ValidationError, match="too_long"):
        _task(pins=pins)


def test_npc_reply_schema_forbids_actions_and_arbitrary_fields() -> None:
    schema = npc_reply_output_schema()
    assert schema["additionalProperties"] is False
    assert set(schema["properties"]) == {"spokenText", "stageDirection", "emotion"}
    with pytest.raises(ValidationError, match="extra_forbidden"):
        NpcReplyOutputV1.model_validate(
            {"spokenText": "Welcome.", "rollDice": "1d100"}
        )


def test_jsonl_route_prepares_bounded_context_and_validates_mock_output() -> None:
    output = io.StringIO()
    request = {
        "id": "npc-task",
        "type": "prepare_npc_reply",
        "payload": {
            "provider": "deepseek",
            "model": "mock-model",
            "npcCard": {"id": "npc:host", "name": "The Host"},
            "pins": [{"id": "pin-1", "title": "Voice", "content": "Speak softly."}],
            "messages": [
                {"id": "m-1", "role": "human", "content": "Who are you?"}
            ],
            "mockResponse": {
                "spokenText": "I am merely the caretaker.",
                "stageDirection": "He lowers his eyes.",
                "emotion": "guarded",
            },
        },
    }

    assert run_stream(io.StringIO(json.dumps(request) + "\n"), output) == 0
    event = _events(output)[-1]
    assert event["type"] == "result"
    result = event["result"]
    assert result["status"] == "mocked"
    assert result["context"]["messages"][0]["content"] == "Who are you?"
    assert result["reply"] == {
        "spokenText": "I am merely the caretaker.",
        "stageDirection": "He lowers his eyes.",
        "emotion": "guarded",
    }


@pytest.mark.parametrize(
    "extra",
    [
        {"roomContext": {"chat": "must not enter the NPC adapter"}},
        {"filesystem": {"path": "C:/secrets"}},
        {"tools": ["rollDice"]},
    ],
)
def test_jsonl_route_has_no_room_file_or_tool_context_entry(extra: dict[str, object]) -> None:
    output = io.StringIO()
    payload: dict[str, object] = {
        "provider": "codex",
        "npcCard": {"id": "npc:host", "name": "The Host"},
        "messages": [],
        **extra,
    }
    request = {"id": "blocked", "type": "prepare_npc_reply", "payload": payload}

    run_stream(io.StringIO(json.dumps(request) + "\n"), output)
    event = _events(output)[-1]
    assert event["type"] == "error"
    assert event["error"]["code"] == "INVALID_NPC_TASK"
