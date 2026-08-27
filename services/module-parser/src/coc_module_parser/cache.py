from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from .models import ModuleFragmentV1


CACHE_VERSION = "module-fragment-cache-v2"


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
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "identity": identity.canonical(),
            "fragment": fragment.model_dump(mode="json"),
        }
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
