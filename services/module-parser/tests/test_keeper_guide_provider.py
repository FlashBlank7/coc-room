import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from coc_module_parser.keeper_guide_provider import (
    KEEPER_GUIDE_INSTRUCTIONS,
    GenerateKeeperGuideTaskV1,
    KeeperGuideOutputV1,
    keeper_guide_output_schema,
    _parse_keeper_guide_output,
    _contract_for_input,
    keeper_workflow_contracts,
    KeeperEvidence,
    KeeperPlan,
    KeeperReview,
    KeeperRepairPatch,
    DeepSeekKeeperGuideProvider,
    CodexKeeperGuideProvider,
)
from coc_module_parser.client import InvalidStructureError
from pydantic import SecretStr
import httpx
from subprocess import CompletedProcess


def test_browser_and_native_use_the_same_guide_contract():
    root = Path(__file__).resolve().parents[3]
    contract = json.loads((root / "apps/desktop/src/ai/keeper-guide-contract.json").read_text(encoding="utf-8"))
    assert contract == {"instructions": KEEPER_GUIDE_INSTRUCTIONS, "schema": keeper_guide_output_schema()}


def test_summary_alone_is_not_a_first_time_keeper_preparation():
    with pytest.raises(ValidationError):
        KeeperGuideOutputV1.model_validate({"truth": "An antagonist hides a secret."})


def test_generate_one_preparation_while_accepting_existing_legacy_envelopes():
    note = {"title": "Cause", "text": "The ritual trapped the orchestra.", "kind": "advice", "sources": []}
    preparation = {"truth": note, "hook": note, "essentials": [note], "playerBriefing": note,
                   "timeline": [note], "endings": [note], "cast": [], "scenes": [], "publicClues": []}
    assert set(keeper_guide_output_schema()["properties"]) == {"preparation"}
    compact = _parse_keeper_guide_output(json.dumps({"preparation": preparation}), "test")
    assert compact.preparation.endings[0].text == note["text"]
    old = _parse_keeper_guide_output(json.dumps({"truth": "Old summary", "pacing": "Old pacing advice", "preparation": preparation}), "test")
    assert old.truth == "Old summary"
    assert old.preparation == compact.preparation


def test_guide_task_accepts_evidence_but_not_files_or_arbitrary_commands():
    task = {"provider": "codex", "digest": json.dumps({"sources": [{"sourceId": "source-original", "text": "Original."}]})}
    assert GenerateKeeperGuideTaskV1.model_validate(task).provider == "codex"
    for field in ("source_path", "command", "tools", "base_url"):
        with pytest.raises(ValidationError):
            GenerateKeeperGuideTaskV1.model_validate({**task, field: "not-allowed"})


def test_all_workflow_steps_share_fixed_browser_and_native_contracts():
    root = Path(__file__).resolve().parents[3]
    contract = json.loads((root / "apps/desktop/src/ai/keeper-workflow-contracts.json").read_text(encoding="utf-8"))
    assert contract == keeper_workflow_contracts()
    for stage, model in (("extract", KeeperEvidence), ("plan", KeeperPlan), ("review", KeeperReview), ("patch", KeeperRepairPatch)):
        instructions, schema, output_model = _contract_for_input(json.dumps({"workflowStage": stage}))
        assert output_model is model
        assert instructions != KEEPER_GUIDE_INSTRUCTIONS
        assert schema["additionalProperties"] is False
    for stage in ("shell", ["extract"], {"instructions": "override"}):
        with pytest.raises(InvalidStructureError):
            _contract_for_input(json.dumps({"workflowStage": stage}))


def test_local_repair_contract_cannot_return_a_rewritten_book_or_arbitrary_operations():
    patch = KeeperRepairPatch.model_validate({"edits": [{"op": "replace", "path": "/scenes/0/openingDraft", "value": "先询问守门人。"}]})
    assert patch.edits[0].value == "先询问守门人。"
    for value in ({"preparation": {}}, {"edits": []}, {"edits": [{"op": "execute", "path": "/", "value": "command"}]}):
        with pytest.raises(ValidationError):
            KeeperRepairPatch.model_validate(value)


def test_deepseek_review_uses_review_schema_and_returns_a_typed_report():
    output = {"checks": [], "findings": []}
    def handle(request):
        payload = json.loads(request.content)
        assert set(payload["text"]["format"]["schema"]["properties"]) == set(output)
        assert payload["tools"] == []
        assert payload["instructions"] == keeper_workflow_contracts()["review"]["instructions"]
        return httpx.Response(200, json={"output_text": json.dumps(output)})
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = DeepSeekKeeperGuideProvider(api_key=SecretStr("test-only"), client=client).generate(json.dumps({"workflowStage": "review"}))
    assert isinstance(result, KeeperReview)


def test_codex_plan_uses_the_plan_schema_in_an_independent_call(monkeypatch):
    def runner(command, **kwargs):
        if "exec" in command:
            schema_path = Path(command[command.index("--output-schema") + 1])
            assert set(json.loads(schema_path.read_text(encoding="utf-8"))["properties"]) == {"scenes"}
            assert any(value.startswith("developer_instructions=") and "workflowEvidence" in value for value in command)
            result_path = Path(command[command.index("--output-last-message") + 1])
            result_path.write_text('{"scenes":[]}', encoding="utf-8")
        return CompletedProcess(command, 0)
    provider = CodexKeeperGuideProvider(runner=runner)
    monkeypatch.setattr(provider, "_resolve_executable", lambda: "codex")
    assert isinstance(provider.generate_guide(json.dumps({"workflowStage": "plan"})), KeeperPlan)
