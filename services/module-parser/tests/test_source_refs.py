from __future__ import annotations

import hashlib

from coc_module_parser.models import ParseIssueV1, SourceRefV1
from coc_module_parser.source_refs import (
    audit_cocmod_source_refs,
    reference_matches_span,
    repair_cocmod_source_refs,
)
from coc_module_parser.text import TextChunk
from coc_module_parser.workflow import _clean_refs


def _chunk(source: str, start: int = 0, end: int | None = None) -> TextChunk:
    end = len(source) if end is None else end
    text = source[start:end]
    return TextChunk(
        id="chunk-0002",
        start=start,
        end=end,
        text=text,
        sha256=hashlib.sha256(text.encode()).hexdigest(),
    )


def _clean(
    source: str, chunk: TextChunk, reference: SourceRefV1
) -> tuple[list[SourceRefV1], list[ParseIssueV1]]:
    issues: list[ParseIssueV1] = []
    cleaned = _clean_refs(
        [reference],
        chunks={chunk.id: chunk},
        source_text=source,
        entity_id="scene:test",
        issues=issues,
    )
    return cleaned, issues


def test_global_offsets_use_python_unicode_code_points() -> None:
    source = "前🙂缀\n唯一目标"
    start = source.index("唯一目标")
    chunk = _chunk(source, start)
    reference = SourceRefV1(
        chunk_id=chunk.id,
        start=start,
        end=start + len("唯一目标"),
        excerpt="唯一目标",
    )

    cleaned, issues = _clean(source, chunk, reference)

    assert [(item.start, item.end) for item in cleaned] == [(4, 8)]
    assert issues == []
    assert reference_matches_span(source, 4, 8, "唯一目标")


def test_chunk_local_offsets_are_shifted_by_the_cumulative_chunk_start() -> None:
    source = "第一段🙂\n第二段文字\n第三段唯一内容"
    chunk_start = source.index("第三段")
    chunk = _chunk(source, chunk_start)
    local_start = chunk.text.index("唯一")
    reference = SourceRefV1(
        chunk_id=chunk.id,
        start=local_start,
        end=local_start + len("唯一内容"),
        excerpt="唯一内容",
    )

    cleaned, issues = _clean(source, chunk, reference)

    expected = source.index("唯一内容")
    assert [(item.start, item.end) for item in cleaned] == [
        (expected, expected + len("唯一内容"))
    ]
    assert issues[0].code == "SOURCE_REFERENCE_RELOCATED"
    assert "cumulative document offsets" in issues[0].message


def test_mismatch_relocates_unique_match_in_chunk_with_whitespace_and_ellipsis() -> None:
    source = "序言\n目标   开始\n中间有若干文字\n结尾标记\n尾声"
    chunk = _chunk(source)
    reference = SourceRefV1(
        chunk_id=chunk.id,
        start=0,
        end=2,
        excerpt="目标 开始…结尾标记",
    )

    cleaned, issues = _clean(source, chunk, reference)

    assert len(cleaned) == 1
    assert source[cleaned[0].start : cleaned[0].end].startswith("目标")
    assert source[cleaned[0].start : cleaned[0].end].endswith("结尾标记")
    assert issues[0].code == "SOURCE_REFERENCE_RELOCATED"
    assert "declared chunk" in issues[0].message


def test_trailing_ellipsis_cannot_validate_an_arbitrary_declared_end() -> None:
    source = "唯一锚点 后续并不属于引用"
    chunk = _chunk(source)
    reference = SourceRefV1(
        chunk_id=chunk.id,
        start=0,
        end=len(source),
        excerpt="唯一锚点…",
    )

    cleaned, issues = _clean(source, chunk, reference)

    assert [(item.start, item.end) for item in cleaned] == [(0, len("唯一锚点"))]
    assert issues[0].code == "SOURCE_REFERENCE_RELOCATED"


def test_mismatch_falls_back_to_one_global_match_when_chunk_has_none() -> None:
    source = "全文唯一证据\n\n另一个区块"
    chunk_start = source.index("另一个")
    chunk = _chunk(source, chunk_start)
    reference = SourceRefV1(
        chunk_id=chunk.id,
        start=0,
        end=2,
        excerpt="全文唯一证据",
    )

    cleaned, issues = _clean(source, chunk, reference)

    assert [(item.start, item.end) for item in cleaned] == [(0, len("全文唯一证据"))]
    assert issues[0].code == "SOURCE_REFERENCE_RELOCATED"
    assert "normalized document" in issues[0].message


def test_ambiguous_excerpt_is_removed_with_match_count() -> None:
    source = "重复证据 / 重复证据"
    chunk = _chunk(source)
    reference = SourceRefV1(
        chunk_id=chunk.id,
        start=2,
        end=4,
        excerpt="重复证据",
    )

    cleaned, issues = _clean(source, chunk, reference)

    assert cleaned == []
    assert issues[0].code == "SOURCE_REFERENCE_AMBIGUOUS"
    assert "2 places" in issues[0].message


def test_excerpt_not_found_is_removed_with_specific_issue() -> None:
    source = "这里没有引用内容"
    chunk = _chunk(source)
    reference = SourceRefV1(
        chunk_id=chunk.id,
        start=0,
        end=2,
        excerpt="完全不存在",
    )

    cleaned, issues = _clean(source, chunk, reference)

    assert cleaned == []
    assert issues[0].code == "SOURCE_REFERENCE_NOT_FOUND"
    assert "declared chunk or the normalized document" in issues[0].message


def test_cocmod_audit_reports_valid_relocatable_ambiguous_and_missing() -> None:
    source = "正确引用；唯一错位；重复；重复"
    payload = {
        "scenes": [
            {
                "sourceRefs": [
                    {"start": 0, "end": 4, "excerpt": "正确引用"},
                    {"start": 0, "end": 2, "excerpt": "唯一错位"},
                    {"start": 0, "end": 2, "excerpt": "重复"},
                    {"start": 0, "end": 2},
                    {"start": 0, "end": 2, "excerpt": "找不到"},
                ]
            }
        ]
    }

    report = audit_cocmod_source_refs(payload, source)

    assert report["counts"] == {
        "total": 5,
        "valid": 1,
        "relocatable": 1,
        "ambiguous": 1,
        "notFound": 1,
        "missingExcerpt": 1,
        "malformed": 0,
    }
    assert all("excerpt" not in finding for finding in report["findings"])

    repaired = repair_cocmod_source_refs(payload, source)
    after = audit_cocmod_source_refs(payload, source)
    assert repaired == {"unchanged": 1, "relocated": 1, "removed": 3}
    assert after["counts"] == {
        "total": 2,
        "valid": 2,
        "relocatable": 0,
        "ambiguous": 0,
        "notFound": 0,
        "missingExcerpt": 0,
        "malformed": 0,
    }
