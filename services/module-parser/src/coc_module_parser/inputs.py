from __future__ import annotations

import hashlib
import base64
import math
import re
import stat
import warnings as python_warnings
from dataclasses import dataclass, replace
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Literal
from zipfile import BadZipFile, ZipFile, ZipInfo

import pypdfium2 as pdfium
from docx import Document
from docx.table import Table, _Cell
from docx.text.paragraph import Paragraph
from docx.text.run import Run
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P
from PIL import Image, UnidentifiedImageError
from pypdf import PdfReader

from .text import normalize_text


SUPPORTED_EXTENSIONS = {".txt", ".md", ".docx", ".pdf"}
SUPPORTED_IMAGE_EXTENSIONS = {
    ".gif": ("GIF", "image/gif"),
    ".jpeg": ("JPEG", "image/jpeg"),
    ".jpg": ("JPEG", "image/jpeg"),
    ".png": ("PNG", "image/png"),
    ".webp": ("WEBP", "image/webp"),
}
MAX_SOURCE_BYTES = 100 * 1024 * 1024
MAX_PDF_SOURCE_BYTES = 500 * 1024 * 1024
MAX_PDF_PAGES = 2_000
MAX_PDF_EXTRACTED_CHARS = 50_000_000
MAX_PDF_RENDERED_PAGES = 256
PDF_LOW_TEXT_CHARS = 80
PDF_RENDER_MAX_EDGE = 3_200
MAX_ZIP_ENTRIES = 2_048
MAX_ZIP_EXPANDED_BYTES = 500 * 1024 * 1024
MAX_DOCX_ENTRIES = 10_000
MAX_DOCX_EXPANDED_BYTES = 500 * 1024 * 1024
MAX_ENTRY_BYTES = 100 * 1024 * 1024
MAX_COMPRESSION_RATIO = 2_000
MAX_IMAGE_EDGE = 8_192
MAX_IMAGE_PIXELS = 32_000_000


class InputError(ValueError):
    """Safe, user-facing input rejection."""

    code = "INVALID_INPUT"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code


@dataclass(frozen=True, slots=True)
class PDFPageMetadata:
    page_number: int
    classification: Literal["digital", "low_text", "scanned"]
    text_char_count: int
    source_start: int
    source_end: int
    text_start: int | None
    text_end: int | None
    needs_vision: bool
    render_status: Literal["not_needed", "rendered", "pending"]
    render_media_type: str | None = None
    render_sha256: str | None = None
    render_byte_length: int | None = None
    render_width: int | None = None
    render_height: int | None = None

    def to_wire(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "pageNumber": self.page_number,
            "classification": self.classification,
            "textCharCount": self.text_char_count,
            "sourceStart": self.source_start,
            "sourceEnd": self.source_end,
            "needsVision": self.needs_vision,
            "renderStatus": self.render_status,
        }
        optional = {
            "textStart": self.text_start,
            "textEnd": self.text_end,
            "renderMediaType": self.render_media_type,
            "renderSha256": self.render_sha256,
            "renderByteLength": self.render_byte_length,
            "renderWidth": self.render_width,
            "renderHeight": self.render_height,
        }
        payload.update({key: value for key, value in optional.items() if value is not None})
        return payload


@dataclass(frozen=True, slots=True)
class SourceAttachmentMetadata:
    """Path-free metadata for a validated archive attachment.

    Attachment bytes and archive member names deliberately remain outside the parser
    request. A later asset importer can identify the member by its content hash.
    """

    sha256: str
    media_type: str
    byte_length: int
    width: int
    height: int

    def to_wire(self) -> dict[str, object]:
        return {
            "kind": "image",
            "sha256": self.sha256,
            "mediaType": self.media_type,
            "byteLength": self.byte_length,
            "width": self.width,
            "height": self.height,
        }


