"""Exercise the production semantic reviewer against valid-shaped, wrong content."""
import argparse
import copy
import json
import time
from pathlib import Path
from coc_module_parser.keeper_guide_provider import CodexKeeperGuideProvider, KeeperPreparation

parser = argparse.ArgumentParser()
parser.add_argument("input", type=Path)
parser.add_argument("checkpoint", type=Path)
parser.add_argument("reference", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("mutation", choices=["public", "rules"])
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
digest = json.loads(args.input.read_text(encoding="utf-8"))
checkpoint = json.loads(args.checkpoint.read_text(encoding="utf-8"))
reference = json.loads(args.reference.read_text(encoding="utf-8"))
preparation = copy.deepcopy(reference["keeperGuide"]["preparation"])
preparation["scenes"] = preparation["scenes"][:1]
opening = preparation["scenes"][0]
expected = []
if args.mutation == "public":
    for entity in opening["publicEntities"]:
        if entity["name"] == "扬屋":
            entity["text"] = "你们初次前来会面，屋里已经有挣扎痕迹，首饰散落，彼岸花打翻，纸张被水洇湿。"
            expected.append("初见公开了失踪后现场，必须指出时间与公开稿冲突")
        if entity["name"] == "映夜太夫":
            entity["name"] = "安昙萤（映夜太夫）"
            expected.append("卡片标题泄露玩家此刻不知道的本名")
        if "橘家" in entity["name"]:
            entity["text"] = "橘弥生正坐在映夜身边，向你们点头致意。"
            expected.append("把仅被提到的橘家客人写成现场在场")
else:
    opening["exits"][0]["text"] = "玩家坚持先去柳屋时照常带即可；他们自动得到巴斯特祝福，并能进入金鱼旁的猫咪幻境，先后顺序不影响这些内容。"
    expected.append("先去柳屋获得祝福与幻境违反跨场景前提")
    clue = preparation["publicClues"][0]
    clue["when"]["text"] = "玩家只要询问侍女，无须知识检定即可公开这一整段，即使知识失败也一样。"
    expected.append("把知识成功才能辨认的柿子产地合并进直接询问的免费信息")
# Verify that these bad samples retain the production output shape.
KeeperPreparation.model_validate(preparation)
request = {**digest, "workflowStage": "review", "reviewScope": "opening",
    "workflowEvidence": checkpoint["keeperGuide"]["workflow"]["evidence"],
    "candidate": {"preparation": preparation}}
(args.output / "input.json").write_text(json.dumps(request, ensure_ascii=False, indent=2), encoding="utf-8")
(args.output / "expected.json").write_text(json.dumps(expected, ensure_ascii=False, indent=2), encoding="utf-8")
started = time.time()
result = CodexKeeperGuideProvider().generate_guide(json.dumps(request, ensure_ascii=False))
(args.output / "review.json").write_text(result.model_dump_json(indent=2), encoding="utf-8")
(args.output / "metrics.json").write_text(json.dumps({"seconds": time.time() - started,
    "expectedDefects": len(expected), "findings": len(result.findings)}), encoding="utf-8")
print(f"Review completed in {time.time()-started:.0f}s; assess actual findings against expected.json", flush=True)
