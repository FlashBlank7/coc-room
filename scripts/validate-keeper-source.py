"""Opt-in live source extraction for keeper quality fixtures; never uses the user library."""
import argparse
import json
import time
from pathlib import Path
from coc_module_parser.cli import process_request

parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
started = time.time()
result = None

def emit(message):
    global result
    with (args.output / "parse-events.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(message, ensure_ascii=False) + "\n")
    if message["type"] in {"result", "error"}:
        result = message
    else:
        print(message.get("stage"), message.get("message"), flush=True)

process_request({"id": "keeper-quality-extraction", "action": "parse_module",
    "source_text": args.source.read_text(encoding="utf-8"), "source_name": args.source.name,
    "provider": "codex", "model": "", "cache_dir": str(args.output / "cache")}, emit)
if not result or result["type"] != "result":
    raise RuntimeError(result)
module = result["module"]
digest = {**module, "sources": [{"sourceId": module["sourceDocuments"][0]["id"], "text": result["normalizedText"]}]}
(args.output / "input.json").write_text(json.dumps(digest, ensure_ascii=False, indent=2), encoding="utf-8")
(args.output / "parse-summary.json").write_text(json.dumps({"seconds": time.time() - started,
    "sceneCount": len(module["scenes"]), "warnings": result["warnings"], "issues": result["issues"],
    "usage": result["usage"], "status": result["parseStatus"]}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Saved {len(module['scenes'])} scenes in {time.time() - started:.0f}s", flush=True)
