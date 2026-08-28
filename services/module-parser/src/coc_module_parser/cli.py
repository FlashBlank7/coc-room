from __future__ import annotations

import argparse
import json
import sys
import uuid
from collections.abc import Callable
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, TextIO

from pydantic import ValidationError

from . import __version__
from .canonical import CanonicalModulePackageV1, to_canonical_package
from .client import ProviderResponseError
from .inputs import InputError, load_source_path, load_source_text
from .models import (
    ParseConfig,
    migrate_module_package,
)
from .text import normalize_text
from .workflow import ModuleParser


PROTOCOL_VERSION = "1.0"
Emit = Callable[[dict[str, Any]], None]


def _request_id(raw: Any) -> str:
    if isinstance(raw, dict):
        value = raw.get("request_id") or raw.get("id")
        if isinstance(value, (str, int)) and str(value):
            return str(value)[:200]
    return f"request-{uuid.uuid4()}"


def _payload(raw: dict[str, Any]) -> dict[str, Any]:
    nested = raw.get("payload")
    if isinstance(nested, dict):
        return {**raw, **nested}
    return raw


def _error(
    request_id: str,
    code: str,
    message: str,
    *,
    retryable: bool = False,
    details: Any = None,
) -> dict[str, Any]:
    error: dict[str, Any] = {
        "code": code,
        "message": message,
        "retryable": retryable,
    }
    if details is not None:
        error["details"] = details
    return {
        "protocol_version": PROTOCOL_VERSION,
        "request_id": request_id,
        "type": "error",
        "message": message,
        "error": error,
    }


def _validation_details(exc: ValidationError) -> list[dict[str, Any]]:
    return [
        {
            "location": [str(part) for part in item["loc"]],
            "type": item["type"],
            "message": item["msg"],
        }
        for item in exc.errors(include_input=False)[:20]
    ]


def _parse_config(payload: dict[str, Any]) -> ParseConfig:
    has_text = isinstance(payload.get("source_text"), str)
    has_path = isinstance(payload.get("source_path"), str)
    if has_text == has_path:
        raise InputError(
            "provide exactly one of source_text or source_path", code="INVALID_SOURCE"
        )
    if has_path:
        loaded = load_source_path(payload["source_path"])
    else:
        loaded = load_source_text(
            payload["source_text"], payload.get("source_name", "pasted-text.md")
        )
    allowed = {
        "api_key",
        "provider",
        "model",
        "mock",
        "base_url",
        "codex_executable",
        "max_chunk_chars",
        "chunk_overlap_chars",
        "max_retries",
        "max_output_tokens",
        "max_codex_chunks",
        "max_codex_attempts",
        "cache_dir",
        "generated_at",
    }
    config_payload = {key: payload[key] for key in allowed if key in payload}
    config_payload.update(
        {
            "source_text": loaded.text,
            "source_name": loaded.name,
            "source_sha256": loaded.sha256,
            "source_media_type": loaded.media_type,
        }
    )
    return ParseConfig.model_validate(config_payload)


