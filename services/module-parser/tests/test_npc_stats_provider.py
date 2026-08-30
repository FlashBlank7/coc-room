from __future__ import annotations

import io
import json
import subprocess
from pathlib import Path

import httpx
import pytest

from coc_module_parser.cli import run_stream
from coc_module_parser.client import InvalidStructureError, TruncatedResponseError
from coc_module_parser.npc_stats_provider import (
    CodexNpcStatsDraftProvider,
    DeepSeekNpcStatsDraftProvider,
    GenerateNpcStatsDraftTaskV1,
    NpcStatsProviderOutputV1,
    generate_npc_stats_draft,
    npc_stats_output_schema,
)


def _stats_payload() -> dict[str, object]:
    return {
        "characteristics": {
            "str": 65,
            "con": 55,
            "siz": 60,
            "dex": 70,
            "int": 75,
            "pow": 50,
            "app": 45,
            "edu": 65,
        },
        "skills": [
            {"name": "Spot Hidden", "value": 60},
            {"name": "Stealth", "value": 55},
        ],
        "hitPoints": 11,
        "sanity": 50,
    }


def _task(**updates: object) -> GenerateNpcStatsDraftTaskV1:
    payload: dict[str, object] = {
        "provider": "deepseek",
        "model": "npc-stats-test",
        "npcId": "npc:night-watchman",
        "name": "Night Watchman",
        "description": "An alert former soldier guarding a museum.",
        "guidance": "Competent but not exceptional.",
        "apiKey": "NPC-STATS-SECRET",
    }
    payload.update(updates)
    return GenerateNpcStatsDraftTaskV1.model_validate(payload)


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


def test_deepseek_npc_stats_input_is_narrow_toolless_and_returns_wire_shape() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=_completed(json.dumps(_stats_payload())))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = generate_npc_stats_draft(_task(), deepseek_client=client)

    request_text = requests[0].content.decode("utf-8")
    body = json.loads(request_text)
    assert json.loads(body["input"]) == {
        "name": "Night Watchman",
        "description": "An alert former soldier guarding a museum.",
        "guidance": "Competent but not exceptional.",
    }
    assert "npc:night-watchman" not in body["input"]
    assert "NPC-STATS-SECRET" not in request_text
    assert body["tools"] == []
    assert body["tool_choice"] == "none"
    assert body["text"]["format"]["type"] == "json_schema"

    wire = result.character.model_dump(mode="json", by_alias=True, exclude_none=True)
    assert result.npc_id == "npc:night-watchman"
    assert wire == {
        "characteristics": {
            "str": 65,
            "con": 55,
            "siz": 60,
            "dex": 70,
            "int": 75,
            "pow": 50,
            "app": 45,
            "edu": 65,
        },
        "skills": {"Spot Hidden": 60, "Stealth": 55},
        "hitPoints": 11,
        "sanity": 50,
    }


def test_codex_npc_stats_keeps_the_toolless_executor_and_narrow_input() -> None:
    captured: dict[str, object] = {}

    def runner(command: list[str], **options: object) -> subprocess.CompletedProcess[str]:
        if command[1:] == ["login", "status"]:
            return subprocess.CompletedProcess(command, 0)
        captured["command"] = command
        captured["options"] = options
        result_path = Path(command[command.index("--output-last-message") + 1])
        result_path.write_text(json.dumps(_stats_payload()), encoding="utf-8")
        return subprocess.CompletedProcess(command, 0)

    result = generate_npc_stats_draft(
        _task(provider="codex", model="", apiKey=None), codex_runner=runner
    )

    assert result.character.hit_points == 11
    command = captured["command"]
    options = captured["options"]
    assert isinstance(command, list)
    assert command[1] == "exec"
    assert command[command.index("--sandbox") + 1] == "read-only"
    assert command[-1] == "-"
    disabled = {
        command[index + 1]
        for index, value in enumerate(command)
        if value == "--disable"
    }
    assert {"shell_tool", "unified_exec", "apps", "plugins", "browser_use"} <= disabled
    assert isinstance(options, dict)
    assert json.loads(str(options["input"])) == {
        "name": "Night Watchman",
        "description": "An alert former soldier guarding a museum.",
        "guidance": "Competent but not exceptional.",
    }


