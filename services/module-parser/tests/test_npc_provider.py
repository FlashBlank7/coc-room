from __future__ import annotations

import io
import json
import subprocess
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr

from coc_module_parser import cli as cli_module
from coc_module_parser.cli import run_stream
from coc_module_parser.client import (
    EmptyResponseError,
    InvalidStructureError,
    TruncatedResponseError,
)
from coc_module_parser.npc_context import (
    MAX_NPC_CONTEXT_MESSAGES,
    NpcContextSelectionV1,
    NpcReplyOutputV1,
)
from coc_module_parser.npc_provider import (
    GenerateNpcReplyTaskV1,
    NpcReplyRunResultV1,
    generate_npc_reply,
    npc_provider_output_schema,
)


def _task(**updates: object) -> GenerateNpcReplyTaskV1:
    payload: dict[str, object] = {
        "provider": "deepseek",
        "model": "npc-test-model",
        "apiKey": "provider-secret-key",
        "npcCard": {
            "id": "npc:caretaker",
            "name": "The Caretaker",
            "description": "He protects the locked gallery.",
            "traits": ["guarded"],
        },
        "pins": [
            {
                "id": "pin:voice",
                "title": "Voice",
                "content": "Speak quietly and avoid modern slang.",
            }
        ],
        "messages": [
            {"id": "message:latest", "role": "human", "content": "Who are you?"}
        ],
    }
    payload.update(updates)
    return GenerateNpcReplyTaskV1.model_validate(payload)


def _completed(text: str) -> dict[str, object]:
    return {
        "status": "completed",
        "output": [
            {
                "type": "message",
                "status": "completed",
                "content": [{"type": "output_text", "text": text}],
            }
        ],
    }


def _events(stream: io.StringIO) -> list[dict[str, object]]:
    return [json.loads(line) for line in stream.getvalue().splitlines()]


def test_deepseek_receives_only_bounded_panel_context_and_strict_schema() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json=_completed(
                json.dumps(
                    {
                        "spokenText": "I keep this house.",
                        "stageDirection": "He lowers his lantern.",
                        "emotion": "wary",
                    }
                )
            ),
        )

    old_messages = [
        {
            "id": f"message:old-{index}",
            "role": "human",
            "content": "OUTSIDE-PANEL-WINDOW-SECRET" if index == 0 else f"old {index}",
        }
        for index in range(MAX_NPC_CONTEXT_MESSAGES + 1)
    ]
    task = _task(messages=[*old_messages, {"id": "message:new", "role": "human", "content": "Answer me."}])
    client = httpx.Client(transport=httpx.MockTransport(handler))

    result = generate_npc_reply(task, deepseek_client=client)

    assert result.reply.spoken_text == "I keep this house."
    assert result.selection.selected_message_count == MAX_NPC_CONTEXT_MESSAGES
    request_body = json.loads(requests[0].content)
    provider_input = json.loads(request_body["input"])
    assert set(provider_input) == {"npcCard", "pins", "messages"}
    assert len(provider_input["pins"]) == 1
    assert len(provider_input["messages"]) == MAX_NPC_CONTEXT_MESSAGES
    assert provider_input["messages"][-1]["content"] == "Answer me."
    assert "selection" not in provider_input
    assert "provider-secret-key" not in requests[0].content.decode("utf-8")
    assert "OUTSIDE-PANEL-WINDOW-SECRET" not in requests[0].content.decode("utf-8")
    assert request_body["tools"] == []
    assert request_body["tool_choice"] == "none"
    assert request_body["text"]["format"]["type"] == "json_schema"
    assert set(request_body["text"]["format"]["schema"]["properties"]) == {
        "spokenText",
        "stageDirection",
        "emotion",
    }


@pytest.mark.parametrize(
    ("body", "error"),
    [
        (_completed(""), EmptyResponseError),
        (_completed('{"spokenText":"unfinished"'), TruncatedResponseError),
        (
            _completed(
                json.dumps(
                    {
                        "spokenText": "Hello.",
                        "stageDirection": None,
                        "emotion": None,
                        "rollDice": "1d100",
                    }
                )
            ),
            InvalidStructureError,
        ),
        (
            {
                "status": "incomplete",
                "incomplete_details": {"reason": "max_output_tokens"},
            },
            TruncatedResponseError,
        ),
    ],
)
def test_deepseek_empty_truncated_and_invalid_output_is_rejected(
    body: dict[str, object], error: type[Exception]
) -> None:
    client = httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=body))
    )
    with pytest.raises(error):
        generate_npc_reply(_task(), deepseek_client=client)