@dataclass(frozen=True, slots=True)
class LoadedSource:
    text: str
    name: str
    sha256: str
    media_type: str
    input_media_type: str | None = None
    pdf_pages: tuple[PDFPageMetadata, ...] = ()
    attachments: tuple[SourceAttachmentMetadata, ...] = ()
    warnings: tuple[str, ...] = ()

    @property
    def is_pdf(self) -> bool:
        return self.input_media_type == "application/pdf"


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
    names: set[str] = set()
    for info in entries:
        name = _safe_archive_name(info)
        normalized_name = name.casefold()
        if normalized_name in names:
            raise InputError("archive contains duplicate paths", code="UNSAFE_ARCHIVE")
        names.add(normalized_name)
        if info.is_dir():
            continue
        total += info.file_size
        if info.file_size > MAX_ENTRY_BYTES or total > max_expanded_bytes:
            raise InputError("archive expands beyond the size limit", code="ARCHIVE_LIMIT")
        if info.file_size and info.compress_size == 0:
            raise InputError("archive entry has an invalid compression size", code="ARCHIVE_LIMIT")
        if info.compress_size and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO:
            raise InputError("archive compression ratio is unsafe", code="ARCHIVE_LIMIT")


def _validate_static_image_attachment(
    data: bytes, extension: str
) -> SourceAttachmentMetadata:
    expected_format, media_type = SUPPORTED_IMAGE_EXTENSIONS[extension]
    try:
        with python_warnings.catch_warnings():
            python_warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                detected_format = (image.format or "").upper()
                width, height = image.size
                frame_count = getattr(image, "n_frames", 1)
                animated = bool(getattr(image, "is_animated", False)) or frame_count != 1
                if detected_format != expected_format:
                    raise InputError(
                        "archive image type does not match its extension",
                        code="UNSAFE_ARCHIVE_IMAGE",
                    )
                if animated:
                    raise InputError(
                        "animated archive images are not supported",
                        code="UNSUPPORTED_ARCHIVE_IMAGE",
                    )
                if (
                    width <= 0
                    or height <= 0
                    or max(width, height) > MAX_IMAGE_EDGE
                    or width * height > MAX_IMAGE_PIXELS
                ):
                    raise InputError(
                        "archive image dimensions exceed the safety limit",
                        code="ARCHIVE_LIMIT",
                    )
                image.verify()

            # verify() checks the container. Decode the sole frame as well so corrupt
            # pixel payloads are rejected before metadata is returned.
            with Image.open(BytesIO(data)) as image:
                image.load()
    except InputError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise InputError(
            "archive image dimensions exceed the safety limit",
            code="ARCHIVE_LIMIT",
        ) from exc
    except (OSError, SyntaxError, UnidentifiedImageError, ValueError) as exc:
        raise InputError(
            "archive contains an invalid image attachment",
            code="UNSAFE_ARCHIVE_IMAGE",
        ) from exc

    return SourceAttachmentMetadata(
        sha256=hashlib.sha256(data).hexdigest(),
        media_type=media_type,
        byte_length=len(data),
        width=width,
        height=height,
    )


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


def _pdf_classification(text: str) -> Literal["digital", "low_text", "scanned"]:
    visible_chars = len(re.sub(r"\s+", "", text))
    if visible_chars == 0:
        return "scanned"
    if visible_chars < PDF_LOW_TEXT_CHARS:
        return "low_text"
    return "digital"


def _render_pdf_page(
    document: pdfium.PdfDocument, page_index: int
) -> tuple[str, int, int, int]:
    """Render one bounded page entirely in memory and return PNG metadata."""

    page = None
    bitmap = None
    image = None
    try:
        page = document[page_index]
        width, height = page.get_size()
        if (
            not math.isfinite(width)
            or not math.isfinite(height)
            or width <= 0
            or height <= 0
        ):
            raise InputError("PDF page has invalid dimensions", code="INVALID_PDF")
        scale = min(4.0, PDF_RENDER_MAX_EDGE / max(width, height))
        if scale <= 0 or not math.isfinite(scale):
            raise InputError("PDF page has invalid dimensions", code="INVALID_PDF")
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil()
        output = BytesIO()
        image.save(output, format="PNG", optimize=True)
        rendered = output.getvalue()
        return (
            hashlib.sha256(rendered).hexdigest(),
            len(rendered),
            image.width,
            image.height,
        )
    except InputError:
        raise
    except Exception as exc:
        raise InputError("PDF page could not be rendered", code="PDF_RENDER_ERROR") from exc
    finally:
        if image is not None:
            image.close()
        if bitmap is not None:
            bitmap.close()
        if page is not None:
            page.close()


