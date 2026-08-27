from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class TextChunk:
    id: str
    start: int
    end: int
    text: str
    sha256: str


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFC", value.lstrip("\ufeff"))
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = "".join(
        char
        for char in value
        if char in {"\n", "\t"} or unicodedata.category(char) != "Cc"
    )
    lines = [line.expandtabs(4).rstrip() for line in value.split("\n")]
    value = "\n".join(lines).strip()
    value = re.sub(r"\n{4,}", "\n\n\n", value)
    return value


def segment_text(text: str, max_chars: int, overlap_chars: int) -> list[TextChunk]:
    if not text:
        return []
    chunks: list[TextChunk] = []
    start = 0
    text_length = len(text)
    while start < text_length:
        hard_end = min(start + max_chars, text_length)
        end = hard_end
        if hard_end < text_length:
            minimum = start + max(max_chars // 2, 1)
            candidates = [
                text.rfind("\n#", minimum, hard_end),
                text.rfind("\n\n", minimum, hard_end),
                text.rfind("\n", minimum, hard_end),
            ]
            split = max(candidates)
            if split >= minimum:
                end = split + 1
        chunk_text = text[start:end]
        digest = hashlib.sha256(chunk_text.encode("utf-8")).hexdigest()
        chunks.append(
            TextChunk(
                id=f"chunk-{len(chunks) + 1:04d}",
                start=start,
                end=end,
                text=chunk_text,
                sha256=digest,
            )
        )
        if end >= text_length:
            break
        next_start = max(end - overlap_chars, start + 1)
        if overlap_chars:
            newline = text.find("\n", next_start, end)
            if newline != -1:
                next_start = newline + 1
        start = next_start
    return chunks


def infer_title(text: str, source_name: str) -> str:
    for line in text.splitlines():
        match = re.match(r"^#\s+(.+?)\s*$", line)
        if match:
            return match.group(1)[:300]
    stem = Path(source_name).stem.strip()
    return (stem or "Untitled CoC Module")[:300]


def stable_id(kind: str, label: str) -> str:
    normalized = unicodedata.normalize("NFKC", label).casefold().strip()
    digest = hashlib.sha1(f"{kind}\0{normalized}".encode("utf-8")).hexdigest()[:16]
    return f"{kind}:{digest}"
