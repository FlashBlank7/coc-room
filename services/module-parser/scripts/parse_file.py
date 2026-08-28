from __future__ import annotations

import argparse
import getpass
import json
from pathlib import Path

from coc_module_parser.canonical import to_canonical_package
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
    parser.add_argument("--max-retries", type=int, default=1)
    parser.add_argument("--cache-dir", type=Path)
    return parser


def main() -> int:
    args = build_parser().parse_args()
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
        del details
        print(f"[{progress:>6.1%}] {stage}: {message}", flush=True)

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
        cache_dir=args.cache_dir,
    )
    result = ModuleParser().parse(config, reporter=report)
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
        f"issues={len(result.issues)}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