@pytest.mark.parametrize(
    "forbidden",
    [
        {"sourcePath": "C:/keeper/secrets.txt"},
        {"roomContext": {"chat": "not allowed"}},
        {"module": {"keeperNotes": "not allowed"}},
        {"tools": ["shell"]},
        {"baseUrl": "https://proxy.example"},
        {"codexExecutable": "C:/arbitrary.exe"},
    ],
)
def test_npc_stats_task_rejects_proxy_fields(forbidden: dict[str, object]) -> None:
    with pytest.raises(Exception, match="extra_forbidden"):
        GenerateNpcStatsDraftTaskV1.model_validate(
            {
                "provider": "codex",
                "npcId": "npc:watchman",
                "name": "Watchman",
                **forbidden,
            }
        )


def test_npc_stats_output_rejects_truncation_invalid_ranges_and_duplicates() -> None:
    provider = DeepSeekNpcStatsDraftProvider(
        api_key=_task().api_key,  # type: ignore[arg-type]
        client=httpx.Client(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(200, json=_completed('{"characteristics":'))
            )
        ),
    )
    with pytest.raises(TruncatedResponseError):
        provider.generate('{"name":"Watchman","description":"","guidance":""}')

    invalid = _stats_payload()
    invalid["hitPoints"] = 1000
    with pytest.raises(InvalidStructureError):
        DeepSeekNpcStatsDraftProvider(
            api_key=_task().api_key,  # type: ignore[arg-type]
            client=httpx.Client(
                transport=httpx.MockTransport(
                    lambda request: httpx.Response(200, json=_completed(json.dumps(invalid)))
                )
            ),
        ).generate('{"name":"Watchman","description":"","guidance":""}')

    duplicate = _stats_payload()
    duplicate["skills"] = [
        {"name": "Stealth", "value": 50},
        {"name": "stealth", "value": 60},
    ]
    with pytest.raises(Exception, match="unique"):
        NpcStatsProviderOutputV1.model_validate(duplicate)


def test_npc_stats_jsonl_action_returns_local_draft_without_echoing_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "NPC-STATS-JSONL-SECRET"

    def fake_generate(
        self: DeepSeekNpcStatsDraftProvider,
        provider_input: str,
    ) -> NpcStatsProviderOutputV1:
        assert json.loads(provider_input) == {
            "name": "Watchman",
            "description": "Museum guard",
            "guidance": "Older veteran",
        }
        return NpcStatsProviderOutputV1.model_validate(_stats_payload())

    monkeypatch.setattr(DeepSeekNpcStatsDraftProvider, "generate", fake_generate)
    output = io.StringIO()
    request = {
        "id": "npc-stats-one",
        "action": "generate_npc_stats_draft",
        "provider": "deepseek",
        "npcId": "npc:watchman",
        "name": "Watchman",
        "description": "Museum guard",
        "guidance": "Older veteran",
        "apiKey": secret,
    }

    assert run_stream(io.StringIO(json.dumps(request) + "\n"), output) == 0
    assert secret not in output.getvalue()
    event = json.loads(output.getvalue().splitlines()[-1])
    assert event["type"] == "result"
    assert event["result"]["status"] == "draft"
    assert event["result"]["npcId"] == "npc:watchman"
    assert event["result"]["character"]["hitPoints"] == 11


def test_npc_stats_schema_is_closed_and_strict() -> None:
    schema = npc_stats_output_schema()
    assert schema["additionalProperties"] is False
    assert schema["required"] == list(schema["properties"])
    assert set(schema["properties"]) == {
        "characteristics",
        "skills",
        "hitPoints",
        "sanity",
    }