def test_codex_uses_dedicated_ephemeral_toolless_command_and_only_panel_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def runner(command: list[str], **options: object) -> subprocess.CompletedProcess[str]:
        if command[1:] == ["login", "status"]:
            return subprocess.CompletedProcess(command, 0)
        captured["command"] = command
        captured["options"] = options
        result_path = Path(command[command.index("--output-last-message") + 1])
        schema_path = Path(command[command.index("--output-schema") + 1])
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        assert set(schema["properties"]) == {"spokenText", "stageDirection", "emotion"}
        result_path.write_text(
            json.dumps(
                {
                    "spokenText": "The gallery is closed.",
                    "stageDirection": None,
                    "emotion": "firm",
                }
            ),
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setenv("OPENAI_API_KEY", "must-not-be-inherited")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "also-must-not-be-inherited")
    task = _task(
        provider="codex",
        model="",
        apiKey=None,
        codexExecutable="codex-test-double",
    )

    result = generate_npc_reply(task, codex_runner=runner)

    assert result.reply.spoken_text == "The gallery is closed."
    command = captured["command"]
    options = captured["options"]
    assert isinstance(command, list)
    assert command[:2] == ["codex-test-double", "exec"]
    assert "--ephemeral" in command
    assert "--ignore-user-config" in command
    assert "--ignore-rules" in command
    assert "--strict-config" in command
    assert command[command.index("--sandbox") + 1] == "read-only"
    assert "--ask-for-approval" not in command
    assert "--model" not in command
    assert command[-1] == "-"
    disabled = [
        command[index + 1]
        for index, value in enumerate(command)
        if value == "--disable"
    ]
    assert disabled == [
        "shell_tool",
        "unified_exec",
        "apps",
        "plugins",
        "multi_agent",
        "goals",
        "view_image",
        "image_generation",
        "browser_use",
        "browser_use_external",
        "browser_use_full_cdp_access",
        "computer_use",
        "in_app_browser",
    ]
    config_values = [
        command[index + 1]
        for index, value in enumerate(command)
        if value == "--config"
    ]
    assert 'web_search="disabled"' in config_values
    assert "project_doc_max_bytes=0" in config_values
    assert "skills.bundled.enabled=false" in config_values
    assert "skills.include_instructions=false" in config_values
    assert "include_environment_context=false" in config_values
    assert "include_apps_instructions=false" in config_values
    assert "include_collaboration_mode_instructions=false" in config_values
    assert "include_permissions_instructions=false" in config_values
    assert isinstance(options, dict)
    provider_input = json.loads(str(options["input"]))
    assert set(provider_input) == {"npcCard", "pins", "messages"}
    assert provider_input["messages"][-1]["content"] == "Who are you?"
    assert "OPENAI_API_KEY" not in options["env"]
    assert "DEEPSEEK_API_KEY" not in options["env"]


def test_codex_empty_result_is_rejected() -> None:
    def runner(command: list[str], **options: object) -> subprocess.CompletedProcess[str]:
        del options
        if command[1:] == ["login", "status"]:
            return subprocess.CompletedProcess(command, 0)
        result_path = Path(command[command.index("--output-last-message") + 1])
        result_path.write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0)

    context_task = _task(provider="codex", apiKey=None)
    with pytest.raises(EmptyResponseError):
        generate_npc_reply(context_task, codex_runner=runner)


def test_generate_npc_reply_jsonl_contract_does_not_echo_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "JSONL-DO-NOT-ECHO-SECRET"

    def fake_generate(task: GenerateNpcReplyTaskV1) -> NpcReplyRunResultV1:
        assert task.api_key is not None
        assert task.api_key.get_secret_value() == secret
        return NpcReplyRunResultV1(
            provider="deepseek",
            model="npc-test-model",
            selection=NpcContextSelectionV1(
                availableMessageCount=1,
                selectedMessageCount=1,
                omittedMessageCount=0,
                messageCharCount=12,
                truncatedNewestMessage=False,
            ),
            reply=NpcReplyOutputV1(
                spokenText="I am the caretaker.",
                emotion="guarded",
            ),
        )

    monkeypatch.setattr(cli_module, "generate_npc_reply", fake_generate)
    request = {
        "id": "npc-generate",
        "type": "generate_npc_reply",
        "payload": {
            "provider": "deepseek",
            "model": "npc-test-model",
            "apiKey": secret,
            "npcCard": {"id": "npc:caretaker", "name": "The Caretaker"},
            "pins": [],
            "messages": [
                {"id": "message:one", "role": "human", "content": "Who are you?"}
            ],
        },
    }
    output = io.StringIO()

    assert run_stream(io.StringIO(json.dumps(request) + "\n"), output) == 0

    assert secret not in output.getvalue()
    event = _events(output)[-1]
    assert event == {
        "protocol_version": "1.0",
        "request_id": "npc-generate",
        "type": "result",
        "result": {
            "status": "completed",
            "provider": "deepseek",
            "model": "npc-test-model",
            "contextSelection": {
                "availableMessageCount": 1,
                "selectedMessageCount": 1,
                "omittedMessageCount": 0,
                "messageCharCount": 12,
                "truncatedNewestMessage": False,
            },
            "reply": {
                "spokenText": "I am the caretaker.",
                "emotion": "guarded",
            },
        },
    }


@pytest.mark.parametrize(
    "forbidden",
    [
        {"roomContext": {"chat": "outside the panel"}},
        {"filesystem": {"path": "C:/private"}},
        {"tools": ["rollDice"]},
    ],
)
def test_generate_route_rejects_any_non_panel_context(
    forbidden: dict[str, object],
) -> None:
    request = {
        "id": "npc-rejected",
        "type": "generate_npc_reply",
        "payload": {
            "provider": "codex",
            "npcCard": {"id": "npc:caretaker", "name": "The Caretaker"},
            "pins": [],
            "messages": [],
            **forbidden,
        },
    }
    output = io.StringIO()

    run_stream(io.StringIO(json.dumps(request) + "\n"), output)

    event = _events(output)[-1]
    assert event["type"] == "error"
    assert event["error"]["code"] == "INVALID_NPC_TASK"


def test_provider_schema_has_only_fixed_reply_fields_and_no_free_form_objects() -> None:
    schema = npc_provider_output_schema()
    assert schema["additionalProperties"] is False
    assert schema["required"] == ["spokenText", "stageDirection", "emotion"]
    assert set(schema["properties"]) == {"spokenText", "stageDirection", "emotion"}


def test_secret_is_excluded_from_task_dump_and_repr() -> None:
    task = _task()
    dumped = task.model_dump(mode="json", by_alias=True)
    assert "apiKey" not in dumped
    assert "provider-secret-key" not in repr(task)
    assert isinstance(task.api_key, SecretStr)
