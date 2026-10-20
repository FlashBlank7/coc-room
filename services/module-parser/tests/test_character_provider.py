from __future__ import annotations

import io
import json
import subprocess
from pathlib import Path

import httpx
import pytest

from coc_module_parser.character_provider import (
    CharacterDraftProviderOutputV1,
    CHARACTER_DRAFT_INSTRUCTIONS,
    DeepSeekCharacterDraftProvider,
    GenerateCharacterDraftTaskV1,
    character_draft_output_schema,
    generate_character_draft,
)
from coc_module_parser.cli import run_stream
from coc_module_parser.client import (
    EmptyResponseError,
    InvalidStructureError,
    TruncatedResponseError,
)


def _draft_payload() -> dict[str, object]:
    return {
        "name": "Evelyn Ward",
        "occupation": "Antiquarian",
        "age": 32,
        "residence": "Boston",
        "birthplace": "Providence",
        "characteristics": {
            "str": 50,
            "con": 50,
            "siz": 60,
            "dex": 55,
            "app": 60,
            "int": 70,
            "pow": 60,
            "edu": 75,
            "luck": 50,
        },
        "skills": [
            {
                "name": "Library Use",
                "specialization": None,
                "baseValue": 20,
                "value": 70,
                "checked": False,
            },
            {
                "name": "Cthulhu Mythos",
                "specialization": None,
                "baseValue": 0,
                "value": 5,
                "checked": False,
            },
        ],
        "inventory": [
            {
                "name": "Notebook",
                "quantity": 1,
                "description": "Field notes.",
                "equipped": True,
            }
        ],
        "background": {
            "personalDescription": "Careful and impeccably dressed.",
            "ideologyAndBeliefs": "Knowledge should be preserved.",
            "significantPeople": "Professor Hale",
            "meaningfulLocations": "The university archive",
            "treasuredPossessions": "A brass bookmark",
            "traits": "Patient",
            "injuriesAndScars": "",
            "phobiasAndManias": "",
            "arcaneTomesSpellsAndArtifacts": "",
            "encountersWithStrangeEntities": "",
        },
        "notes": "AI draft; review before publishing.",
    }


def _task(**updates: object) -> GenerateCharacterDraftTaskV1:
    payload: dict[str, object] = {
        "provider": "deepseek",
        "model": "draft-test-model",
        "prompt": "Create a cautious 1920s antiquarian.",
        "playerName": "Alice",
        "ownerSeatId": "seat:alice",
        "apiKey": "CHARACTER-SECRET-KEY",
    }
    payload.update(updates)
    return GenerateCharacterDraftTaskV1.model_validate(payload)


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


def test_deepseek_character_input_is_narrow_and_result_matches_character_wire_shape() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=_completed(json.dumps(_draft_payload())))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = generate_character_draft(_task(), deepseek_client=client)

    request_body = json.loads(requests[0].content)
    provider_input = json.loads(request_body["input"])
    assert provider_input == {
        "prompt": "Create a cautious 1920s antiquarian.",
        "playerName": "Alice",
    }
    assert "seat:alice" not in requests[0].content.decode("utf-8")
    assert "CHARACTER-SECRET-KEY" not in requests[0].content.decode("utf-8")
    assert request_body["tools"] == []
    assert request_body["tool_choice"] == "none"
    assert request_body["text"]["format"]["type"] == "json_schema"

    character = result.character.model_dump(mode="json", by_alias=True, exclude_none=True)
    assert set(character) == {
        "schemaVersion",
        "id",
        "ownerPeerId",
        "name",
        "playerName",
        "occupation",
        "age",
        "residence",
        "birthplace",
        "characteristics",
        "derived",
        "skills",
        "status",
        "inventory",
        "background",
        "notes",
        "updatedAt",
        "extensions",
    }
    assert character["schemaVersion"] == 1
    assert character["id"].startswith("character:")
    assert character["ownerPeerId"] == "seat:alice"
    assert character["playerName"] == "Alice"
    assert set(character["characteristics"]) == {
        "str",
        "con",
        "siz",
        "dex",
        "app",
        "int",
        "pow",
        "edu",
        "luck",
    }
    assert character["derived"] == {
        "hitPoints": 11,
        "maxHitPoints": 11,
        "magicPoints": 12,
        "maxMagicPoints": 12,
        "sanity": 60,
        "maxSanity": 94,
        "movementRate": 7,
        "build": 0,
        "damageBonus": "0",
    }
    assert all(skill["id"].startswith("skill:") for skill in character["skills"])
    assert character["skills"][0]["baseValue"] == 20
    assert character["inventory"][0]["id"].startswith("item:")
    assert character["status"] == {
        "temporaryInsanity": False,
        "indefiniteInsanity": False,
        "majorWound": False,
        "dying": False,
        "unconscious": False,
    }


