from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterator
from typing import Any


_ELLIPSIS_RE = re.compile(r"(?:\.{3,}|…+|⋯+)")
_LEADING_ELLIPSIS_RE = re.compile(r"^(?:\.{3,}|…+|⋯+)\s*")
_TRAILING_ELLIPSIS_RE = re.compile(r"\s*(?:\.{3,}|…+|⋯+)$")
_MAX_ELLIPSIS_GAP = 20_000
_MAX_REPORTED_MATCHES = 1_001


def _normalized_excerpt(value: str) -> str:
    return unicodedata.normalize("NFC", value).strip()


def _excerpt_pattern(excerpt: str, *, ellipsis_wildcard: bool) -> str:
    parts: list[str] = []
    cursor = 0
    while cursor < len(excerpt):
        ellipsis = _ELLIPSIS_RE.match(excerpt, cursor)
        if ellipsis is not None:
            token = ellipsis.group(0)
            parts.append(
                rf"[\s\S]{{0,{_MAX_ELLIPSIS_GAP}}}?"
                if ellipsis_wildcard
                else re.escape(token)
            )
            cursor = ellipsis.end()
            continue
        if excerpt[cursor].isspace():
            cursor += 1
            while cursor < len(excerpt) and excerpt[cursor].isspace():
                cursor += 1
            parts.append(r"\s+")
            continue
        literal_start = cursor
        cursor += 1
        while (
            cursor < len(excerpt)
            and not excerpt[cursor].isspace()
            and _ELLIPSIS_RE.match(excerpt, cursor) is None
        ):
            cursor += 1
        parts.append(re.escape(excerpt[literal_start:cursor]))
    return "".join(parts)


def _literal_anchor_length(excerpt: str) -> int:
    without_ellipsis = _ELLIPSIS_RE.sub("", excerpt)
    return sum(not character.isspace() for character in without_ellipsis)


def _trim_boundary_ellipses(excerpt: str) -> str:
    excerpt = _LEADING_ELLIPSIS_RE.sub("", excerpt)
    return _TRAILING_ELLIPSIS_RE.sub("", excerpt).strip()


def _iter_pattern_matches(
    source_text: str,
    pattern: str,
    *,
    region_start: int,
    region_end: int,
) -> Iterator[tuple[int, int]]:
    region = source_text[region_start:region_end]
    # A look-ahead is intentional: non-overlapping finditer would miss repeated
    # candidates such as "aaa" at offsets 0 and 1 in "aaaa".
    compiled = re.compile(rf"(?=({pattern}))")
    for match in compiled.finditer(region):
        start, end = match.span(1)
        if end > start:
            yield region_start + start, region_start + end


def reference_matches_span(
    source_text: str, start: int, end: int, excerpt: str
) -> bool:
    """Verify a reference using Python Unicode-code-point offsets."""

    excerpt = _normalized_excerpt(excerpt)
    if not excerpt or start < 0 or end <= start or end > len(source_text):
        return False
    candidate = source_text[start:end]
    exact_pattern = _excerpt_pattern(excerpt, ellipsis_wildcard=False)
    if re.fullmatch(exact_pattern, candidate) is not None:
        return True
    anchored_excerpt = _trim_boundary_ellipses(excerpt)
    if not anchored_excerpt or _literal_anchor_length(anchored_excerpt) < 4:
        return False
    wildcard_pattern = _excerpt_pattern(anchored_excerpt, ellipsis_wildcard=True)
    return re.fullmatch(wildcard_pattern, candidate) is not None


def find_excerpt_matches(
    source_text: str,
    excerpt: str,
    *,
    region_start: int = 0,
    region_end: int | None = None,
) -> list[tuple[int, int]]:
    """Find evidence-backed excerpt spans, preferring literal ellipses.

    Whitespace runs are equivalent. Three dots and Unicode ellipses are treated
    as bounded wildcards only when the literal form has no match and at least
    four non-ellipsis anchor characters remain.
    """

    excerpt = _normalized_excerpt(excerpt)
    region_end = len(source_text) if region_end is None else region_end
    if (
        not excerpt
        or region_start < 0
        or region_end < region_start
        or region_end > len(source_text)
    ):
        return []

    exact_pattern = _excerpt_pattern(excerpt, ellipsis_wildcard=False)
    matches = list(
        _iter_pattern_matches(
            source_text,
            exact_pattern,
            region_start=region_start,
            region_end=region_end,
        )
    )[:_MAX_REPORTED_MATCHES]
    if matches or _ELLIPSIS_RE.search(excerpt) is None:
        return matches
    anchored_excerpt = _trim_boundary_ellipses(excerpt)
    if not anchored_excerpt or _literal_anchor_length(anchored_excerpt) < 4:
        return []
    wildcard_pattern = _excerpt_pattern(anchored_excerpt, ellipsis_wildcard=True)
    return list(
        _iter_pattern_matches(
            source_text,
            wildcard_pattern,
            region_start=region_start,
            region_end=region_end,
        )
    )[:_MAX_REPORTED_MATCHES]


