from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections.abc import Callable
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from .cache import CacheIdentity, ExtractionCache
from .client import (
    DeepSeekResponsesExtractor,
    DeterministicMockExtractor,
    ExtractionError,
    FragmentExtractor,
)
from .models import (
    EntityRelationV1,
    IssueSeverity,
    ModuleFragmentV1,
    ModuleMetadataV1,
    ModulePackageV1,
    ParseConfig,
    ParseIssueV1,
    ParseResultV1,
    SourceDocumentV1,
    SourceRefV1,
)
from .source_refs import find_excerpt_matches, reference_matches_span
from .text import TextChunk, infer_title, normalize_text, segment_text, stable_id


ProgressReporter = Callable[[str, float, str, dict[str, Any] | None], None]


def _noop_reporter(
    stage: str, progress: float, message: str, details: dict[str, Any] | None
) -> None:
    del stage, progress, message, details


class WorkflowState(TypedDict, total=False):
    config: ParseConfig
    extractor: FragmentExtractor
    reporter: ProgressReporter
    normalized_text: str
    source_sha256: str
    chunks: list[TextChunk]
    fragments: list[ModuleFragmentV1]
    issues: list[ParseIssueV1]
    attempts: int
    package: ModulePackageV1
    result: ParseResultV1


def _lookup_key(value: str) -> str:
    return unicodedata.normalize("NFKC", value).casefold().strip()


