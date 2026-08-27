from __future__ import annotations

import hashlib
import re
import stat
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePosixPath
from zipfile import BadZipFile, ZipFile, ZipInfo

from docx import Document
from docx.table import Table, _Cell
from docx.text.paragraph import Paragraph
from docx.text.run import Run
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P


SUPPORTED_EXTENSIONS = {".txt", ".md", ".docx"}
MAX_SOURCE_BYTES = 25 * 1024 * 1024
MAX_ZIP_ENTRIES = 128
MAX_ZIP_EXPANDED_BYTES = 50 * 1024 * 1024
MAX_DOCX_ENTRIES = 10_000
MAX_DOCX_EXPANDED_BYTES = 100 * 1024 * 1024
MAX_ENTRY_BYTES = 25 * 1024 * 1024
MAX_COMPRESSION_RATIO = 500


class InputError(ValueError):
    """Safe, user-facing input rejection."""

    code = "INVALID_INPUT"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code


@dataclass(frozen=True, slots=True)
class LoadedSource:
    text: str
    name: str
    sha256: str
    media_type: str


def _repair_legacy_utf8_name(name: str) -> str:
    """Some macOS ZIPs contain UTF-8 names without the UTF-8 flag."""

    try:
        repaired = name.encode("cp437").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name
    return repaired


def _safe_archive_name(info: ZipInfo) -> str:
    original = info.filename.replace("\\", "/")
    repaired = _repair_legacy_utf8_name(original)
    for candidate in {original, repaired}:
        path = PurePosixPath(candidate)
        if (
            path.is_absolute()
            or ".." in path.parts
            or (path.parts and ":" in path.parts[0])
            or candidate.startswith("//")
        ):
            raise InputError("archive contains an unsafe path", code="UNSAFE_ARCHIVE")
    mode = (info.external_attr >> 16) & 0xFFFF
    if mode and stat.S_ISLNK(mode):
        raise InputError("archive symlinks are not supported", code="UNSAFE_ARCHIVE")
    if info.flag_bits & 0x1:
        raise InputError("encrypted archives are not supported", code="UNSAFE_ARCHIVE")
    return repaired


def _is_metadata_file(name: str) -> bool:
    path = PurePosixPath(name)
    return (
        "__MACOSX" in path.parts
        or path.name == ".DS_Store"
        or path.name.startswith("._")
    )


def _validate_zip_limits(
    entries: list[ZipInfo], *, max_entries: int, max_expanded_bytes: int
) -> None:
    if len(entries) > max_entries:
        raise InputError("archive contains too many entries", code="ARCHIVE_LIMIT")
    total = 0
    for info in entries:
        if info.is_dir():
            continue
        _safe_archive_name(info)
        total += info.file_size
        if info.file_size > MAX_ENTRY_BYTES or total > max_expanded_bytes:
            raise InputError("archive expands beyond the size limit", code="ARCHIVE_LIMIT")
        if info.file_size and info.compress_size == 0:
            raise InputError("archive entry has an invalid compression size", code="ARCHIVE_LIMIT")
        if info.compress_size and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO:
            raise InputError("archive compression ratio is unsafe", code="ARCHIVE_LIMIT")


def _decode_text(data: bytes) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            return data.decode("gb18030")
        except UnicodeDecodeError as exc:
            raise InputError(
                "text files must use UTF-8, UTF-16, or GB18030 encoding",
                code="UNSUPPORTED_ENCODING",
            ) from exc


def _heading_level(paragraph: Paragraph) -> int | None:
    style = paragraph.style
    candidates = [
        getattr(style, "style_id", "") or "",
        getattr(style, "name", "") or "",
    ]
    for candidate in candidates:
        match = re.search(r"(?:heading|标题)\s*([1-6])", candidate, re.IGNORECASE)
        if match:
            return int(match.group(1))
    outline = paragraph._p.pPr
    if outline is not None and outline.outlineLvl is not None:
        value = outline.outlineLvl.val
        if isinstance(value, int) and 0 <= value <= 5:
            return value + 1
    return None


def _run_text(run: Run) -> str:
    return run.text


def _paragraph_markdown(paragraph: Paragraph) -> str:
    text = "".join(_run_text(run) for run in paragraph.runs).strip()
    if not text:
        text = paragraph.text.strip()
    if not text:
        return ""
    level = _heading_level(paragraph)
    if level is not None:
        return f"{'#' * level} {text}"
    style_name = (getattr(paragraph.style, "name", "") or "").lower()
    if "list bullet" in style_name or "项目符号" in style_name:
        return f"- {text}"
    if "list number" in style_name or "编号" in style_name:
        return f"1. {text}"
    return text


def _cell_markdown(cell: _Cell) -> str:
    parts = [paragraph.text.strip() for paragraph in cell.paragraphs if paragraph.text.strip()]
    return "<br>".join(parts).replace("|", r"\|")


def _table_markdown(table: Table) -> str:
    rows = [[_cell_markdown(cell) for cell in row.cells] for row in table.rows]
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    header = rows[0]
    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join(["---"] * width) + " |",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in rows[1:])
    return "\n".join(lines)


