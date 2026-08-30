from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts" / "dev_bridge_sidecar.py"
SPEC = importlib.util.spec_from_file_location("dev_bridge_sidecar", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


def test_keyring_target_matches_tauri_keyring_mapping() -> None:
    assert bridge.KEYRING_TARGET == "deepseek-api-key.org.coc-room.desktop"


def test_codex_probe_environment_uses_login_paths_but_not_provider_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("USERPROFILE", r"C:\Users\keeper")
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-be-inherited")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "must-not-be-inherited")
    environment = bridge.codex_probe_environment()
    assert environment["USERPROFILE"] == r"C:\Users\keeper"
    assert environment["NO_COLOR"] == "1"
    assert "OPENAI_API_KEY" not in environment
    assert "DEEPSEEK_API_KEY" not in environment


def test_bridge_rejects_browser_credentials_commands_and_provider_endpoints() -> None:
    base = {
        "id": "parse_01",
        "action": "parse_module",
        "source_text": "# Test",
        "source_name": "test.md",
        "provider": "codex",
        "model": "",
        "mock": False,
    }
    for forbidden in ("api_key", "codex_executable", "base_url", "tools", "command"):
        with pytest.raises(ValueError, match="forbidden"):
            bridge.validate_request({**base, forbidden: "should-not-cross-boundary"})


def test_bridge_parse_module_accepts_bounded_generation_settings() -> None:
    request = {
        "id": "parse_02",
        "action": "parse_module",
        "source_text": "# Test",
        "source_name": "test.md",
        "provider": "codex",
        "model": "",
        "mock": True,
        "max_chunk_chars": 30_000,
        "chunk_overlap_chars": 500,
        "max_retries": 3,
        "max_output_tokens": 32_000,
        "codex_timeout_seconds": 3_600,
        "codex_heartbeat_seconds": 15,
    }

    assert bridge.validate_request(request) == request


def test_bridge_accepts_only_paths_below_its_private_temporary_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bridge_root = tmp_path / "bridge"
    bridge_root.mkdir()
    allowed = bridge_root / "scenario.docx"
    allowed.write_bytes(b"placeholder")
    outside = tmp_path / "outside.docx"
    outside.write_bytes(b"placeholder")
    monkeypatch.setenv("COC_ROOM_DEV_BRIDGE_TEMP_ROOT", str(bridge_root))
    base = {
        "id": "parse_01",
        "action": "parse_module",
        "source_name": "scenario.docx",
        "provider": "codex",
        "model": "",
        "mock": False,
    }

    result = bridge.validate_request({**base, "source_path": str(allowed)})
    assert Path(result["source_path"]) == allowed.resolve()
    with pytest.raises(ValueError, match="outside"):
        bridge.validate_request({**base, "source_path": str(outside)})


def test_status_exposes_only_credential_presence_and_bounded_codex_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    emitted: list[dict[str, Any]] = []
    monkeypatch.setattr(bridge, "_emit", emitted.append)
    monkeypatch.setattr(bridge, "has_deepseek_credential", lambda: True)
    monkeypatch.setattr(bridge, "_parser_ready", lambda: True)
    monkeypatch.setattr(bridge, "find_codex_executable", lambda: Path("codex-test-double"))
    monkeypatch.setattr(
        bridge,
        "_probe_codex",
        lambda _executable: {
            "installed": True,
            "compatible": True,
            "authenticated": True,
            "version": "codex-cli test",
        },
    )

    bridge.process({"id": "status_01", "action": "bridge_status"})

    assert emitted == [{
        "protocol_version": "1.0",
        "request_id": "status_01",
        "type": "result",
        "result": {
            "available": True,
            "parserReady": True,
            "deepseekKeyPresent": True,
            "codex": {
                "installed": True,
                "compatible": True,
                "authenticated": True,
                "version": "codex-cli test",
            },
        },
    }]
    assert "api_key" not in json.dumps(emitted)
    assert "credential" not in json.dumps(emitted).lower()


def test_deepseek_credential_is_injected_only_inside_one_shot_python_request(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import coc_module_parser.cli as parser_cli

    secret = "test-secret-that-must-not-be-emitted"
    emitted: list[dict[str, Any]] = []
    delegated_payloads: list[dict[str, Any]] = []
    monkeypatch.setenv("COC_ROOM_DEV_BRIDGE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(bridge, "_parser_ready", lambda: True)
    monkeypatch.setattr(bridge, "read_deepseek_credential", lambda: secret)
    monkeypatch.setattr(bridge, "_emit", emitted.append)

    def fake_process_request(payload: dict[str, Any], emit: Any) -> None:
        assert payload["api_key"] == secret
        delegated_payloads.append(payload)
        emit({
            "protocol_version": "1.0",
            "request_id": payload["id"],
            "type": "result",
            "module": {"test": True},
        })

    monkeypatch.setattr(parser_cli, "process_request", fake_process_request)
    bridge.process({
        "id": "deepseek_01",
        "action": "parse_module",
        "source_text": "# Test",
        "source_name": "test.md",
        "provider": "deepseek",
        "model": "deepseek-test",
        "mock": False,
    })

    assert len(delegated_payloads) == 1
    assert "api_key" not in delegated_payloads[0]
    assert secret not in json.dumps(emitted)


def test_codex_login_and_executable_are_resolved_by_the_wrapper(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import coc_module_parser.cli as parser_cli

    executable = (tmp_path / "codex-test-double.exe").resolve()
    emitted: list[dict[str, Any]] = []
    delegated_payloads: list[dict[str, Any]] = []
    monkeypatch.setenv("COC_ROOM_DEV_BRIDGE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(bridge, "_parser_ready", lambda: True)
    monkeypatch.setattr(bridge, "find_codex_executable", lambda: executable)
    monkeypatch.setattr(
        bridge,
        "_probe_codex",
        lambda _executable: {"installed": True, "compatible": True, "authenticated": True},
    )
    monkeypatch.setattr(bridge, "_emit", emitted.append)

    def fake_process_request(payload: dict[str, Any], emit: Any) -> None:
        delegated_payloads.append(payload)
        emit({
            "protocol_version": "1.0",
            "request_id": payload["id"],
            "type": "result",
            "module": {"test": True},
        })

    monkeypatch.setattr(parser_cli, "process_request", fake_process_request)
    bridge.process({
        "id": "codex_01",
        "action": "parse_module",
        "source_text": "# Test",
        "source_name": "test.md",
        "provider": "codex",
        "model": "",
        "mock": False,
    })

    assert delegated_payloads[0]["codex_executable"] == str(executable)
    assert all("api_key" not in event for event in emitted)


@pytest.mark.parametrize(
    "bridge_request",
    [
        {
            "id": "00000000-0000-4000-8000-000000000201",
            "action": "generate_character_draft",
            "provider": "codex",
            "model": "",
            "prompt": "A cautious journalist",
            "playerName": "Player One",
            "ownerSeatId": "seat-player",
        },
        {
            "id": "00000000-0000-4000-8000-000000000202",
            "action": "generate_npc_stats_draft",
            "provider": "codex",
            "model": "",
            "npcId": "npc:watchman",
            "name": "Watchman",
            "description": "A tired guard",
            "guidance": "Former soldier",
        },
        {
            "id": "00000000-0000-4000-8000-000000000203",
            "action": "generate_npc_reply",
            "provider": "codex",
            "model": "",
            "npc_card": {
                "id": "npc:watchman",
                "name": "Watchman",
                "description": "A tired guard",
                "role": "guard",
                "motivations": [],
                "traits": [],
                "source_refs": [],
            },
            "pins": [],
            "messages": [
                {"id": "message:1", "role": "human", "content": "Hello"}
            ],
        },
    ],
)
def test_fixed_ai_actions_have_action_specific_exact_browser_fields(
    bridge_request: dict[str, Any],
) -> None:
    assert bridge.validate_request(bridge_request) == bridge_request

    forbidden_fields = {
        "api_key": "secret",
        "apiKey": "secret",
        "source_path": r"C:\private.txt",
        "sourcePath": r"C:\private.txt",
        "command": "whoami",
        "tool": "shell",
        "tools": ["shell"],
        "timeout_seconds": 300,
        "timeoutMs": 300_000,
        "base_url": "https://attacker.invalid",
        "baseUrl": "https://attacker.invalid",
        "codex_executable": r"C:\other\codex.exe",
        "codexExecutable": r"C:\other\codex.exe",
        "room": {"history": "secret"},
        "module": {"notes": "secret"},
    }
    for field, value in forbidden_fields.items():
        with pytest.raises(ValueError, match="forbidden"):
            bridge.validate_request({**bridge_request, field: value})


def test_deepseek_character_credential_is_host_injected_without_cache_or_leak(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import coc_module_parser.cli as parser_cli

    secret = "fixed-ai-test-secret"
    private_prompt = "private investigator prompt"
    emitted: list[dict[str, Any]] = []
    delegated_keys: set[str] = set()
    monkeypatch.delenv("COC_ROOM_DEV_BRIDGE_CACHE_DIR", raising=False)
    monkeypatch.setattr(bridge, "_parser_ready", lambda: True)
    monkeypatch.setattr(bridge, "read_deepseek_credential", lambda: secret)
    monkeypatch.setattr(bridge, "_emit", emitted.append)

    def fake_process_request(payload: dict[str, Any], emit: Any) -> None:
        nonlocal delegated_keys
        assert payload["api_key"] == secret
        assert payload["prompt"] == private_prompt
        assert "cache_dir" not in payload
        delegated_keys = set(payload)
        emit(
            {
                "protocol_version": "1.0",
                "request_id": payload["id"],
                "type": "result",
                "result": {"status": "draft", "character": {"name": "Test"}},
            }
        )

    monkeypatch.setattr(parser_cli, "process_request", fake_process_request)
    bridge.process(
        {
            "id": "00000000-0000-4000-8000-000000000211",
            "action": "generate_character_draft",
            "provider": "deepseek",
            "model": "deepseek-test",
            "prompt": private_prompt,
            "playerName": "Player One",
            "ownerSeatId": "seat-player",
        }
    )

    assert "api_key" in delegated_keys
    serialized = json.dumps(emitted)
    assert secret not in serialized
    assert private_prompt not in serialized


@pytest.mark.parametrize(
    ("bridge_request", "expects_executable"),
    [
        (
            {
                "id": "00000000-0000-4000-8000-000000000221",
                "action": "generate_character_draft",
                "provider": "codex",
                "model": "",
                "prompt": "A journalist",
                "playerName": "Player One",
                "ownerSeatId": "seat-player",
            },
            False,
        ),
        (
            {
                "id": "00000000-0000-4000-8000-000000000222",
                "action": "generate_npc_stats_draft",
                "provider": "codex",
                "model": "",
                "npcId": "npc:watchman",
                "name": "Watchman",
                "description": "Guard",
                "guidance": "",
            },
            False,
        ),
        (
            {
                "id": "00000000-0000-4000-8000-000000000223",
                "action": "generate_npc_reply",
                "provider": "codex",
                "model": "",
                "npc_card": {
                    "id": "npc:watchman",
                    "name": "Watchman",
                    "description": "Guard",
                    "role": "guard",
                    "motivations": [],
                    "traits": [],
                    "source_refs": [],
                },
                "pins": [],
                "messages": [
                    {"id": "message:1", "role": "human", "content": "Hello"}
                ],
            },
            True,
        ),
    ],
)
def test_codex_fixed_ai_executable_is_scoped_to_accepting_task_schema(
    bridge_request: dict[str, Any],
    expects_executable: bool,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import coc_module_parser.cli as parser_cli

    executable = (tmp_path / "codex-test-double.exe").resolve()
    delegated: list[dict[str, Any]] = []
    monkeypatch.delenv("COC_ROOM_DEV_BRIDGE_CACHE_DIR", raising=False)
    monkeypatch.setattr(bridge, "_parser_ready", lambda: True)
    monkeypatch.setattr(bridge, "find_codex_executable", lambda: executable)
    monkeypatch.setattr(
        bridge,
        "_probe_codex",
        lambda _executable: {
            "installed": True,
            "compatible": True,
            "authenticated": True,
        },
    )
    monkeypatch.setattr(bridge, "_emit", lambda _event: None)

    def fake_process_request(payload: dict[str, Any], _emit: Any) -> None:
        delegated.append(dict(payload))

    monkeypatch.setattr(parser_cli, "process_request", fake_process_request)
    bridge.process(bridge_request)

    assert len(delegated) == 1
    assert ("codex_executable" in delegated[0]) is expects_executable
    if expects_executable:
        assert delegated[0]["codex_executable"] == str(executable)
    assert "cache_dir" not in delegated[0]


def test_fixed_ai_internal_failure_is_sanitized(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    import coc_module_parser.cli as parser_cli

    secret = "credential-secret"
    private_prompt = "private prompt text"
    emitted: list[dict[str, Any]] = []
    monkeypatch.setattr(bridge, "_parser_ready", lambda: True)
    monkeypatch.setattr(bridge, "read_deepseek_credential", lambda: secret)
    monkeypatch.setattr(bridge, "_emit", emitted.append)

    def fail(_payload: dict[str, Any], _emit: Any) -> None:
        raise RuntimeError(f"{secret}: {private_prompt}: provider detail")

    monkeypatch.setattr(parser_cli, "process_request", fail)
    bridge.process(
        {
            "id": "00000000-0000-4000-8000-000000000231",
            "action": "generate_character_draft",
            "provider": "deepseek",
            "model": "deepseek-test",
            "prompt": private_prompt,
            "playerName": "Player One",
            "ownerSeatId": "seat-player",
        }
    )

    serialized = json.dumps(emitted)
    captured = capsys.readouterr()
    assert emitted[-1]["error"]["code"] == "BRIDGE_INTERNAL_ERROR"
    assert secret not in serialized + captured.err
    assert private_prompt not in serialized + captured.err
    assert "provider detail" not in serialized + captured.err
    assert "RuntimeError" in captured.err