def render_pdf_page_selection(
    data: bytes, page_numbers: list[int] | tuple[int, ...]
) -> tuple[dict[str, object], ...]:
    """Render an explicit, bounded 1-based PDF page selection for visual review."""

    if len(data) > MAX_PDF_SOURCE_BYTES:
        raise InputError("PDF exceeds the size limit", code="PDF_SOURCE_LIMIT")
    if not page_numbers or len(page_numbers) > MAX_PDF_RENDERED_PAGES:
        raise InputError("PDF page selection is empty or too large", code="PDF_PAGE_SELECTION")
    if any(isinstance(value, bool) or not isinstance(value, int) for value in page_numbers):
        raise InputError("PDF page numbers must be integers", code="PDF_PAGE_SELECTION")
    if len(set(page_numbers)) != len(page_numbers):
        raise InputError("PDF page selection contains duplicates", code="PDF_PAGE_SELECTION")

    try:
        document = pdfium.PdfDocument(data)
    except Exception as exc:
        raise InputError("file is not a valid PDF document", code="INVALID_PDF") from exc
    try:
        page_count = len(document)
        if page_count == 0:
            raise InputError("PDF contains no pages", code="EMPTY_PDF")
        if page_count > MAX_PDF_PAGES:
            raise InputError("PDF exceeds the page limit", code="PDF_PAGE_LIMIT")
        if any(value < 1 or value > page_count for value in page_numbers):
            raise InputError("PDF page selection is out of range", code="PDF_PAGE_SELECTION")

        rendered_pages: list[dict[str, object]] = []
        for page_number in page_numbers:
            page = bitmap = image = None
            try:
                page = document[page_number - 1]
                width, height = page.get_size()
                if not all(math.isfinite(value) and value > 0 for value in (width, height)):
                    raise InputError("PDF page has invalid dimensions", code="INVALID_PDF")
                scale = min(4.0, PDF_RENDER_MAX_EDGE / max(width, height))
                bitmap = page.render(scale=scale)
                image = bitmap.to_pil()
                output = BytesIO()
                image.save(output, format="PNG", optimize=True)
                rendered = output.getvalue()
                rendered_pages.append(
                    {
                        "pageNumber": page_number,
                        "mediaType": "image/png",
                        "sha256": hashlib.sha256(rendered).hexdigest(),
                        "byteLength": len(rendered),
                        "width": image.width,
                        "height": image.height,
                        "dataBase64": base64.b64encode(rendered).decode("ascii"),
                    }
                )
            except InputError:
                raise
            except Exception as exc:
                raise InputError("PDF page could not be rendered", code="PDF_RENDER_ERROR") from exc
            finally:
                if image is not None:
                    image.close()
                if bitmap is not None:
                    bitmap.close()
                if page is not None:
                    page.close()
        return tuple(rendered_pages)
    finally:
        document.close()


def render_pdf_path_selection(
    path: str | Path, page_numbers: list[int] | tuple[int, ...]
) -> tuple[dict[str, object], ...]:
    source_path = Path(path)
    extension = source_path.suffix.lower()
    if extension not in {".pdf", ".zip"}:
        raise InputError("visual page selection requires a PDF", code="INVALID_SOURCE")
    try:
        size = source_path.stat().st_size
        if not source_path.is_file():
            raise OSError
        size_limit = MAX_PDF_SOURCE_BYTES if extension == ".pdf" else MAX_SOURCE_BYTES
        if size > size_limit:
            raise InputError(
                "PDF exceeds the size limit"
                if extension == ".pdf"
                else "source file exceeds the size limit",
                code="PDF_SOURCE_LIMIT" if extension == ".pdf" else "SOURCE_LIMIT",
            )
        data = source_path.read_bytes()
    except InputError:
        raise
    except OSError as exc:
        raise InputError("source file could not be read", code="SOURCE_READ_ERROR") from exc

    if extension == ".zip":
        docs, _skipped, _attachments = _read_zip_source(data)
        pdf_docs = [
            (nested, name)
            for nested, name in docs
            if Path(name).suffix.lower() == ".pdf"
        ]
        if len(pdf_docs) != 1:
            raise InputError(
                "visual page selection requires exactly one PDF in the archive",
                code="INVALID_SOURCE",
            )
        data = pdf_docs[0][0]
    return render_pdf_page_selection(data, page_numbers)


