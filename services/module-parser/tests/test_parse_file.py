from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

from coc_module_parser.client import ProviderResponseError
from coc_module_parser.inputs import LoadedSource
from coc_module_parser.models import (
    IssueSeverity,
    ModuleMetadataV1,
    ModulePackageV1,
    ParseIssueV1,
    ParseResultV1,
    SourceDocumentV1,
)


def _load_parse_file_module() -> ModuleType:
    script = Path(__file__).parents[1] / "scripts" / "parse_file.py"
    spec = importlib.util.spec_from_file_location("coc_room_parse_file_test", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _empty_package() -> ModulePackageV1:
    return ModulePackageV1(
        module_id="module:test",
        metadata=ModuleMetadataV1(title="Test"),
        source=SourceDocumentV1(name="test.md", sha256="a" * 64, char_count=6),
    )


def test_parse_file_refuses_to_write_when_live_codex_has_zero_validated_fragments(
    monkeypatch, tmp_path: Path
) -> None:
    module = _load_parse_file_module()
    loaded = LoadedSource(
        text="# Test",
        name="test.md",
        sha256="a" * 64,
        media_type="text/markdown",
    )
    result = ParseResultV1(
        status="needs_review",
        module=_empty_package(),
        issues=[
            ParseIssueV1(
                severity=IssueSeverity.ERROR,
                code="CODEX_TIMEOUT",
                stage="extract",
                message="Both staged calls timed out.",
            )
        ],
        extraction_attempts=2,
        validated_fragment_count=0,
    )

    class FakeParser:
        def parse(self, _config, reporter=None):
            del reporter
            return result

    output = tmp_path / "must-not-exist.cocmod.json"
    monkeypatch.setattr(module, "load_source_path", lambda _path: loaded)
    monkeypatch.setattr(module, "ModuleParser", FakeParser)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "parse_file.py",
            str(tmp_path / "input.zip"),
            str(output),
            "--provider",
            "codex",
            "--model",
            "gpt-test",
        ],
    )

    assert module.main() == 2
    assert not output.exists()


def test_parse_file_defaults_write_a_full_module_draft(
    monkeypatch, tmp_path: Path
) -> None:
    module = _load_parse_file_module()
    loaded = LoadedSource(
        text="x" * 8_000,
        name="test.md",
        sha256="b" * 64,
        media_type="text/markdown",
    )
    captured = {}
    result = ParseResultV1(
        status="ready_for_review",
        module=_empty_package(),
        extraction_attempts=2,
        validated_fragment_count=1,
    )

    class FakeParser:
        def parse(self, config, reporter=None):
            del reporter
            captured["config"] = config
            return result

    output = tmp_path / "draft.cocmod.json"
    monkeypatch.setattr(module, "load_source_path", lambda _path: loaded)
    monkeypatch.setattr(module, "ModuleParser", FakeParser)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "parse_file.py",
            str(tmp_path / "input.zip"),
            str(output),
            "--provider",
            "codex",
            "--model",
            "gpt-test",
        ],
    )

    assert module.main() == 0
    config = captured["config"]
    assert len(config.source_text) == 8_000
    assert config.source_sha256 == loaded.sha256
    assert config.max_chunk_chars == 30_000
    assert config.max_retries == 3
    assert config.codex_timeout_seconds == 3_600.0
    assert output.exists()


def test_parse_file_reports_a_safe_provider_code_without_a_traceback_or_output(
    monkeypatch, tmp_path: Path, capsys
) -> None:
    module = _load_parse_file_module()
    loaded = LoadedSource(
        text="# Test",
        name="test.md",
        sha256="c" * 64,
        media_type="text/markdown",
    )

    class FailingParser:
        def parse(self, _config, reporter=None):
            del reporter
            raise ProviderResponseError(
                "private provider detail and module excerpt",
                retryable=False,
                code="CODEX_CLI_STALLED",
            )

    output = tmp_path / "must-not-exist.cocmod.json"
    monkeypatch.setattr(module, "load_source_path", lambda _path: loaded)
    monkeypatch.setattr(module, "ModuleParser", FailingParser)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "parse_file.py",
            str(tmp_path / "input.zip"),
            str(output),
            "--provider",
            "codex",
        ],
    )

    assert module.main() == 2
    captured = capsys.readouterr()
    assert "CODEX_CLI_STALLED" in captured.err
    assert "No module file was written" in captured.err
    assert "private provider detail" not in captured.err
    assert "module excerpt" not in captured.err
    assert "Traceback" not in captured.err
    assert not output.exists()
