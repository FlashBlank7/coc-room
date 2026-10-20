"""Summarize all live runs, including failed acceptance attempts; no model calls."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def without_sources(value):
    if isinstance(value, list):
        return [without_sources(item) for item in value]
    if isinstance(value, dict):
        return {key: without_sources(item) for key, item in value.items() if key != "sources"}
    return value


parser = argparse.ArgumentParser()
parser.add_argument("runs", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
rows = []
for directory in sorted(args.runs.iterdir()):
    checkpoint = directory / "workflow-live-checkpoint.cocmod.json"
    if not checkpoint.exists():
        continue
    module = read(checkpoint)
    workflow = module["keeperGuide"]["workflow"]
    timings = directory / "timings.jsonl"
    calls = [json.loads(line) for line in timings.read_text(encoding="utf-8-sig").splitlines() if line.strip()] if timings.exists() else []
    findings = [item for review in workflow["reviews"] for item in review["review"]["findings"]]
    findings += workflow.get("audit", {}).get("findings", [])
    if workflow.get("pending", {}).get("review"):
        findings += workflow["pending"]["review"]["findings"]
    findings = list({json.dumps(item, sort_keys=True): item for item in findings}.values())
    acceptance = []
    for path in sorted(directory.glob("*/report.json")):
        report = read(path)
        if "passed" not in report or "grades" not in report:
            continue
        reader = read(path.parent / "reader-input.json")
        current_preparation = without_sources(module["keeperGuide"].get("preparation", {}))
        if report.get("readingScope") == "start page and opening scene" and current_preparation.get("scenes"):
            opening = current_preparation["scenes"][0]
            original_scene = next(scene for scene in module["scenes"] if scene["id"] == opening["sceneId"])
            current_preparation = {
                **{key: current_preparation[key] for key in ("truth", "hook", "essentials", "playerBriefing")},
                "scenes": [opening],
                "publicClues": [clue for clue in current_preparation.get("publicClues", []) if clue["clueId"] in original_scene["clueIds"]],
            }
        acceptance.append({
            "path": path.relative_to(args.runs).as_posix(),
            "passed": report["passed"], "total": report["total"],
            "readingScope": report.get("readingScope", "complete preparation"),
            "evaluatesCurrentPreparation": current_preparation == reader["preparation"],
            "failures": [grade for grade in report["grades"] if not grade["passed"]],
            "readerInputSha256": hashlib.sha256((path.parent / "reader-input.json").read_bytes()).hexdigest(),
        })
    rows.append({
        "run": directory.name, "stage": workflow["stage"],
        "runStatus": read(directory / "run-status.json") if (directory / "run-status.json").exists() else None,
        "sourceSceneCount": len(module["scenes"]),
        "preparedSceneCount": len(module["keeperGuide"].get("preparation", {}).get("scenes", [])),
        "hasFinalArtifact": (directory / "result.cocmod.json").exists(),
        "checkpointSha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
        "recordedCompletedCalls": len(calls),
        # Excludes failed HTTP calls and cancelled calls; never label this wall time or billing.
        "completedCallSeconds": round(sum(call["seconds"] for call in calls), 1),
        "repairCalls": sum(call["stage"] in {"repair", "patch"} for call in calls),
        "patchCalls": sum(call["stage"] == "patch" for call in calls),
        "errorCount": sum(item["severity"] == "error" for item in findings),
        "uncertainFindingCount": sum(item["severity"] == "uncertain" for item in findings),
        "uncertainFacts": sum(item["note"]["kind"] == "uncertain" for item in workflow.get("evidence", {}).get("facts", [])),
        "acceptance": acceptance,
    })
summary = {
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "method": "Live provider generation plus independent automated reading, not human playtest.",
    "note": "All retained runs included. Resumed runs can contain earlier prompts. Acceptance snapshots are independent of later checkpoint updates. Completed-call seconds exclude failed/cancelled calls and are not token usage or billing.",
    "runs": rows,
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Saved {len(rows)} runs to {args.output}")
