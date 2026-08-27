from __future__ import annotations

import argparse
import json
from pathlib import Path

from coc_module_parser.inputs import load_source_path
from coc_module_parser.source_refs import (
    audit_cocmod_source_refs,
    repair_cocmod_source_refs,
)
from coc_module_parser.text import normalize_text


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Audit every canonical sourceRefs entry in a .cocmod.json file."
    )
    parser.add_argument("module", type=Path)
    parser.add_argument("source", type=Path)
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument(
        "--fix",
        action="store_true",
        help="Relocate globally unique references and remove every unverified reference.",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    payload = json.loads(args.module.read_text(encoding="utf-8"))
    source = load_source_path(args.source)
    normalized_source = normalize_text(source.text)
    report = audit_cocmod_source_refs(payload, normalized_source)
    if args.fix:
        before = report
        repair = repair_cocmod_source_refs(payload, normalized_source)
        args.module.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        report = {
            "before": before,
            "repair": repair,
            "after": audit_cocmod_source_refs(payload, normalized_source),
        }
    if args.as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        audit = report["after"] if args.fix else report
        counts = audit["counts"]
        print(
            "sourceRefs: "
            f"total={counts['total']} valid={counts['valid']} "
            f"relocatable={counts['relocatable']} ambiguous={counts['ambiguous']} "
            f"notFound={counts['notFound']} missingExcerpt={counts['missingExcerpt']} "
            f"malformed={counts['malformed']}"
        )
        for finding in audit["findings"]:
            print(json.dumps(finding, ensure_ascii=False, separators=(",", ":")))
    audit = report["after"] if args.fix else report
    return 0 if audit["counts"]["total"] == audit["counts"]["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
