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
from .character_provider import GenerateCharacterDraftTaskV1, generate_character_draft
from .client import CodexCliExtractor, ExtractionError, ProviderResponseError
from .inputs import (
    LoadedSource,
    InputError,
    inject_pdf_visual_transcripts,
    load_source_path,
    load_source_text,
    render_pdf_path_selection,
)
from .models import (
    IssueSeverity,
    ParseConfig,
    migrate_module_package,
)
from .npc_context import (
    PrepareNpcReplyTaskV1,
    build_npc_context,
    npc_reply_output_schema,
)
from .npc_provider import GenerateNpcReplyTaskV1, generate_npc_reply
from .npc_stats_provider import GenerateNpcStatsDraftTaskV1, generate_npc_stats_draft
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


def _parse_config(payload: dict[str, Any]) -> tuple[ParseConfig, LoadedSource]:
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
    provider = payload.get("provider", "deepseek")
    if loaded.is_pdf and provider != "codex":
        raise InputError(
            "PDF sources require the Codex provider",
            code="PDF_CODEX_REQUIRED",
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
        "codex_timeout_seconds",
        "codex_heartbeat_seconds",
        "codex_auto_shrink_on_timeout",
        "codex_timeout_fallback_chunk_chars",
        "codex_timeout_fallback_overlap_chars",
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
    return ParseConfig.model_validate(config_payload), loaded


def _pdf_visual_page_numbers(
    payload: dict[str, Any], config: ParseConfig, loaded: LoadedSource
) -> tuple[int, ...]:
    raw = payload.get("pdf_visual_page_numbers")
    if raw is None:
        if loaded.is_pdf and config.provider == "codex" and not config.mock:
            return tuple(
                page.page_number for page in loaded.pdf_pages if page.needs_vision
            )[:4]
        return ()
    if not loaded.is_pdf:
        raise InputError(
            "PDF visual pages require a PDF source", code="PDF_PAGE_SELECTION"
        )
    if config.provider != "codex" or config.mock:
        raise InputError(
            "PDF visual pages require a live Codex provider",
            code="PDF_VISUAL_CODEX_REQUIRED",
        )
    if (
        not isinstance(raw, list)
        or not raw
        or len(raw) > 4
        or any(isinstance(page, bool) or not isinstance(page, int) for page in raw)
        or len(set(raw)) != len(raw)
        or any(page < 1 or page > len(loaded.pdf_pages) for page in raw)
    ):
        raise InputError(
            "select between one and four unique PDF pages",
            code="PDF_PAGE_SELECTION",
        )
    return tuple(raw)


def process_request(raw: Any, emit: Emit) -> None:
    request_id = _request_id(raw)
    if not isinstance(raw, dict):
        emit(_error(request_id, "INVALID_REQUEST", "request must be a JSON object"))
        return
    payload = _payload(raw)
    operation = str(
        raw.get("action") or raw.get("operation") or raw.get("type") or "parse_module"
    )
    if operation in {"render_pdf_pages", "inspect_pdf_pages"}:
        try:
            source_path = payload.get("source_path")
            page_numbers = payload.get("page_numbers")
            if not isinstance(source_path, str) or not isinstance(page_numbers, list):
                raise InputError(
                    "source_path and page_numbers are required",
                    code="PDF_PAGE_SELECTION",
                )
            pages = render_pdf_path_selection(source_path, page_numbers)
            emit(
                {
                    "protocol_version": PROTOCOL_VERSION,
                    "request_id": request_id,
                    "type": "result",
                    "pages": list(pages),
                }
            )
        except InputError as exc:
            emit(_error(request_id, exc.code, str(exc)))
        return

    if operation in {"parse", "parse_module"}:
        try:
            config, loaded = _parse_config(payload)

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

            visual_page_numbers = _pdf_visual_page_numbers(payload, config, loaded)
            visual_pages: tuple[dict[str, object], ...] = ()
            visual_provider_usage: dict[str, int] = {}
            parser = ModuleParser()
            if visual_page_numbers:
                source_path = payload.get("source_path")
                if not isinstance(source_path, str):
                    raise InputError(
                        "PDF visual pages require an authorized PDF path",
                        code="PDF_PAGE_SELECTION",
                    )
                report(
                    "pdf_vision",
                    0.02,
                    f"Rendering {len(visual_page_numbers)} PDF page(s) for bounded Codex vision",
                    {"page_numbers": list(visual_page_numbers)},
                )
                rendered_pages = render_pdf_path_selection(
                    source_path, list(visual_page_numbers)
                )
                extractor = CodexCliExtractor(
                    model=config.model or "codex-default",
                    executable=str(config.codex_executable or "codex"),
                    timeout_seconds=config.codex_timeout_seconds,
                    heartbeat_seconds=config.codex_heartbeat_seconds,
                    max_output_tokens=config.max_output_tokens,
                )

                transcripts = extractor.extract_pdf_visual_pages(rendered_pages)
                take_visual_usage = getattr(extractor, "take_last_usage", None)
                if callable(take_visual_usage):
                    visual_provider_usage = take_visual_usage()
                loaded = inject_pdf_visual_transcripts(loaded, transcripts)
                config = config.model_copy(update={"source_text": loaded.text})
                rendered_by_page = {
                    page["pageNumber"]: page for page in rendered_pages
                }
                visual_pages = tuple(
                    {
                        **transcript,
                        "sha256": rendered_by_page[transcript["pageNumber"]]["sha256"],
                        "byteLength": rendered_by_page[transcript["pageNumber"]][
                            "byteLength"
                        ],
                        "width": rendered_by_page[transcript["pageNumber"]]["width"],
                        "height": rendered_by_page[transcript["pageNumber"]]["height"],
                    }
                    for transcript in transcripts
                )
                parser = ModuleParser(extractor=extractor)
                report(
                    "pdf_vision",
                    0.04,
                    "PDF visual transcript is ready for structured extraction",
                    {"page_numbers": list(visual_page_numbers)},
                )

            result = parser.parse(config, reporter=report)
            if not config.mock and result.validated_fragment_count == 0:
                blocking_issue = next(
                    (
                        issue
                        for issue in result.issues
                        if issue.severity == IssueSeverity.ERROR
                    ),
                    None,
                )
                if blocking_issue is not None:
                    raise ProviderResponseError(
                        "没有生成可导入的有效模组内容；请检查解析服务后重试。",
                        retryable=blocking_issue.retryable,
                        code=blocking_issue.code,
                    )
            normalized = normalize_text(config.source_text)
            canonical = to_canonical_package(
                result.module,
                normalized_text=normalized,
                source_media_type=config.source_media_type,
                generated_at=config.generated_at,
            )
            provider_usage = result.provider_usage.model_dump()
            for key, value in visual_provider_usage.items():
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    provider_usage[key] = provider_usage.get(key, 0) + value
            usage = {"calls": result.extraction_attempts + (1 if visual_pages else 0)}
            usage_names = {
                "completed_turns": "completedTurns",
                "input_tokens": "inputTokens",
                "cached_input_tokens": "cachedInputTokens",
                "cache_write_input_tokens": "cacheWriteInputTokens",
                "output_tokens": "outputTokens",
                "reasoning_output_tokens": "reasoningOutputTokens",
            }
            usage.update(
                {
                    wire_name: provider_usage.get(field_name, 0)
                    for field_name, wire_name in usage_names.items()
                    if provider_usage.get(field_name, 0) > 0
                }
            )
            event: dict[str, Any] = {
                "protocol_version": PROTOCOL_VERSION,
                "request_id": request_id,
                "type": "result",
                "module": canonical.model_dump(mode="json", exclude_none=True),
                "normalizedText": normalized,
                "warnings": [
                    *loaded.warnings,
                    *(issue.message for issue in result.issues),
                ],
                "issues": [
                    issue.model_dump(mode="json", exclude_none=True)
                    for issue in result.issues
                ],
                "parseStatus": result.status,
                "usage": usage,
            }
            if loaded.attachments:
                event["sourceAttachments"] = [
                    attachment.to_wire() for attachment in loaded.attachments
                ]
            if loaded.is_pdf:
                event["sourceInputMediaType"] = loaded.input_media_type
                event["sourcePages"] = [page.to_wire() for page in loaded.pdf_pages]
                if visual_pages:
                    event["visualPages"] = list(visual_pages)
            emit(event)
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

    if operation in {"prepare_npc_reply", "npc_reply_context"}:
        try:
            transport_fields = {
                "id",
                "request_id",
                "type",
                "action",
                "operation",
                "payload",
            }
            task_payload = {
                key: value for key, value in payload.items() if key not in transport_fields
            }
            task = PrepareNpcReplyTaskV1.model_validate(task_payload)
            context = build_npc_context(task)
            result: dict[str, Any] = {
                "status": "mocked" if task.mock_response is not None else "prepared",
                "provider": task.provider,
                "model": task.model,
                "context": context.model_dump(mode="json", by_alias=True),
                "outputSchema": npc_reply_output_schema(),
            }
            if task.mock_response is not None:
                result["reply"] = task.mock_response.model_dump(
                    mode="json", by_alias=True, exclude_none=True
                )
            emit(
                {
                    "protocol_version": PROTOCOL_VERSION,
                    "request_id": request_id,
                    "type": "result",
                    "result": result,
                }
            )
        except ValidationError as exc:
            emit(
                _error(
                    request_id,
                    "INVALID_NPC_TASK",
                    "NPC reply task validation failed",
                    details=_validation_details(exc),
                )
            )
        return

    if operation in {"generate_npc_reply", "run_npc_reply"}:
        try:
            transport_fields = {
                "id",
                "request_id",
                "type",
                "action",
                "operation",
                "payload",
            }
            task_payload = {
                key: value for key, value in payload.items() if key not in transport_fields
            }
            task = GenerateNpcReplyTaskV1.model_validate(task_payload)
            generated = generate_npc_reply(task)
            emit(
                {
                    "protocol_version": PROTOCOL_VERSION,
                    "request_id": request_id,
                    "type": "result",
                    "result": {
                        "status": "completed",
                        "provider": generated.provider,
                        "model": generated.model,
                        "contextSelection": generated.selection.model_dump(
                            mode="json", by_alias=True
                        ),
                        "reply": generated.reply.model_dump(
                            mode="json", by_alias=True, exclude_none=True
                        ),
                    },
                }
            )
        except ValidationError as exc:
            emit(
                _error(
                    request_id,
                    "INVALID_NPC_TASK",
                    "NPC reply task validation failed",
                    details=_validation_details(exc),
                )
            )
        except ExtractionError as exc:
            emit(
                _error(
                    request_id,
                    exc.code,
                    str(exc),
                    retryable=exc.retryable,
                )
            )
        except Exception as exc:  # Never expose prompts, replies, or credentials.
            sys.stderr.write(f"module-parser NPC reply internal error: {type(exc).__name__}\n")
            emit(_error(request_id, "INTERNAL_ERROR", "NPC reply generation failed"))
        return

    if operation in {"generate_character_draft", "character_draft"}:
        try:
            transport_fields = {
                "id",
                "request_id",
                "type",
                "action",
                "operation",
                "payload",
            }
            task_payload = {
                key: value for key, value in payload.items() if key not in transport_fields
            }
            task = GenerateCharacterDraftTaskV1.model_validate(task_payload)
            generated = generate_character_draft(task)
            emit(
                {
                    "protocol_version": PROTOCOL_VERSION,
                    "request_id": request_id,
                    "type": "result",
                    "result": {
                        "status": "draft",
                        "provider": generated.provider,
                        "model": generated.model,
                        "character": generated.character.model_dump(
                            mode="json", by_alias=True, exclude_none=True
                        ),
                    },
                }
            )
        except ValidationError as exc:
            emit(
                _error(
                    request_id,
                    "INVALID_CHARACTER_TASK",
                    "character draft task validation failed",
                    details=_validation_details(exc),
                )
            )
        except ExtractionError as exc:
            emit(
                _error(
                    request_id,
                    exc.code,
                    str(exc),
                    retryable=exc.retryable,
                )
            )
        except Exception as exc:  # Never expose prompts, drafts, or credentials.
            sys.stderr.write(
                f"module-parser character draft internal error: {type(exc).__name__}\n"
            )
            emit(_error(request_id, "INTERNAL_ERROR", "character draft generation failed"))
        return

    if operation in {"generate_npc_stats_draft", "npc_stats_draft"}:
        try:
            transport_fields = {
                "id",
                "request_id",
                "type",
                "action",
                "operation",
                "payload",
            }
            task_payload = {
                key: value for key, value in payload.items() if key not in transport_fields
            }
            task = GenerateNpcStatsDraftTaskV1.model_validate(task_payload)
            generated = generate_npc_stats_draft(task)
            emit(
                {
                    "protocol_version": PROTOCOL_VERSION,
                    "request_id": request_id,
                    "type": "result",
                    "result": {
                        "status": "draft",
                        "provider": generated.provider,
                        "model": generated.model,
                        "npcId": generated.npc_id,
                        "character": generated.character.model_dump(
                            mode="json", by_alias=True, exclude_none=True
                        ),
                    },
                }
            )
        except ValidationError as exc:
            emit(
                _error(
                    request_id,
                    "INVALID_NPC_STATS_TASK",
                    "NPC stats draft task validation failed",
                    details=_validation_details(exc),
                )
            )
        except ExtractionError as exc:
            emit(
                _error(
                    request_id,
                    exc.code,
                    str(exc),
                    retryable=exc.retryable,
                )
            )
        except Exception as exc:  # Never expose prompts, drafts, or credentials.
            sys.stderr.write(
                f"module-parser NPC stats draft internal error: {type(exc).__name__}\n"
            )
            emit(_error(request_id, "INTERNAL_ERROR", "NPC stats draft generation failed"))
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