def _walk_source_refs(value: Any, path: str = "$") -> Iterator[tuple[str, Any]]:
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if key == "sourceRefs" and isinstance(child, list):
                for index, reference in enumerate(child):
                    yield f"{child_path}[{index}]", reference
            else:
                yield from _walk_source_refs(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _walk_source_refs(child, f"{path}[{index}]")


def _walk_source_ref_lists(
    value: Any, path: str = "$"
) -> Iterator[tuple[str, list[Any]]]:
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if key == "sourceRefs" and isinstance(child, list):
                yield child_path, child
            else:
                yield from _walk_source_ref_lists(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _walk_source_ref_lists(child, f"{path}[{index}]")


def audit_cocmod_source_refs(payload: Any, source_text: str) -> dict[str, Any]:
    """Audit canonical cocmod sourceRefs without copying source text into output."""

    counts = {
        "total": 0,
        "valid": 0,
        "relocatable": 0,
        "ambiguous": 0,
        "notFound": 0,
        "missingExcerpt": 0,
        "malformed": 0,
    }
    findings: list[dict[str, Any]] = []
    for path, raw in _walk_source_refs(payload):
        counts["total"] += 1
        if not isinstance(raw, dict):
            counts["malformed"] += 1
            findings.append({"path": path, "code": "MALFORMED_REFERENCE"})
            continue
        start, end, excerpt = raw.get("start"), raw.get("end"), raw.get("excerpt")
        if not isinstance(start, int) or not isinstance(end, int):
            counts["malformed"] += 1
            findings.append({"path": path, "code": "MALFORMED_REFERENCE"})
            continue
        if not isinstance(excerpt, str) or not excerpt.strip():
            counts["missingExcerpt"] += 1
            findings.append({"path": path, "code": "MISSING_EXCERPT"})
            continue
        if reference_matches_span(source_text, start, end, excerpt):
            counts["valid"] += 1
            continue
        matches = find_excerpt_matches(source_text, excerpt)
        if len(matches) == 1:
            counts["relocatable"] += 1
            findings.append(
                {
                    "path": path,
                    "code": "RELOCATABLE",
                    "declaredStart": start,
                    "declaredEnd": end,
                    "suggestedStart": matches[0][0],
                    "suggestedEnd": matches[0][1],
                }
            )
        elif matches:
            counts["ambiguous"] += 1
            findings.append(
                {"path": path, "code": "AMBIGUOUS", "matchCount": len(matches)}
            )
        else:
            counts["notFound"] += 1
            findings.append({"path": path, "code": "NOT_FOUND"})
    return {"counts": counts, "findings": findings}


def repair_cocmod_source_refs(payload: Any, source_text: str) -> dict[str, int]:
    """Repair globally unique cocmod references and remove every unverified one.

    The canonical format no longer contains chunk IDs, so this developer helper
    deliberately uses only whole-document uniqueness. It mutates ``payload`` and
    returns counts without including excerpts or source text.
    """

    counts = {"unchanged": 0, "relocated": 0, "removed": 0}
    for _path, references in _walk_source_ref_lists(payload):
        for index in range(len(references) - 1, -1, -1):
            raw = references[index]
            if not isinstance(raw, dict):
                references.pop(index)
                counts["removed"] += 1
                continue
            start, end, excerpt = raw.get("start"), raw.get("end"), raw.get("excerpt")
            if (
                isinstance(start, int)
                and isinstance(end, int)
                and isinstance(excerpt, str)
                and reference_matches_span(source_text, start, end, excerpt)
            ):
                counts["unchanged"] += 1
                continue
            matches = (
                find_excerpt_matches(source_text, excerpt)
                if isinstance(excerpt, str) and excerpt.strip()
                else []
            )
            if len(matches) == 1:
                raw["start"], raw["end"] = matches[0]
                counts["relocated"] += 1
            else:
                references.pop(index)
                counts["removed"] += 1
    return counts