@pytest.mark.parametrize(
    ("body", "error"),
    [
        (_completed(""), EmptyResponseError),
        (_completed('{"name":"unfinished"'), TruncatedResponseError),
        (_completed(json.dumps({"name": "Missing everything else"})), InvalidStructureError),
    ],
)
def test_character_provider_rejects_empty_truncated_and_invalid_drafts(
    body: dict[str, object], error: type[Exception]
) -> None:
    client = httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=body))
    )
    with pytest.raises(error):
        generate_character_draft(_task(), deepseek_client=client)


def test_codex_character_draft_keeps_same_toolless_isolation_and_narrow_input() -> None:
    captured: dict[str, object] = {}

    def runner(command: list[str], **options: object) -> subprocess.CompletedProcess[str]:
        if command[1:] == ["login", "status"]:
            return subprocess.CompletedProcess(command, 0)
        captured["command"] = command
        captured["options"] = options
        result_path = Path(command[command.index("--output-last-message") + 1])
        result_path.write_text(json.dumps(_draft_payload()), encoding="utf-8")
        return subprocess.CompletedProcess(command, 0)

    task = _task(provider="codex", model="", apiKey=None)
    result = generate_character_draft(task, codex_runner=runner)

    assert result.character.owner_peer_id == "seat:alice"
    command = captured["command"]
    options = captured["options"]
    assert isinstance(command, list)
    assert Path(command[0]).name.casefold() in {"codex", "codex.exe"}
    assert command[1] == "exec"
    assert "--ephemeral" in command
    assert command[command.index("--sandbox") + 1] == "read-only"
    assert command[-1] == "-"
    disabled = {
        command[index + 1]
        for index, value in enumerate(command)
        if value == "--disable"
    }
    assert {
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
    } == disabled
    assert isinstance(options, dict)
    assert json.loads(str(options["input"])) == {
        "prompt": "Create a cautious 1920s antiquarian.",
        "playerName": "Alice",
    }
    assert "seat:alice" not in str(options["input"])


@pytest.mark.parametrize(
    "forbidden",
    [
        {"sourcePath": "C:/private.txt"},
        {"roomContext": {"chat": "not allowed"}},
        {"module": {"keeperNotes": "not allowed"}},
        {"tools": ["shell"]},
        {"baseUrl": "https://proxy.example"},
        {"codexExecutable": "C:/arbitrary.exe"},
    ],
)
def test_character_action_rejects_paths_tools_room_module_and_network_parameters(
    forbidden: dict[str, object],
) -> None:
    payload: dict[str, object] = {
        "provider": "codex",
        "prompt": "A journalist",
        "playerName": "Alice",
        "ownerSeatId": "seat:alice",
        **forbidden,
    }
    with pytest.raises(Exception, match="extra_forbidden"):
        GenerateCharacterDraftTaskV1.model_validate(payload)


