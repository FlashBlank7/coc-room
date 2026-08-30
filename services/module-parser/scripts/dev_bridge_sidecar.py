"""One-shot, allowlisted development bridge wrapper for the Vite web shell.

The browser never supplies paths, commands, provider endpoints, credentials, or
tool configuration. Vite writes an uploaded file into a private temporary
directory, and this wrapper verifies that boundary before delegating to the
existing JSONL parser.
"""

from __future__ import annotations

import ctypes
import importlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = "1.0"
KEYRING_SERVICE = "org.coc-room.desktop"
KEYRING_ACCOUNT = "deepseek-api-key"
KEYRING_TARGET = f"{KEYRING_ACCOUNT}.{KEYRING_SERVICE}"
ALLOWED_ACTIONS = {
    "bridge_status",
    "parse_module",
    "render_pdf_pages",
    "inspect_pdf_pages",
    "generate_character_draft",
    "generate_npc_stats_draft",
    "generate_npc_reply",
}
ALLOWED_REQUEST_FIELDS_BY_ACTION = {
    "bridge_status": {"id", "action"},
    "parse_module": {
        "id",
        "action",
        "source_text",
        "source_path",
        "source_name",
        "provider",
        "model",
        "pdf_visual_page_numbers",
        "mock",
    },
    "render_pdf_pages": {"id", "action", "source_path", "page_numbers"},
    "inspect_pdf_pages": {"id", "action", "source_path", "page_numbers"},
    "generate_character_draft": {
        "id",
        "action",
        "provider",
        "model",
        "prompt",
        "playerName",
        "ownerSeatId",
    },
    "generate_npc_stats_draft": {
        "id",
        "action",
        "provider",
        "model",
        "npcId",
        "name",
        "description",
        "guidance",
    },
    "generate_npc_reply": {
        "id",
        "action",
        "provider",
        "model",
        "npc_card",
        "pins",
        "messages",
    },
}
CREATE_NO_WINDOW = 0x08000000


class CredentialError(RuntimeError):
    pass


if sys.platform == "win32":
    from ctypes import wintypes

    class FILETIME(ctypes.Structure):
        _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]

    class CREDENTIALW(ctypes.Structure):
        _fields_ = [
            ("Flags", wintypes.DWORD),
            ("Type", wintypes.DWORD),
            ("TargetName", wintypes.LPWSTR),
            ("Comment", wintypes.LPWSTR),
            ("LastWritten", FILETIME),
            ("CredentialBlobSize", wintypes.DWORD),
            ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
            ("Persist", wintypes.DWORD),
            ("AttributeCount", wintypes.DWORD),
            ("Attributes", ctypes.c_void_p),
            ("TargetAlias", wintypes.LPWSTR),
            ("UserName", wintypes.LPWSTR),
        ]

    _advapi32 = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
    _cred_read = _advapi32.CredReadW
    _cred_read.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.POINTER(CREDENTIALW))]
    _cred_read.restype = wintypes.BOOL
    _cred_free = _advapi32.CredFree
    _cred_free.argtypes = [ctypes.c_void_p]
    _cred_free.restype = None


def _request_id(payload: Any) -> str:
    if isinstance(payload, dict):
        value = payload.get("id")
        if isinstance(value, str) and 0 < len(value) <= 200:
            return value
    return "unknown"