def inject_pdf_visual_transcripts(
    loaded: LoadedSource,
    transcripts: tuple[dict[str, object], ...] | list[dict[str, object]],
) -> LoadedSource:
    """Attach bounded, page-scoped visual transcripts to normalized PDF text.

    The original PDF text ranges are shifted but otherwise preserved. Model-produced text
    is escaped so it cannot mint another trusted page/vision marker.
    """

    if not loaded.is_pdf:
        raise InputError("visual transcripts require a PDF source", code="INVALID_SOURCE")
    available_pages = {page.page_number for page in loaded.pdf_pages}
    by_page: dict[int, tuple[str, str]] = {}
    for transcript in transcripts:
        if not isinstance(transcript, dict):
            raise InputError("PDF visual transcript is invalid", code="PDF_VISUAL_OUTPUT")
        page_number = transcript.get("pageNumber")
        visible_text = transcript.get("visibleText")
        visual_description = transcript.get("visualDescription")
        if (
            isinstance(page_number, bool)
            or not isinstance(page_number, int)
            or page_number not in available_pages
            or page_number in by_page
            or not isinstance(visible_text, str)
            or not isinstance(visual_description, str)
        ):
            raise InputError("PDF visual transcript is invalid", code="PDF_VISUAL_OUTPUT")

        def safe_text(value: str) -> str:
            return (
                normalize_text(value.replace("\x00", ""))
                .replace("<!--", "&lt;!--")
                .replace("-->", "--&gt;")
            )

        by_page[page_number] = (safe_text(visible_text), safe_text(visual_description))

    pieces: list[str] = []
    updated_pages: list[PDFPageMetadata] = []
    original_cursor = 0
    output_length = 0
    for page in loaded.pdf_pages:
        prefix = loaded.text[original_cursor : page.source_start]
        pieces.append(prefix)
        output_length += len(prefix)
        new_source_start = output_length
        section = loaded.text[page.source_start : page.source_end]
        marker = f"<!-- coc-room-pdf-page:{page.page_number} -->"
        if not section.startswith(marker):
            raise InputError("PDF page metadata is inconsistent", code="INVALID_PDF")
        visual = by_page.get(page.page_number)
        insertion = ""
        if visual is not None:
            visible_text, visual_description = visual
            blocks = [f"<!-- coc-room-pdf-vision:{page.page_number} -->"]
            if visible_text:
                blocks.extend(["[VISIBLE_TEXT]", visible_text])
            if visual_description:
                blocks.extend(["[VISUAL_DESCRIPTION]", visual_description])
            insertion = "\n\n" + "\n\n".join(blocks)
        new_section = marker + insertion + section[len(marker) :]
        pieces.append(new_section)
        output_length += len(new_section)
        insertion_length = len(insertion)
        updated_pages.append(
            replace(
                page,
                source_start=new_source_start,
                source_end=output_length,
                text_start=(
                    new_source_start
                    + (page.text_start - page.source_start)
                    + insertion_length
                    if page.text_start is not None
                    else None
                ),
                text_end=(
                    new_source_start
                    + (page.text_end - page.source_start)
                    + insertion_length
                    if page.text_end is not None
                    else None
                ),
            )
        )
        original_cursor = page.source_end
    pieces.append(loaded.text[original_cursor:])
    augmented = "".join(pieces)
    if len(augmented) > MAX_PDF_EXTRACTED_CHARS:
        raise InputError(
            "PDF visual transcript exceeds the character limit",
            code="PDF_TEXT_LIMIT",
        )
    return replace(loaded, text=augmented, pdf_pages=tuple(updated_pages))


