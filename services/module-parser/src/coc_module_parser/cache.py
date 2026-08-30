from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from .models import CodexEvidenceFragmentV1, CodexWorldFragmentV1, ModuleFragmentV1


CACHE_VERSION = "module-fragment-cache-v5-codex-staged"


@dataclass(frozen=True, slots=True)
class CacheIdentity:
    source_sha256: str
    chunk_id: str
    chunk_sha256: str
    chunk_start: int
    chunk_end: int
    max_chunk_chars: int
    overlap_chars: int
    extractor: str
    model: str
    base_url: str
    max_output_tokens: int
    extraction_prompt_version: str
    schema_sha256: str
    extraction_stage: str = "fragment"
    cache_version: str = CACHE_VERSION

    def canonical(self) -> dict[str, Any]:
        return asdict(self)

    def key(self) -> str:
        encoded = json.dumps(
            self.canonical(), ensure_ascii=True, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


class ExtractionCache:
    """Validated fragment cache. Its API deliberately has no credential argument."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def _path(self, identity: CacheIdentity) -> Path:
        return self.root / identity.key()[:2] / f"{identity.key()}.json"

    def load(self, identity: CacheIdentity) -> ModuleFragmentV1 | None:
        path = self._path(identity)
        try:
            raw = path.read_text(encoding="utf-8")
            payload = json.loads(raw)
            if payload.get("identity") != identity.canonical():
                return None
            return ModuleFragmentV1.model_validate(payload["fragment"])
        except (OSError, KeyError, TypeError, ValueError, ValidationError, json.JSONDecodeError):
            return None

    def store(self, identity: CacheIdentity, fragment: ModuleFragmentV1) -> None:
        path = self._path(identity)
        payload = {
            "identity": identity.canonical(),
            "fragment": fragment.model_dump(mode="json"),
        }
        self._atomic_store(path, payload)

    def load_stage(
        self, identity: CacheIdentity, stage: str
    ) -> CodexWorldFragmentV1 | CodexEvidenceFragmentV1 | None:
        if stage not in {"world", "evidence"} or identity.extraction_stage != stage:
            raise ValueError("Codex stage cache identity does not match the requested stage")
        path = self._path(identity)
        model = CodexWorldFragmentV1 if stage == "world" else CodexEvidenceFragmentV1
        try:
            raw = path.read_text(encoding="utf-8")
            payload = json.loads(raw)
            if (
                payload.get("identity") != identity.canonical()
                or payload.get("stage") != stage
            ):
                return None
            return model.model_validate(payload["fragment"])
        except (OSError, KeyError, TypeError, ValueError, ValidationError, json.JSONDecodeError):
            return None

    def store_stage(
        self,
        identity: CacheIdentity,
        stage: str,
        fragment: CodexWorldFragmentV1 | CodexEvidenceFragmentV1,
    ) -> None:
        if stage not in {"world", "evidence"} or identity.extraction_stage != stage:
            raise ValueError("Codex stage cache identity does not match the requested stage")
        expected = CodexWorldFragmentV1 if stage == "world" else CodexEvidenceFragmentV1
        if not isinstance(fragment, expected):
            raise TypeError("Codex stage cache value does not match the requested stage")
        self._atomic_store(
            self._path(identity),
            {
                "identity": identity.canonical(),
                "stage": stage,
                "fragment": fragment.model_dump(mode="json"),
            },
        )

    @staticmethod
    def _atomic_store(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        serialized = json.dumps(
            payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        temp_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                newline="\n",
                prefix=f".{path.stem}.",
                suffix=".tmp",
                dir=path.parent,
                delete=False,
            ) as handle:
                temp_name = handle.name
                handle.write(serialized)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, path)
        finally:
            if temp_name:
                try:
                    Path(temp_name).unlink(missing_ok=True)
                except OSError:
                    pass