def _validate_docx(data: bytes) -> None:
    try:
        with ZipFile(BytesIO(data)) as archive:
            entries = archive.infolist()
            _validate_zip_limits(
                entries,
                max_entries=MAX_DOCX_ENTRIES,
                max_expanded_bytes=MAX_DOCX_EXPANDED_BYTES,
            )
            names = {_safe_archive_name(info).lower() for info in entries}
            required = {"[content_types].xml", "word/document.xml"}
            if not required.issubset(names):
                raise InputError("file is not a valid DOCX document", code="INVALID_DOCX")
            forbidden_prefixes = ("word/activex/", "word/embeddings/")
            if (
                "word/vbaproject.bin" in names
                or any(name.startswith(forbidden_prefixes) for name in names)
            ):
                raise InputError(
                    "DOCX macros, ActiveX, and embedded files are not supported",
                    code="ACTIVE_DOCUMENT",
                )
            content_types = archive.read("[Content_Types].xml")
            if b"macroEnabled".lower() in content_types.lower():
                raise InputError("macro-enabled documents are not supported", code="ACTIVE_DOCUMENT")
            for info in entries:
                name = _safe_archive_name(info).lower()
                if name.endswith((".xml", ".rels")) and info.file_size <= MAX_ENTRY_BYTES:
                    if b"<!DOCTYPE" in archive.read(info).upper():
                        raise InputError("DOCX DTDs are not supported", code="UNSAFE_DOCX")
    except BadZipFile as exc:
        raise InputError("file is not a valid DOCX document", code="INVALID_DOCX") from exc


def docx_to_markdown(data: bytes) -> str:
    _validate_docx(data)
    try:
        document = Document(BytesIO(data))
    except Exception as exc:
        raise InputError("DOCX content could not be parsed", code="INVALID_DOCX") from exc

    blocks: list[str] = []
    body = document.element.body
    for child in body.iterchildren():
        if isinstance(child, CT_P):
            value = _paragraph_markdown(Paragraph(child, document))
        elif isinstance(child, CT_Tbl):
            value = _table_markdown(Table(child, document))
        else:
            continue
        if value:
            blocks.append(value)
    return "\n\n".join(blocks).strip()


def _load_supported_bytes(data: bytes, name: str, *, raw_sha256: str) -> LoadedSource:
    extension = Path(name).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise InputError(
            f"unsupported source type: {extension or '(none)'}",
            code="UNSUPPORTED_SOURCE",
        )
    if len(data) > MAX_SOURCE_BYTES:
        raise InputError("source file exceeds the size limit", code="SOURCE_LIMIT")
    if extension == ".docx":
        text = docx_to_markdown(data)
        media_type = "text/markdown"
    else:
        text = _decode_text(data)
        media_type = "text/markdown" if extension == ".md" else "text/plain"
    if not text.strip():
        raise InputError("source document contains no extractable text", code="EMPTY_SOURCE")
    return LoadedSource(text=text, name=Path(name).name, sha256=raw_sha256, media_type=media_type)


def _load_zip(data: bytes, archive_name: str, *, raw_sha256: str) -> LoadedSource:
    del archive_name
    try:
        with ZipFile(BytesIO(data)) as archive:
            entries = archive.infolist()
            _validate_zip_limits(
                entries,
                max_entries=MAX_ZIP_ENTRIES,
                max_expanded_bytes=MAX_ZIP_EXPANDED_BYTES,
            )
            documents: list[tuple[ZipInfo, str]] = []
            unsupported: list[str] = []
            for info in entries:
                if info.is_dir():
                    continue
                name = _safe_archive_name(info)
                if _is_metadata_file(name):
                    continue
                extension = Path(name).suffix.lower()
                if extension in SUPPORTED_EXTENSIONS:
                    documents.append((info, name))
                else:
                    unsupported.append(name)
            if unsupported:
                raise InputError(
                    "archive must contain only one supported document",
                    code="MULTI_SOURCE_ARCHIVE",
                )
            if len(documents) != 1:
                raise InputError(
                    "archive must contain exactly one supported document",
                    code="MULTI_SOURCE_ARCHIVE",
                )
            info, repaired_name = documents[0]
            nested = archive.read(info)
    except BadZipFile as exc:
        raise InputError("file is not a valid ZIP archive", code="INVALID_ZIP") from exc

    loaded = _load_supported_bytes(nested, repaired_name, raw_sha256=raw_sha256)
    return LoadedSource(
        text=loaded.text,
        name=loaded.name,
        sha256=raw_sha256,
        media_type=loaded.media_type,
    )


def load_source_path(path: str | Path) -> LoadedSource:
    source_path = Path(path)
    try:
        size = source_path.stat().st_size
    except OSError as exc:
        raise InputError("source file could not be read", code="SOURCE_READ_ERROR") from exc
    if not source_path.is_file():
        raise InputError("source path must be a file", code="SOURCE_READ_ERROR")
    if size > MAX_SOURCE_BYTES:
        raise InputError("source file exceeds the size limit", code="SOURCE_LIMIT")
    try:
        data = source_path.read_bytes()
    except OSError as exc:
        raise InputError("source file could not be read", code="SOURCE_READ_ERROR") from exc
    digest = hashlib.sha256(data).hexdigest()
    if source_path.suffix.lower() == ".zip":
        return _load_zip(data, source_path.name, raw_sha256=digest)
    return _load_supported_bytes(data, source_path.name, raw_sha256=digest)


def load_source_text(text: str, name: str = "pasted-text.md") -> LoadedSource:
    if not text.strip():
        raise InputError("source document contains no text", code="EMPTY_SOURCE")
    encoded = text.encode("utf-8")
    if len(encoded) > MAX_SOURCE_BYTES:
        raise InputError("source text exceeds the size limit", code="SOURCE_LIMIT")
    return LoadedSource(
        text=text,
        name=Path(name).name or "pasted-text.md",
        sha256=hashlib.sha256(encoded).hexdigest(),
        media_type="text/markdown" if name.lower().endswith(".md") else "text/plain",
    )