def pdf_to_markdown(data: bytes) -> tuple[str, tuple[PDFPageMetadata, ...]]:
    """Extract bounded page text and identify pages that need later vision processing.

    Low-text pages are rendered in batches of at most four. Only render metadata is
    retained; all page images stay in memory and are released before this function returns.
    """

    if len(data) > MAX_PDF_SOURCE_BYTES:
        raise InputError("PDF exceeds the size limit", code="PDF_SOURCE_LIMIT")
    try:
        reader = PdfReader(BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise InputError("encrypted PDFs are not supported", code="ENCRYPTED_PDF")
        page_count = len(reader.pages)
    except InputError:
        raise
    except Exception as exc:
        raise InputError("file is not a valid PDF document", code="INVALID_PDF") from exc
    if page_count == 0:
        raise InputError("PDF contains no pages", code="EMPTY_PDF")
    if page_count > MAX_PDF_PAGES:
        raise InputError("PDF exceeds the page limit", code="PDF_PAGE_LIMIT")

    extracted_pages: list[str] = []
    total_chars = 0
    try:
        for page in reader.pages:
            extracted = normalize_text(page.extract_text() or "")
            total_chars += len(extracted)
            if total_chars > MAX_PDF_EXTRACTED_CHARS:
                raise InputError(
                    "PDF extracted text exceeds the character limit",
                    code="PDF_TEXT_LIMIT",
                )
            extracted_pages.append(extracted)
    except InputError:
        raise
    except Exception as exc:
        raise InputError("PDF text could not be extracted", code="INVALID_PDF") from exc

    classifications = [_pdf_classification(text) for text in extracted_pages]
    render_candidates = [
        index
        for index, classification in enumerate(classifications)
        if classification != "digital"
    ]
    render_results: dict[int, tuple[str, int, int, int]] = {}
    if render_candidates:
        try:
            document = pdfium.PdfDocument(data)
        except Exception as exc:
            raise InputError("file is not a valid PDF document", code="INVALID_PDF") from exc
        try:
            if len(document) != page_count:
                raise InputError("PDF page index is inconsistent", code="INVALID_PDF")
            for page_index in render_candidates[:MAX_PDF_RENDERED_PAGES]:
                render_results[page_index] = _render_pdf_page(document, page_index)
        finally:
            document.close()

    sections: list[str] = []
    metadata: list[PDFPageMetadata] = []
    cursor = 0
    rendered_indexes = set(render_results)
    candidate_indexes = set(render_candidates)
    for page_index, page_text in enumerate(extracted_pages):
        separator = "\n\n" if sections else ""
        marker = f"<!-- coc-room-pdf-page:{page_index + 1} -->"
        section = marker + (f"\n\n{page_text}" if page_text else "")
        source_start = cursor + len(separator)
        source_end = source_start + len(section)
        text_start = source_start + len(marker) + 2 if page_text else None
        text_end = source_end if page_text else None
        classification = classifications[page_index]
        rendered = render_results.get(page_index)
        if page_index in rendered_indexes:
            render_status: Literal["not_needed", "rendered", "pending"] = "rendered"
        elif page_index in candidate_indexes:
            render_status = "pending"
        else:
            render_status = "not_needed"
        metadata.append(
            PDFPageMetadata(
                page_number=page_index + 1,
                classification=classification,
                text_char_count=len(page_text),
                source_start=source_start,
                source_end=source_end,
                text_start=text_start,
                text_end=text_end,
                needs_vision=classification != "digital",
                render_status=render_status,
                render_media_type="image/png" if rendered else None,
                render_sha256=rendered[0] if rendered else None,
                render_byte_length=rendered[1] if rendered else None,
                render_width=rendered[2] if rendered else None,
                render_height=rendered[3] if rendered else None,
            )
        )
        sections.append(section)
        cursor = source_end
    markdown = "\n\n".join(sections)
    if len(markdown) > MAX_PDF_EXTRACTED_CHARS:
        raise InputError(
            "PDF normalized text exceeds the character limit",
            code="PDF_TEXT_LIMIT",
        )
    return markdown, tuple(metadata)


def _load_supported_bytes(data: bytes, name: str, *, raw_sha256: str) -> LoadedSource:
    extension = Path(name).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise InputError(
            f"unsupported source type: {extension or '(none)'}",
            code="UNSUPPORTED_SOURCE",
        )
    size_limit = MAX_PDF_SOURCE_BYTES if extension == ".pdf" else MAX_SOURCE_BYTES
    if len(data) > size_limit:
        raise InputError(
            "source file exceeds the size limit",
            code="PDF_SOURCE_LIMIT" if extension == ".pdf" else "SOURCE_LIMIT",
        )
    if extension == ".pdf":
        text, pdf_pages = pdf_to_markdown(data)
        media_type = "text/markdown"
    elif extension == ".docx":
        text = docx_to_markdown(data)
        media_type = "text/markdown"
        pdf_pages = ()
    else:
        text = _decode_text(data)
        media_type = "text/markdown" if extension == ".md" else "text/plain"
        pdf_pages = ()
    if not text.strip():
        raise InputError("source document contains no extractable text", code="EMPTY_SOURCE")
    return LoadedSource(
        text=text,
        name=Path(name).name,
        sha256=raw_sha256,
        media_type=media_type,
        input_media_type="application/pdf" if extension == ".pdf" else media_type,
        pdf_pages=pdf_pages,
    )


def _read_zip_source(
    data: bytes,
) -> tuple[
    list[tuple[bytes, str]], tuple[str, ...], tuple[SourceAttachmentMetadata, ...]
]:
    """Return the validated documents, skipped entry names, and attachment metadata.

    Text extraction and bounded PDF page rendering must cross the same archive
    boundary. Keeping that validation here prevents a second path from merely
    opening the first PDF member it happens to find.
    """

    try:
        with ZipFile(BytesIO(data)) as archive:
            entries = archive.infolist()
            _validate_zip_limits(
                entries,
                max_entries=MAX_ZIP_ENTRIES,
                max_expanded_bytes=MAX_ZIP_EXPANDED_BYTES,
            )
            documents: list[tuple[ZipInfo, str]] = []
            images: list[tuple[ZipInfo, str]] = []
            skipped: list[str] = []
            for info in entries:
                if info.is_dir():
                    continue
                name = _safe_archive_name(info)
                if _is_metadata_file(name):
                    continue
                extension = Path(name).suffix.lower()
                if extension in SUPPORTED_EXTENSIONS:
                    documents.append((info, name))
                elif extension in SUPPORTED_IMAGE_EXTENSIONS:
                    images.append((info, extension))
                else:
                    skipped.append(name)
            if not documents:
                raise InputError(
                    "archive contains no supported document",
                    code="EMPTY_ARCHIVE",
                )
            documents.sort(key=lambda item: item[1])
            docs = [(archive.read(info), name) for info, name in documents]
            attachments = tuple(
                _validate_static_image_attachment(archive.read(image_info), extension)
                for image_info, extension in images
            )
    except (BadZipFile, NotImplementedError, RuntimeError) as exc:
        raise InputError("file is not a valid ZIP archive", code="INVALID_ZIP") from exc

    return docs, tuple(skipped), attachments


def _load_zip(data: bytes, archive_name: str, *, raw_sha256: str) -> LoadedSource:
    docs, skipped, attachments = _read_zip_source(data)

    warnings: list[str] = []
    if len(docs) == 1:
        nested, repaired_name = docs[0]
        loaded = _load_supported_bytes(nested, repaired_name, raw_sha256=raw_sha256)
    else:
        parts: list[str] = []
        for nested, name in docs:
            part = _load_supported_bytes(nested, name, raw_sha256=raw_sha256)
            parts.append(f"## {Path(name).name}\n\n{part.text}")
        loaded = LoadedSource(
            text="\n\n---\n\n".join(parts),
            name=Path(archive_name).name,
            sha256=raw_sha256,
            media_type="text/markdown",
            input_media_type="text/markdown",
            pdf_pages=(),
        )
        warnings.append(
            f"Archive contains {len(docs)} documents; their extracted text was "
            "merged in name order. PDF page vision is unavailable for merged archives."
        )
    if skipped:
        warnings.append(
            f"Archive contains {len(skipped)} unsupported file(s); they were skipped."
        )
    if attachments:
        warnings.append(
            f"Archive includes {len(attachments)} validated static image attachment(s); "
            "they were excluded from AI parsing and returned as path-free metadata."
        )
    return replace(
        loaded,
        sha256=raw_sha256,
        attachments=attachments,
        warnings=tuple(warnings),
    )


def load_source_path(path: str | Path) -> LoadedSource:
    source_path = Path(path)
    try:
        size = source_path.stat().st_size
    except OSError as exc:
        raise InputError("source file could not be read", code="SOURCE_READ_ERROR") from exc
    if not source_path.is_file():
        raise InputError("source path must be a file", code="SOURCE_READ_ERROR")
    size_limit = (
        MAX_PDF_SOURCE_BYTES
        if source_path.suffix.lower() == ".pdf"
        else MAX_SOURCE_BYTES
    )
    if size > size_limit:
        raise InputError(
            "source file exceeds the size limit",
            code=(
                "PDF_SOURCE_LIMIT"
                if source_path.suffix.lower() == ".pdf"
                else "SOURCE_LIMIT"
            ),
        )
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
        input_media_type=(
            "text/markdown" if name.lower().endswith(".md") else "text/plain"
        ),
    )