def _emit(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _error(request_id: str, code: str, message: str) -> None:
    _emit(
        {
            "protocol_version": PROTOCOL_VERSION,
            "request_id": request_id,
            "type": "error",
            "message": message,
            "error": {"code": code, "message": message, "retryable": False},
        }
    )


def read_deepseek_credential() -> str | None:
    """Read the keyring-rs Windows credential without printing it."""

    if sys.platform != "win32":
        return None
    pointer = ctypes.POINTER(CREDENTIALW)()
    if not _cred_read(KEYRING_TARGET, 1, 0, ctypes.byref(pointer)):
        error = ctypes.get_last_error()
        if error == 1168:  # ERROR_NOT_FOUND
            return None
        raise CredentialError(f"Windows Credential Manager error {error}")
    try:
        credential = pointer.contents
        if credential.UserName != KEYRING_ACCOUNT:
            return None
        size = int(credential.CredentialBlobSize)
        if size <= 0 or size > 1024 or size % 2:
            raise CredentialError("credential payload has an invalid size")
        raw = ctypes.string_at(credential.CredentialBlob, size)
        try:
            value = raw.decode("utf-16-le")
        except UnicodeDecodeError as exc:
            raise CredentialError("credential payload has an invalid encoding") from exc
        return value if 0 < len(value) <= 512 else None
    finally:
        if pointer:
            credential = pointer.contents
            if credential.CredentialBlob and credential.CredentialBlobSize:
                ctypes.memset(credential.CredentialBlob, 0, credential.CredentialBlobSize)
            _cred_free(pointer)


def has_deepseek_credential() -> bool:
    """Check presence without copying the secret into a Python string."""

    if sys.platform != "win32":
        return False
    pointer = ctypes.POINTER(CREDENTIALW)()
    if not _cred_read(KEYRING_TARGET, 1, 0, ctypes.byref(pointer)):
        error = ctypes.get_last_error()
        if error == 1168:
            return False
        raise CredentialError(f"Windows Credential Manager error {error}")
    try:
        credential = pointer.contents
        return (
            credential.UserName == KEYRING_ACCOUNT
            and 0 < int(credential.CredentialBlobSize) <= 1024
            and int(credential.CredentialBlobSize) % 2 == 0
        )
    finally:
        if pointer:
            credential = pointer.contents
            if credential.CredentialBlob and credential.CredentialBlobSize:
                ctypes.memset(credential.CredentialBlob, 0, credential.CredentialBlobSize)
            _cred_free(pointer)


def find_codex_executable() -> Path | None:
    direct = shutil.which("codex")
    if direct:
        return Path(direct).resolve()
    if sys.platform != "win32":
        return None
    profile = os.environ.get("USERPROFILE")
    if not profile:
        return None
    candidates: list[Path] = []
    for relative_root in (".vscode/extensions", ".vscode-insiders/extensions"):
        extension_root = Path(profile, relative_root)
        if not extension_root.is_dir():
            continue
        for extension in extension_root.glob("openai.chatgpt-*-win32-x64"):
            candidate = extension / "bin" / "windows-x86_64" / "codex.exe"
            if candidate.is_file():
                candidates.append(candidate)
    return max(candidates, key=lambda path: path.stat().st_mtime).resolve() if candidates else None


def codex_probe_environment() -> dict[str, str]:
    """Pass login-location and network settings, but no provider API keys."""

    allowed = {
        "APPDATA",
        "CODEX_HOME",
        "COMSPEC",
        "HOMEDRIVE",
        "HOMEPATH",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "LANG",
        "LC_ALL",
        "LOCALAPPDATA",
        "NO_PROXY",
        "PATH",
        "PATHEXT",
        "SSL_CERT_DIR",
        "SSL_CERT_FILE",
        "SystemRoot",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "WINDIR",
    }
    result = {key: value for key, value in os.environ.items() if key in allowed}
    result["NO_COLOR"] = "1"
    return result


def _probe_codex(executable: Path | None) -> dict[str, Any]:
    if executable is None:
        return {"installed": False, "compatible": False, "authenticated": False}
    creationflags = CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        version_run = subprocess.run(
            [str(executable), "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=8,
            check=False,
            creationflags=creationflags,
            env=codex_probe_environment(),
        )
        version = version_run.stdout[:4096].decode("utf-8", errors="replace").strip()[:160]
        compatible = version_run.returncode == 0 and version.startswith("codex-cli ")
        authenticated = False
        if compatible:
            login_run = subprocess.run(
                [str(executable), "login", "status"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=8,
                check=False,
                creationflags=creationflags,
                env=codex_probe_environment(),
            )
            authenticated = login_run.returncode == 0
        result: dict[str, Any] = {
            "installed": True,
            "compatible": compatible,
            "authenticated": authenticated,
        }
        if version:
            result["version"] = version
        return result
    except (OSError, subprocess.TimeoutExpired):
        return {"installed": True, "compatible": False, "authenticated": False}


def _parser_ready() -> bool:
    try:
        importlib.import_module("coc_module_parser")
        importlib.import_module("pydantic")
        importlib.import_module("pypdf")
        importlib.import_module("pypdfium2")
        importlib.import_module("docx")
    except (ImportError, OSError):
        return False
    return True


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def validate_request(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("request must be a JSON object")
    action = raw.get("action")
    if action not in ALLOWED_ACTIONS:
        raise ValueError("operation is not allowlisted")
    unexpected = set(raw) - ALLOWED_REQUEST_FIELDS_BY_ACTION[action]
    if unexpected:
        raise ValueError("request contains a forbidden field")
    payload = dict(raw)
    source_path = payload.get("source_path")
    if source_path is not None:
        if not isinstance(source_path, str):
            raise ValueError("source path is invalid")
        configured_root = os.environ.get("COC_ROOM_DEV_BRIDGE_TEMP_ROOT")
        if not configured_root:
            raise ValueError("temporary source root is unavailable")
        candidate = Path(source_path).resolve(strict=True)
        root = Path(configured_root).resolve(strict=True)
        if not candidate.is_file() or not _is_within(candidate, root):
            raise ValueError("source path is outside the bridge temporary directory")
        payload["source_path"] = str(candidate)
    return payload


def process(raw: Any) -> None:
    request_id = _request_id(raw)
    try:
        payload = validate_request(raw)
    except (OSError, ValueError):
        _error(request_id, "INVALID_BRIDGE_REQUEST", "本地 AI 桥请求无效")
        return

    if payload["action"] == "bridge_status":
        try:
            key_present = has_deepseek_credential()
        except CredentialError:
            key_present = False
        _emit(
            {
                "protocol_version": PROTOCOL_VERSION,
                "request_id": request_id,
                "type": "result",
                "result": {
                    "available": True,
                    "parserReady": _parser_ready(),
                    "deepseekKeyPresent": key_present,
                    "codex": _probe_codex(find_codex_executable()),
                },
            }
        )
        return

    if not _parser_ready():
        _error(request_id, "PARSER_ENVIRONMENT_MISSING", "请先准备 Python 3.12 模组解析环境")
        return

    action = payload["action"]
    if action == "parse_module":
        cache_root = os.environ.get("COC_ROOM_DEV_BRIDGE_CACHE_DIR")
        if not cache_root:
            _error(request_id, "PARSER_CACHE_UNAVAILABLE", "模组解析缓存目录不可用")
            return
        cache_path = Path(cache_root).resolve()
        cache_path.mkdir(parents=True, exist_ok=True)
        payload["cache_dir"] = str(cache_path)

    if payload.get("provider") == "deepseek" and not payload.get("mock", False):
        try:
            api_key = read_deepseek_credential()
        except CredentialError:
            api_key = None
        if not api_key:
            _error(request_id, "DEEPSEEK_KEY_MISSING", "Windows Credential Manager 中没有 DeepSeek API Key")
            return
        payload["api_key"] = api_key

    if payload.get("provider") == "codex" and not payload.get("mock", False):
        executable = find_codex_executable()
        status = _probe_codex(executable)
        if not status["installed"]:
            _error(request_id, "CODEX_NOT_FOUND", "未找到 Codex CLI")
            return
        if not status["compatible"]:
            _error(request_id, "CODEX_INCOMPATIBLE", "Codex CLI 版本不兼容")
            return
        if not status["authenticated"]:
            _error(request_id, "CODEX_LOGIN_REQUIRED", "请先运行 codex login")
            return
        # Character and stats task schemas intentionally have no executable
        # field. Their provider classes perform the same fixed host discovery.
        # Only schemas that explicitly accept this host-only field receive it.
        if action in {"parse_module", "generate_npc_reply"}:
            payload["codex_executable"] = str(executable)

    try:
        from coc_module_parser.cli import process_request

        process_request(payload, _emit)
    except Exception as exc:  # The boundary must not reveal prompts, paths, or keys.
        sys.stderr.write(f"development bridge internal error: {type(exc).__name__}\n")
        _error(request_id, "BRIDGE_INTERNAL_ERROR", "本地 AI 桥执行失败")
    finally:
        payload.pop("api_key", None)


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="strict")
    line = sys.stdin.readline()
    if not line.strip():
        _error("unknown", "EMPTY_INPUT", "expected one JSON request line")
        return 2
    try:
        raw = json.loads(line)
    except json.JSONDecodeError:
        _error("unknown", "INVALID_JSON", "input line is not valid JSON")
        return 2
    process(raw)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
