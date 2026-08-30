from __future__ import annotations

import argparse
import getpass
import json
import sys
from pathlib import Path

from coc_module_parser.canonical import to_canonical_package
from coc_module_parser.client import ExtractionError
from coc_module_parser.inputs import load_source_path
from coc_module_parser.models import ParseConfig
from coc_module_parser.text import normalize_text
from coc_module_parser.workflow import ModuleParser


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Parse one local module file into an importable .cocmod.json draft."
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--provider", choices=("codex", "deepseek"), default="codex")
    parser.add_argument("--model", default="")
    parser.add_argument("--codex-executable", type=Path)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--max-retries", type=int, default=1)
    parser.add_argument("--max-chunk-chars", type=int, default=12_000)
    parser.add_argument("--chunk-overlap-chars", type=int, default=500)
    parser.add_argument("--max-codex-attempts", type=int, default=96)
    parser.add_argument("--codex-timeout-seconds", type=float, default=900.0)
    parser.add_argument("--codex-heartbeat-seconds", type=float, default=15.0)
    parser.add_argument(
        "--codex-timeout-fallback-chunk-chars", type=int, default=6_000
    )
    parser.add_argument(
        "--codex-timeout-fallback-overlap-chars", type=int, default=250
    )
    parser.add_argument(
        "--no-codex-auto-shrink",
        action="store_false",
        dest="codex_auto_shrink_on_timeout",
    )
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument(
        "--probe-first-chunk",
        action="store_true",
        help=(
            "Run only the first production-sized chunk through both Codex stages, "
            "populate the normal cache, and do not write an output module."
        ),
    )
    return parser


def main() -> int:
    argument_parser = build_parser()
    args = argument_parser.parse_args()
    if args.output is None and not args.probe_first_chunk:
        argument_parser.error("output is required unless --probe-first-chunk is used")
    if args.probe_first_chunk and args.provider != "codex":
        argument_parser.error("--probe-first-chunk requires --provider codex")
    loaded = load_source_path(args.source)
    if loaded.is_pdf and args.provider != "codex":
        raise SystemExit("PDF sources require --provider codex.")
    api_key = (
        getpass.getpass("DeepSeek API key: ")
        if not args.mock and args.provider == "deepseek"
        else None
    )
    if not args.mock and args.provider == "deepseek" and not api_key:
        raise SystemExit("A non-empty API key is required.")
    model = args.model or ("deepseek-v4-flash" if args.provider == "deepseek" else "")

    def report(stage: str, progress: float, message: str, details: object) -> None:
        suffix = ""
        if isinstance(details, dict) and details.get("event") == "codex_waiting":
            elapsed = details.get("elapsed_seconds")
            timeout = details.get("timeout_seconds")
            cli_phase = details.get("cli_phase", "unknown")
            suffix = f" ({elapsed}s / {timeout}s; CLI: {cli_phase})"
        print(f"[{progress:>6.1%}] {stage}: {message}{suffix}", flush=True)

    config = ParseConfig(
        source_text=loaded.text,
        source_name=loaded.name,
        source_sha256=loaded.sha256,
        source_media_type=loaded.media_type,
        provider=args.provider,
        model=model,
        mock=args.mock,
        api_key=api_key,
        codex_executable=args.codex_executable,
        max_retries=args.max_retries,
        max_chunk_chars=args.max_chunk_chars,
        chunk_overlap_chars=args.chunk_overlap_chars,
        max_codex_attempts=args.max_codex_attempts,
        codex_timeout_seconds=args.codex_timeout_seconds,
        codex_heartbeat_seconds=args.codex_heartbeat_seconds,
        codex_auto_shrink_on_timeout=args.codex_auto_shrink_on_timeout,
        codex_timeout_fallback_chunk_chars=(
            args.codex_timeout_fallback_chunk_chars
        ),
        codex_timeout_fallback_overlap_chars=(
            args.codex_timeout_fallback_overlap_chars
        ),
        codex_probe_first_chunk=args.probe_first_chunk,
        cache_dir=args.cache_dir,
    )
    try:
        result = ModuleParser().parse(config, reporter=report)
    except ExtractionError as exc:
        print(
            f"Module parse stopped safely ({exc.code}). "
            "No module file was written; the source and validated cache entries are unchanged.",
            file=sys.stderr,
            flush=True,
        )
        return 2
    if (
        not config.mock
        and result.validated_fragment_count == 0
        and any(issue.severity.value == "error" for issue in result.issues)
    ):
        print(
            "No validated module fragment was produced; refusing to write the output file.",
            file=sys.stderr,
            flush=True,
        )
        return 2
    if args.probe_first_chunk:
        print(
            "Validated and cached the first production chunk's World and Evidence stages; "
            "no output module was written.",
            flush=True,
        )
        return 0

    normalized = normalize_text(config.source_text)
    module = to_canonical_package(
        result.module,
        normalized_text=normalized,
        source_media_type=config.source_media_type,
        generated_at=config.generated_at,
    )

    assert args.output is not None
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            module.model_dump(mode="json", exclude_none=True),
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(
        "Saved review draft: "
        f"status={result.status}, calls={result.extraction_attempts}, "
        f"scenes={len(result.module.scenes)}, locations={len(result.module.locations)}, "
        f"npcs={len(result.module.npcs)}, clues={len(result.module.clues)}, "
        f"issues={len(result.issues)}, "
        f"input_tokens={result.provider_usage.input_tokens}, "
        f"output_tokens={result.provider_usage.output_tokens}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
