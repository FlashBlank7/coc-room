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
    parser.add_argument("output", type=Path)
    parser.add_argument("--provider", choices=("codex", "deepseek"), default="codex")
    parser.add_argument("--model", default="")
    parser.add_argument("--codex-executable", type=Path)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--max-retries", type=int, default=3)
    parser.add_argument("--max-chunk-chars", type=int, default=30_000)
    parser.add_argument("--chunk-overlap-chars", type=int, default=500)
    parser.add_argument("--codex-timeout-seconds", type=float, default=3_600.0)
    parser.add_argument("--codex-heartbeat-seconds", type=float, default=15.0)
    parser.add_argument("--cache-dir", type=Path)
    return parser


def main() -> int:
    argument_parser = build_parser()
    args = argument_parser.parse_args()
    loaded = load_source_path(args.source)
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
        codex_timeout_seconds=args.codex_timeout_seconds,
        codex_heartbeat_seconds=args.codex_heartbeat_seconds,
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

    normalized = normalize_text(config.source_text)
    module = to_canonical_package(
        result.module,
        normalized_text=normalized,
        source_media_type=config.source_media_type,
        generated_at=config.generated_at,
    )

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