def test_character_jsonl_action_returns_full_draft_without_echoing_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "CHARACTER-JSONL-SECRET"

    def fake_generate(
        self: DeepSeekCharacterDraftProvider,
        provider_input: str,
    ) -> CharacterDraftProviderOutputV1:
        assert json.loads(provider_input) == {
            "prompt": "A cautious antiquarian",
            "playerName": "Alice",
        }
        return CharacterDraftProviderOutputV1.model_validate(_draft_payload())

    monkeypatch.setattr(DeepSeekCharacterDraftProvider, "generate", fake_generate)
    request = {
        "id": "character-one",
        "type": "generate_character_draft",
        "payload": {
            "provider": "deepseek",
            "model": "draft-test-model",
            "prompt": "A cautious antiquarian",
            "playerName": "Alice",
            "ownerSeatId": "seat:alice",
            "apiKey": secret,
        },
    }
    output = io.StringIO()

    assert run_stream(io.StringIO(json.dumps(request) + "\n"), output) == 0

    assert secret not in output.getvalue()
    event = _events(output)[-1]
    assert event["type"] == "result"
    assert event["result"]["status"] == "draft"
    assert event["result"]["provider"] == "deepseek"
    character = event["result"]["character"]
    assert character["schemaVersion"] == 1
    assert character["ownerPeerId"] == "seat:alice"
    assert character["playerName"] == "Alice"
    assert character["extensions"] == {}


def test_character_provider_schema_is_closed_and_strict() -> None:
    schema = character_draft_output_schema()
    assert schema["additionalProperties"] is False
    assert schema["required"] == list(schema["properties"])
    assert set(schema["properties"]) == {
        "name",
        "occupation",
        "age",
        "residence",
        "birthplace",
        "characteristics",
        "skills",
        "creation",
        "inventory",
        "background",
        "notes",
    }


def test_browser_and_sidecar_share_the_character_draft_contract() -> None:
    root = Path(__file__).resolve().parents[3]
    contract = json.loads((root / "apps/desktop/src/ai/character-draft-contract.json").read_text(encoding="utf-8"))
    assert contract == {"instructions": CHARACTER_DRAFT_INSTRUCTIONS, "schema": character_draft_output_schema()}


def _draft_with_creation() -> dict[str, object]:
    draft = _draft_payload()
    draft["occupation"] = "Custom research doctor"
    draft["creation"] = {
        "occupationFormula": "edu4", "occupationBudget": None, "interestBudget": None,
        "creditMin": 0, "creditMax": 99, "occupationSkillIndexes": [0],
        "allocations": [{"skillIndex": 0, "occupation": 40, "interest": 10}, {"skillIndex": 1, "occupation": 0, "interest": 5}],
    }
    return draft


def test_character_points_follow_the_generated_skill_ids_in_the_wire_result() -> None:
    draft = _draft_with_creation()
    client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=_completed(json.dumps(draft)))))
    result = generate_character_draft(_task(), deepseek_client=client).character.model_dump(mode="json", by_alias=True, exclude_none=True)
    plan = result["creation"]
    assert plan["origin"] == "ai"
    assert plan["occupationFormula"] == "edu4"
    assert plan["occupationSkillIds"] == [result["skills"][0]["id"]]
    assert plan["allocations"][result["skills"][0]["id"]] == {"occupation": 40, "interest": 10}
    assert plan["allocations"][result["skills"][1]["id"]] == {"occupation": 0, "interest": 5}
    assert "occupationBudget" not in plan
    assert "skillIndex" not in json.dumps(result)


@pytest.mark.parametrize("change", [
    {"occupationSkillIndexes": [2]},
    {"occupationSkillIndexes": [0, 0]},
    {"allocations": [{"skillIndex": 0, "occupation": 40, "interest": 10}]},
    {"allocations": [{"skillIndex": 0, "occupation": 40, "interest": 10}, {"skillIndex": 0, "occupation": 0, "interest": 5}]},
])
def test_invalid_creation_references_cannot_attach_points_to_the_wrong_skill(change: dict) -> None:
    from pydantic import ValidationError
    draft = _draft_with_creation()
    draft["creation"].update(change)
    with pytest.raises(ValidationError):
        CharacterDraftProviderOutputV1.model_validate(draft)