def process_request(raw: Any, emit: Emit) -> None:
    request_id = _request_id(raw)
    if not isinstance(raw, dict):
        emit(_error(request_id, "INVALID_REQUEST", "request must be a JSON object"))
        return
    payload = _payload(raw)
    operation = str(
        raw.get("action") or raw.get("operation") or raw.get("type") or "parse_module"
    )
    if operation in {"parse", "parse_module"}:
        try:
            config = _parse_config(payload)

            def report(
                stage: str,
                progress: float,
                message: str,
                details: dict[str, Any] | None,
            ) -> None:
                event: dict[str, Any] = {
                    "protocol_version": PROTOCOL_VERSION,
                    "request_id": request_id,
                    "type": "progress",
                    "stage": stage,
                    "progress": round(progress, 4),
                    "message": message,
                }
                if details:
                    event["details"] = details
                emit(event)

            result = ModuleParser().parse(config, reporter=report)
            normalized = normalize_text(config.source_text)
            canonical = to_canonical_package(
                result.module,
                normalized_text=normalized,
                source_media_type=config.source_media_type,
                generated_at=config.generated_at,
            )
            emit(
                {
                    "protocol_version": PROTOCOL_VERSION,
                    "request_id": request_id,
                    "type": "result",
                    "module": canonical.model_dump(mode="json", exclude_none=True),
                    "normalizedText": normalized,
                    "warnings": [issue.message for issue in result.issues],
                    "issues": [
                        issue.model_dump(mode="json", exclude_none=True)
                        for issue in result.issues
                    ],
                    "parseStatus": result.status,
                    "usage": {"calls": result.extraction_attempts},
                }
            )
        except InputError as exc:
            emit(_error(request_id, exc.code, str(exc)))
        except ProviderResponseError as exc:
            emit(
                _error(
                    request_id,
                    exc.code,
                    str(exc),
                    retryable=exc.retryable,
                )
            )
        except ValidationError as exc:
            emit(
                _error(
                    request_id,
                    "INVALID_REQUEST",
                    "request validation failed",
                    details=_validation_details(exc),
                )
            )
        except Exception as exc:  # Protocol boundary: never leak request data or credentials.
            sys.stderr.write(f"module-parser internal error: {type(exc).__name__}\n")
            emit(_error(request_id, "INTERNAL_ERROR", "module parsing failed"))
        return

    if operation in {"validate_module", "migrate_module", "apply_corrections"}:
        try:
            module_payload = payload.get("module")
            if not isinstance(module_payload, dict):
                raise InputError("module must be a JSON object", code="INVALID_MODULE")
            if "schemaVersion" in module_payload:
                module = CanonicalModulePackageV1.model_validate(module_payload)
            else:
                internal = migrate_module_package(module_payload)
                module = to_canonical_package(
                    internal,
                    normalized_text="",
                    source_media_type="text/markdown",
                    generated_at=datetime.now(timezone.utc),
                )
            if operation == "apply_corrections":
                corrections = payload.get("corrections")
                if not isinstance(corrections, dict):
                    raise InputError(
                        "corrections must be a JSON object", code="INVALID_CORRECTIONS"
                    )

                def merge(base: Any, updates: Any) -> Any:
                    if isinstance(base, dict) and isinstance(updates, dict):
                        merged = deepcopy(base)
                        for key, value in updates.items():
                            merged[key] = merge(merged.get(key), value)
                        return merged
                    return deepcopy(updates)

                module = CanonicalModulePackageV1.model_validate(
                    merge(module.model_dump(mode="python", exclude_none=True), corrections)
                )
            emit(
                {
                    "protocol_version": PROTOCOL_VERSION,
                    "request_id": request_id,
                    "type": "result",
                    "module": module.model_dump(mode="json", exclude_none=True),
                }
            )
        except InputError as exc:
            emit(_error(request_id, exc.code, str(exc)))
        except (ValidationError, ValueError) as exc:
            details = _validation_details(exc) if isinstance(exc, ValidationError) else None
            emit(
                _error(
                    request_id,
                    "INVALID_MODULE",
                    "module validation failed",
                    details=details,
                )
            )
        return

    if operation == "ping":
        emit(
            {
                "protocol_version": PROTOCOL_VERSION,
                "request_id": request_id,
                "type": "result",
                "result": {"status": "ok", "version": __version__},
            }
        )
        return
    emit(_error(request_id, "UNKNOWN_OPERATION", f"unsupported operation: {operation}"))


def _json_emitter(stream: TextIO) -> Emit:
    def emit(event: dict[str, Any]) -> None:
        stream.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        stream.flush()

    return emit


def run_stream(input_stream: TextIO, output_stream: TextIO, *, loop: bool = False) -> int:
    emit = _json_emitter(output_stream)
    processed = False
    for line in input_stream:
        if not line.strip():
            continue
        processed = True
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            emit(_error("unknown", "INVALID_JSON", "input line is not valid JSON"))
        else:
            process_request(raw, emit)
        if not loop:
            break
    if not processed:
        emit(_error("unknown", "EMPTY_INPUT", "expected one JSON request line"))
        return 2
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="CoC module parser JSONL sidecar")
    parser.add_argument(
        "--loop",
        action="store_true",
        help="process JSON lines until EOF (the default processes one request and exits)",
    )
    parser.add_argument("--version", action="version", version=__version__)
    return parser


def configure_standard_streams() -> None:
    """The Tauri boundary is UTF-8 regardless of the Windows active code page."""

    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="strict")
        except (OSError, ValueError):
            pass


def main(argv: list[str] | None = None) -> int:
    configure_standard_streams()
    args = build_parser().parse_args(argv)
    return run_stream(sys.stdin, sys.stdout, loop=args.loop)