def _unique_strings(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def _unique_refs(values: list[SourceRefV1 | dict[str, Any]]) -> list[SourceRefV1]:
    seen: set[tuple[str, int, int]] = set()
    result: list[SourceRefV1] = []
    for value in values:
        value = SourceRefV1.model_validate(value)
        key = (value.chunk_id, value.start, value.end)
        if key not in seen:
            seen.add(key)
            result.append(value)
    return result


def _merge_nested_dicts(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    """Merge complementary structured fields while keeping first-seen conflicts stable."""

    merged = dict(existing)
    for key, value in incoming.items():
        current = merged.get(key)
        if isinstance(current, dict) and isinstance(value, dict):
            merged[key] = _merge_nested_dicts(current, value)
        elif current in (None, "", [], {}) and value not in (None, "", [], {}):
            merged[key] = value
    return merged


def _add_visible_aliases(
    aliases: dict[str, str],
    entities: list[Any],
    *,
    field_name: str,
    issues: list[ParseIssueV1],
) -> None:
    ambiguous: set[str] = set()
    for entity in entities:
        for value in getattr(entity, field_name):
            for key in {value, _lookup_key(value)}:
                existing = aliases.get(key)
                if existing is not None and existing != entity.id:
                    ambiguous.add(key)
                elif key not in ambiguous:
                    aliases[key] = entity.id
    for key in ambiguous:
        aliases.pop(key, None)
        issues.append(
            ParseIssueV1(
                severity=IssueSeverity.WARNING,
                code="AMBIGUOUS_ENTITY_ALIAS",
                stage="resolve_references",
                message=f"Ignored ambiguous alias {key!r} shared by multiple entities.",
            )
        )


def _merge_entities(
    items: list[Any],
    *,
    kind: str,
    label_field: str,
    semantic_key: Callable[[Any], str] | None,
    issues: list[ParseIssueV1],
) -> tuple[list[Any], dict[str, str]]:
    merged: dict[str, Any] = {}
    aliases: dict[str, str] = {}
    for item in items:
        label = str(getattr(item, label_field))
        key = _lookup_key(semantic_key(item) if semantic_key else label)
        canonical_id = stable_id(kind, key)
        for alias in {item.id, _lookup_key(item.id), label, _lookup_key(label), canonical_id}:
            if alias:
                aliases.setdefault(alias, canonical_id)
        if key not in merged:
            data = item.model_dump(mode="python")
            data["id"] = canonical_id
            merged[key] = type(item).model_validate(data)
            continue

        current = merged[key]
        current_data = current.model_dump(mode="python")
        incoming = item.model_dump(mode="python")
        for field_name, value in incoming.items():
            if field_name == "id" or value in (None, "", []):
                continue
            existing = current_data.get(field_name)
            if isinstance(value, list):
                if field_name == "source_refs":
                    current_data[field_name] = _unique_refs((existing or []) + value)
                else:
                    current_data[field_name] = _unique_strings((existing or []) + value)
            elif isinstance(value, dict) and isinstance(existing, dict):
                current_data[field_name] = _merge_nested_dicts(existing, value)
            elif isinstance(value, bool) and isinstance(existing, bool):
                current_data[field_name] = existing or value
            elif isinstance(value, str) and isinstance(existing, str):
                if len(value) > len(existing):
                    current_data[field_name] = value
            elif existing is None:
                current_data[field_name] = value
        merged[key] = type(item).model_validate(current_data)
        issues.append(
            ParseIssueV1(
                severity=IssueSeverity.INFO,
                code="DUPLICATE_ENTITY_MERGED",
                stage="resolve_references",
                message=f"Merged repeated {kind} entity {label!r} across chunks.",
                entity_id=canonical_id,
            )
        )
    return list(merged.values()), aliases


def _resolve_one(
    raw: str,
    aliases: dict[str, str],
    *,
    context: str,
    issues: list[ParseIssueV1],
) -> str | None:
    resolved = aliases.get(raw) or aliases.get(_lookup_key(raw))
    if resolved is None:
        issues.append(
            ParseIssueV1(
                severity=IssueSeverity.WARNING,
                code="UNRESOLVED_REFERENCE",
                stage="resolve_references",
                message=f"Removed unresolved reference {raw!r} from {context}.",
                retryable=False,
            )
        )
    return resolved


def _resolve_many(
    values: list[str],
    aliases: dict[str, str],
    *,
    context: str,
    issues: list[ParseIssueV1],
) -> list[str]:
    return _unique_strings(
        [
            resolved
            for value in values
            if (resolved := _resolve_one(value, aliases, context=context, issues=issues))
            is not None
        ]
    )


def _clean_refs(
    refs: list[SourceRefV1],
    *,
    chunks: dict[str, TextChunk],
    source_text: str,
    entity_id: str,
    issues: list[ParseIssueV1],
) -> list[SourceRefV1]:
    cleaned: list[SourceRefV1] = []
    for ref in refs:
        chunk = chunks.get(ref.chunk_id)
        if chunk is None:
            issues.append(
                ParseIssueV1(
                    severity=IssueSeverity.WARNING,
                    code="SOURCE_REFERENCE_UNKNOWN_CHUNK",
                    stage="resolve_references",
                    message=(
                        f"Removed source reference from {entity_id}: chunk "
                        f"{ref.chunk_id!r} does not exist."
                    ),
                    entity_id=entity_id,
                    chunk_id=ref.chunk_id,
                    source_ref=ref,
                )
            )
            continue
        if not ref.excerpt.strip():
            issues.append(
                ParseIssueV1(
                    severity=IssueSeverity.WARNING,
                    code="SOURCE_REFERENCE_MISSING_EXCERPT",
                    stage="resolve_references",
                    message=(
                        f"Removed source reference {ref.start}:{ref.end} from {entity_id}: "
                        "an excerpt is required to verify its offsets."
                    ),
                    entity_id=entity_id,
                    chunk_id=ref.chunk_id,
                    source_ref=ref,
                )
            )
            continue

        candidate: SourceRefV1 | None = None
        reason = ""
        # The extraction contract uses global offsets. Check that interpretation
        # first, then tolerate a model returning offsets local to its chunk.
        if (
            ref.start >= chunk.start
            and ref.end <= chunk.end
            and reference_matches_span(source_text, ref.start, ref.end, ref.excerpt)
        ):
            candidate = ref
        elif (
            ref.end <= len(chunk.text)
            and reference_matches_span(
                source_text,
                chunk.start + ref.start,
                chunk.start + ref.end,
                ref.excerpt,
            )
        ):
            candidate = ref.model_copy(
                update={"start": chunk.start + ref.start, "end": chunk.start + ref.end}
            )
            reason = "converted chunk-local offsets to cumulative document offsets"
        else:
            chunk_matches = find_excerpt_matches(
                source_text,
                ref.excerpt,
                region_start=chunk.start,
                region_end=chunk.end,
            )
            if len(chunk_matches) == 1:
                start, end = chunk_matches[0]
                candidate = ref.model_copy(update={"start": start, "end": end})
                reason = "found one excerpt match in the declared chunk"
            elif len(chunk_matches) > 1:
                issues.append(
                    ParseIssueV1(
                        severity=IssueSeverity.WARNING,
                        code="SOURCE_REFERENCE_AMBIGUOUS",
                        stage="resolve_references",
                        message=(
                            f"Removed source reference {ref.start}:{ref.end} from {entity_id}: "
                            f"the excerpt matched {len(chunk_matches)} places in "
                            f"{ref.chunk_id}."
                        ),
                        entity_id=entity_id,
                        chunk_id=ref.chunk_id,
                        source_ref=ref,
                    )
                )
                continue
            else:
                global_matches = find_excerpt_matches(source_text, ref.excerpt)
                if len(global_matches) == 1:
                    start, end = global_matches[0]
                    candidate = ref.model_copy(update={"start": start, "end": end})
                    reason = "found one excerpt match in the normalized document"
                elif len(global_matches) > 1:
                    issues.append(
                        ParseIssueV1(
                            severity=IssueSeverity.WARNING,
                            code="SOURCE_REFERENCE_AMBIGUOUS",
                            stage="resolve_references",
                            message=(
                                f"Removed source reference {ref.start}:{ref.end} from "
                                f"{entity_id}: the excerpt matched {len(global_matches)} "
                                "places in the normalized document."
                            ),
                            entity_id=entity_id,
                            chunk_id=ref.chunk_id,
                            source_ref=ref,
                        )
                    )
                    continue
                else:
                    issues.append(
                        ParseIssueV1(
                            severity=IssueSeverity.WARNING,
                            code="SOURCE_REFERENCE_NOT_FOUND",
                            stage="resolve_references",
                            message=(
                                f"Removed source reference {ref.start}:{ref.end} from "
                                f"{entity_id}: its excerpt was not found in the declared "
                                "chunk or the normalized document."
                            ),
                            entity_id=entity_id,
                            chunk_id=ref.chunk_id,
                            source_ref=ref,
                        )
                    )
                    continue

        if candidate is None:
            continue
        if candidate.start != ref.start or candidate.end != ref.end:
            issues.append(
                ParseIssueV1(
                    severity=IssueSeverity.INFO,
                    code="SOURCE_REFERENCE_RELOCATED",
                    stage="resolve_references",
                    message=(
                        f"Corrected source reference for {entity_id} from "
                        f"{ref.start}:{ref.end} to {candidate.start}:{candidate.end}: {reason}."
                    ),
                    entity_id=entity_id,
                    chunk_id=ref.chunk_id,
                    source_ref=ref,
                )
            )
        cleaned.append(candidate)
    return _unique_refs(cleaned)


class ModuleParser:
    def __init__(self, extractor: FragmentExtractor | None = None) -> None:
        self._extractor_override = extractor
        graph = StateGraph(WorkflowState)
        graph.add_node("normalize", self._normalize)
        graph.add_node("segment", self._segment)
        graph.add_node("extract", self._extract)
        graph.add_node("resolve_references", self._resolve_references)
        graph.add_node("validate", self._validate)
        graph.add_node("summarize", self._summarize)
        graph.add_edge(START, "normalize")
        graph.add_edge("normalize", "segment")
        graph.add_edge("segment", "extract")
        graph.add_edge("extract", "resolve_references")
        graph.add_edge("resolve_references", "validate")
        graph.add_edge("validate", "summarize")
        graph.add_edge("summarize", END)
        self._graph = graph.compile()

    def parse(
        self,
        config: ParseConfig,
        reporter: ProgressReporter | None = None,
    ) -> ParseResultV1:
        extractor = self._extractor_override or self._make_extractor(config)
        final = self._graph.invoke(
            {
                "config": config,
                "extractor": extractor,
                "reporter": reporter or _noop_reporter,
                "issues": [],
                "attempts": 0,
            }
        )
        return final["result"]

    @staticmethod
    def _make_extractor(config: ParseConfig) -> FragmentExtractor:
        if config.mock:
            return DeterministicMockExtractor()
        assert config.api_key is not None
        return DeepSeekResponsesExtractor(
            api_key=config.api_key.get_secret_value(),
            model=config.model,
            base_url=config.base_url,
            max_output_tokens=config.max_output_tokens,
        )

    @staticmethod
    def _normalize(state: WorkflowState) -> dict[str, Any]:
        reporter = state["reporter"]
        reporter("normalize", 0.05, "Normalizing source text", None)
        config = state["config"]
        normalized = normalize_text(config.source_text)
        if not normalized:
            raise ValueError("source document contains no text after normalization")
        source_sha = config.source_sha256 or hashlib.sha256(
            config.source_text.encode("utf-8")
        ).hexdigest()
        return {"normalized_text": normalized, "source_sha256": source_sha}

    @staticmethod
    def _segment(state: WorkflowState) -> dict[str, Any]:
        reporter = state["reporter"]
        reporter("segment", 0.12, "Segmenting normalized source", None)
        config = state["config"]
        chunks = segment_text(
            state["normalized_text"],
            config.max_chunk_chars,
            config.chunk_overlap_chars,
        )
        reporter(
            "segment",
            0.18,
            f"Prepared {len(chunks)} source chunk(s)",
            {"chunk_count": len(chunks)},
        )
        return {"chunks": chunks}

    @staticmethod
    def _extract(state: WorkflowState) -> dict[str, Any]:
        config = state["config"]
        extractor = state["extractor"]
        reporter = state["reporter"]
        chunks = state["chunks"]
        issues = list(state["issues"])
        fragments: list[ModuleFragmentV1] = []
        attempts = state["attempts"]
        cache = ExtractionCache(config.cache_dir) if config.cache_dir else None
        schema_json = json.dumps(
            ModuleFragmentV1.model_json_schema(mode="validation"),
            sort_keys=True,
            separators=(",", ":"),
        )
        schema_sha = hashlib.sha256(schema_json.encode("utf-8")).hexdigest()

        for index, chunk in enumerate(chunks):
            fraction = index / max(len(chunks), 1)
            reporter(
                "extract",
                0.2 + 0.42 * fraction,
                f"Extracting chunk {index + 1}/{len(chunks)}",
                {"chunk_id": chunk.id, "chunk_index": index, "chunk_count": len(chunks)},
            )
            identity = CacheIdentity(
                source_sha256=state["source_sha256"],
                chunk_id=chunk.id,
                chunk_sha256=chunk.sha256,
                chunk_start=chunk.start,
                chunk_end=chunk.end,
                max_chunk_chars=config.max_chunk_chars,
                overlap_chars=config.chunk_overlap_chars,
                extractor=extractor.name,
                model=extractor.model,
                base_url=str(getattr(extractor, "base_url", config.base_url)).rstrip("/"),
                max_output_tokens=int(
                    getattr(extractor, "max_output_tokens", config.max_output_tokens)
                ),
                extraction_prompt_version=extractor.extraction_prompt_version,
                schema_sha256=schema_sha,
            )
            cached = cache.load(identity) if cache else None
            if cached is not None:
                fragments.append(cached)
                reporter(
                    "extract",
                    0.2 + 0.42 * ((index + 1) / len(chunks)),
                    f"Loaded chunk {index + 1}/{len(chunks)} from cache",
                    {"chunk_id": chunk.id, "cached": True},
                )
                continue

            previous_error: str | None = None
            fragment: ModuleFragmentV1 | None = None
            failures: list[ExtractionError] = []
            for retry in range(config.max_retries + 1):
                attempts += 1
                try:
                    fragment = extractor.extract(chunk, previous_error=previous_error)
                    fragment = ModuleFragmentV1.model_validate(
                        fragment.model_dump(mode="python")
                    )
                    if retry:
                        issues.append(
                            ParseIssueV1(
                                severity=IssueSeverity.INFO,
                                code="EXTRACTION_RETRIED",
                                stage="extract",
                                message=f"Chunk {chunk.id} succeeded after {retry} retry attempt(s).",
                                chunk_id=chunk.id,
                            )
                        )
                    break
                except ExtractionError as exc:
                    failures.append(exc)
                    previous_error = f"{exc.code}: {str(exc)}"
                    if retry >= config.max_retries or not exc.retryable:
                        break
                    reporter(
                        "extract",
                        0.2 + 0.42 * fraction,
                        f"Retrying chunk {index + 1}/{len(chunks)}",
                        {"chunk_id": chunk.id, "retry": retry + 1, "code": exc.code},
                    )
            if fragment is None:
                last = failures[-1] if failures else None
                issues.append(
                    ParseIssueV1(
                        severity=IssueSeverity.ERROR,
                        code=(last.code if last else "EXTRACTION_FAILED"),
                        stage="extract",
                        message=(
                            f"Chunk {chunk.id} could not be extracted after "
                            f"{len(failures)} attempt(s); repair it manually in the editor."
                        ),
                        chunk_id=chunk.id,
                        retryable=bool(last and last.retryable),
                    )
                )
                continue
            fragments.append(fragment)
            if cache:
                cache.store(identity, fragment)

        reporter("extract", 0.64, "Entity extraction complete", None)
        return {"fragments": fragments, "issues": issues, "attempts": attempts}

    @staticmethod
    def _resolve_references(state: WorkflowState) -> dict[str, Any]:
        state["reporter"]("resolve_references", 0.7, "Resolving entity references", None)
        issues = list(state["issues"])
        fragments = state["fragments"]

        scenes, scene_aliases = _merge_entities(
            [item for fragment in fragments for item in fragment.scenes],
            kind="scene",
            label_field="title",
            semantic_key=None,
            issues=issues,
        )
        locations, location_aliases = _merge_entities(
            [item for fragment in fragments for item in fragment.locations],
            kind="location",
            label_field="name",
            semantic_key=None,
            issues=issues,
        )
        npcs, npc_aliases = _merge_entities(
            [item for fragment in fragments for item in fragment.npcs],
            kind="npc",
            label_field="name",
            semantic_key=None,
            issues=issues,
        )
        clues, clue_aliases = _merge_entities(
            [item for fragment in fragments for item in fragment.clues],
            kind="clue",
            label_field="title",
            semantic_key=lambda item: f"{item.title}|{item.content}",
            issues=issues,
        )
        checks, check_aliases = _merge_entities(
            [item for fragment in fragments for item in fragment.suggested_checks],
            kind="check",
            label_field="skill",
            semantic_key=lambda item: f"{item.skill}|{item.scene_id or ''}|{item.purpose}",
            issues=issues,
        )
        notes, note_aliases = _merge_entities(
            [item for fragment in fragments for item in fragment.keeper_notes],
            kind="note",
            label_field="title",
            semantic_key=lambda item: f"{item.title}|{item.content}",
            issues=issues,
        )
        handouts, handout_aliases = _merge_entities(
            [item for fragment in fragments for item in fragment.handouts],
            kind="handout",
            label_field="title",
            semantic_key=None,
            issues=issues,
        )
        _add_visible_aliases(
            location_aliases,
            locations,
            field_name="aliases",
            issues=issues,
        )

        for scene in scenes:
            scene.location_ids = _resolve_many(
                scene.location_ids,
                location_aliases,
                context=f"scene {scene.id} locations",
                issues=issues,
            )
            scene.npc_ids = _resolve_many(
                scene.npc_ids, npc_aliases, context=f"scene {scene.id} npcs", issues=issues
            )
            scene.clue_ids = _resolve_many(
                scene.clue_ids,
                clue_aliases,
                context=f"scene {scene.id} clues",
                issues=issues,
            )
            scene.handout_ids = _resolve_many(
                scene.handout_ids,
                handout_aliases,
                context=f"scene {scene.id} handouts",
                issues=issues,
            )
            scene.suggested_check_ids = _resolve_many(
                scene.suggested_check_ids,
                check_aliases,
                context=f"scene {scene.id} checks",
                issues=issues,
            )
        for clue in clues:
            clue.scene_ids = _resolve_many(
                clue.scene_ids, scene_aliases, context=f"clue {clue.id} scenes", issues=issues
            )
            clue.location_ids = _resolve_many(
                clue.location_ids,
                location_aliases,
                context=f"clue {clue.id} locations",
                issues=issues,
            )
        for check in checks:
            if check.scene_id is not None:
                check.scene_id = _resolve_one(
                    check.scene_id,
                    scene_aliases,
                    context=f"check {check.id}",
                    issues=issues,
                )
        for note in notes:
            note.scene_ids = _resolve_many(
                note.scene_ids, scene_aliases, context=f"note {note.id} scenes", issues=issues
            )
        for handout in handouts:
            handout.scene_ids = _resolve_many(
                handout.scene_ids,
                scene_aliases,
                context=f"handout {handout.id} scenes",
                issues=issues,
            )

        scene_by_id = {scene.id: scene for scene in scenes}
        handout_by_id = {handout.id: handout for handout in handouts}
        for handout in handouts:
            for scene_id in handout.scene_ids:
                scene = scene_by_id[scene_id]
                if handout.id not in scene.handout_ids:
                    scene.handout_ids.append(handout.id)
        for scene in scenes:
            for handout_id in scene.handout_ids:
                handout = handout_by_id[handout_id]
                if scene.id not in handout.scene_ids:
                    handout.scene_ids.append(scene.id)

        chunk_map = {chunk.id: chunk for chunk in state["chunks"]}
        source_length = len(state["normalized_text"])
        for item in scenes + locations + npcs + clues + handouts + checks + notes:
            item.source_refs = _clean_refs(
                item.source_refs,
                chunks=chunk_map,
                source_text=state["normalized_text"],
                entity_id=item.id,
                issues=issues,
            )

        all_aliases: dict[str, str] = {}
        ambiguous: set[str] = set()
        for aliases in (
            scene_aliases,
            location_aliases,
            npc_aliases,
            clue_aliases,
            handout_aliases,
            check_aliases,
            note_aliases,
        ):
            for alias, entity_id in aliases.items():
                if alias in all_aliases and all_aliases[alias] != entity_id:
                    ambiguous.add(alias)
                else:
                    all_aliases[alias] = entity_id
        for alias in ambiguous:
            all_aliases.pop(alias, None)

        relations: list[EntityRelationV1] = []
        relation_keys: set[tuple[str, str, str]] = set()
        for fragment in fragments:
            for relation in fragment.relations:
                source_id = _resolve_one(
                    relation.source_id,
                    all_aliases,
                    context="relation source",
                    issues=issues,
                )
                target_id = _resolve_one(
                    relation.target_id,
                    all_aliases,
                    context="relation target",
                    issues=issues,
                )
                if source_id is None or target_id is None:
                    continue
                key = (source_id, target_id, _lookup_key(relation.relation))
                if key in relation_keys:
                    continue
                relation_keys.add(key)
                refs = _clean_refs(
                    relation.source_refs,
                    chunks=chunk_map,
                    source_text=state["normalized_text"],
                    entity_id=source_id,
                    issues=issues,
                )
                relations.append(
                    relation.model_copy(
                        update={"source_id": source_id, "target_id": target_id, "source_refs": refs}
                    )
                )

        extracted_title = next(
            (
                fragment.metadata.title
                for fragment in fragments
                if fragment.metadata.title
            ),
            None,
        )
        inferred_title = infer_title(
            state["normalized_text"], state["config"].source_name
        )
        has_explicit_heading = bool(
            re.search(r"(?m)^#\s+\S", state["normalized_text"])
        )
        title = inferred_title if has_explicit_heading else (extracted_title or inferred_title)
        author = next(
            (fragment.metadata.author for fragment in fragments if fragment.metadata.author),
            None,
        )
        language = next(
            (fragment.metadata.language for fragment in fragments if fragment.metadata.language),
            None,
        )
        tags = _unique_strings(
            [tag for fragment in fragments for tag in fragment.metadata.tags]
        )[:50]
        overview_notes = _unique_strings(
            [note for fragment in fragments for note in fragment.overview_notes]
        )
        overview = "\n\n".join(overview_notes)[:50_000]
        extensions: dict[str, Any] = {}
        for fragment in fragments:
            for namespace, value in fragment.extensions.items():
                if namespace in extensions and extensions[namespace] != value:
                    issues.append(
                        ParseIssueV1(
                            severity=IssueSeverity.WARNING,
                            code="EXTENSION_CONFLICT",
                            stage="resolve_references",
                            message=f"Kept the first value for extension namespace {namespace!r}.",
                        )
                    )
                    continue
                extensions[namespace] = value

        package = ModulePackageV1(
            module_id=stable_id("module", state["source_sha256"]),
            metadata=ModuleMetadataV1(
                title=title, author=author, language=language, tags=tags
            ),
            source=SourceDocumentV1(
                name=state["config"].source_name,
                sha256=state["source_sha256"],
                char_count=source_length,
            ),
            overview=overview,
            # Chapters are an editor-owned grouping. They are deliberately absent
            # from ModuleFragmentV1 and are never inferred from model output.
            chapters=[],
            scenes=scenes,
            locations=locations,
            npcs=npcs,
            clues=clues,
            handouts=handouts,
            suggested_checks=checks,
            keeper_notes=notes,
            relations=relations,
            extensions=extensions,
        )
        return {"package": package, "issues": issues}

    @staticmethod
    def _validate(state: WorkflowState) -> dict[str, Any]:
        state["reporter"]("validate", 0.88, "Validating ModulePackageV1", None)
        package = ModulePackageV1.model_validate(
            state["package"].model_dump(mode="python")
        )
        return {"package": package}

    @staticmethod
    def _summarize(state: WorkflowState) -> dict[str, Any]:
        state["reporter"]("summarize", 0.96, "Summarizing parse issues", None)
        issues = state["issues"]
        status = (
            "needs_review"
            if any(issue.severity == IssueSeverity.ERROR for issue in issues)
            else "ready_for_review"
        )
        result = ParseResultV1(
            status=status,
            module=state["package"],
            issues=issues,
            extraction_attempts=state["attempts"],
        )
        state["reporter"](
            "summarize",
            1.0,
            "Module draft is ready for editor review",
            {"status": status, "issue_count": len(issues)},
        )
        return {"result": result}
