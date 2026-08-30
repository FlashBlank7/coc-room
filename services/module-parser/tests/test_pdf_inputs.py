from __future__ import annotations

import io
import json
import base64
from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from coc_module_parser import inputs
from coc_module_parser import cli as parser_cli
from coc_module_parser.cli import run_stream
from coc_module_parser.inputs import (
    InputError,
    inject_pdf_visual_transcripts,
    load_source_path,
)
from coc_module_parser.models import ModuleFragmentV1, ParseConfig


def _add_page(writer: PdfWriter, text: str | None = None) -> None:
    page = writer.add_blank_page(width=612, height=792)
    if text is None:
        return
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_ref = writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject(
        {
            NameObject("/Font"): DictionaryObject(
                {NameObject("/F1"): font_ref}
            )
        }
    )
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = DecodedStreamObject()
    stream.set_data(f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(stream)


def _pdf_bytes(*page_texts: str | None, password: str | None = None) -> bytes:
    writer = PdfWriter()
    for text in page_texts:
        _add_page(writer, text)
    if password is not None:
        writer.encrypt(password)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def _write(path: Path, data: bytes) -> Path:
    path.write_bytes(data)
    return path


def test_digital_pdf_text_keeps_page_source_range(tmp_path: Path) -> None:
    text = "Keeper module text with enough visible characters for digital extraction. " * 3
    loaded = load_source_path(_write(tmp_path / "digital.pdf", _pdf_bytes(text)))

    assert loaded.is_pdf
    assert loaded.media_type == "text/markdown"
    assert "<!-- coc-room-pdf-page:1 -->" in loaded.text
    page = loaded.pdf_pages[0]
    assert page.classification == "digital"
    assert page.render_status == "not_needed"
    assert page.text_start is not None and page.text_end is not None
    assert loaded.text[page.text_start : page.text_end] == text.strip()


def test_scanned_pdf_page_is_rendered_to_bounded_png_metadata(tmp_path: Path) -> None:
    loaded = load_source_path(_write(tmp_path / "scan.pdf", _pdf_bytes(None)))

    page = loaded.pdf_pages[0]
    assert page.classification == "scanned"
    assert page.needs_vision is True
    assert page.render_status == "rendered"
    assert page.render_media_type == "image/png"
    assert page.render_sha256 is not None and len(page.render_sha256) == 64
    assert page.render_byte_length is not None and page.render_byte_length > 0
    assert page.render_width is not None and page.render_width <= inputs.PDF_RENDER_MAX_EDGE
    assert page.render_height is not None and page.render_height <= inputs.PDF_RENDER_MAX_EDGE


def test_mixed_pdf_distinguishes_digital_low_text_and_scanned_pages(
    tmp_path: Path,
) -> None:
    digital = "A sufficiently long digital page used by the existing source offset flow. " * 3
    loaded = load_source_path(
        _write(tmp_path / "mixed.pdf", _pdf_bytes(digital, "short", None))
    )

    assert [page.classification for page in loaded.pdf_pages] == [
        "digital",
        "low_text",
        "scanned",
    ]
    assert [page.render_status for page in loaded.pdf_pages] == [
        "not_needed",
        "rendered",
        "rendered",
    ]
    assert [page.page_number for page in loaded.pdf_pages] == [1, 2, 3]
    assert all(
        page.source_end <= next_page.source_start
        for page, next_page in zip(loaded.pdf_pages, loaded.pdf_pages[1:])
    )


def test_pdf_rendering_covers_all_low_text_pages(tmp_path: Path) -> None:
    loaded = load_source_path(
        _write(tmp_path / "batch.pdf", _pdf_bytes(*([None] * 6)))
    )
    assert [page.render_status for page in loaded.pdf_pages] == ["rendered"] * 6


def test_explicit_pdf_visual_page_selection_returns_requested_pngs(tmp_path: Path) -> None:
    path = _write(tmp_path / "visual.pdf", _pdf_bytes(None, None, None))
    output = io.StringIO()
    request = {
        "id": "visual-pages",
        "type": "render_pdf_pages",
        "source_path": str(path),
        "page_numbers": [3, 1],
    }

    assert run_stream(io.StringIO(json.dumps(request) + "\n"), output) == 0
    event = json.loads(output.getvalue())
    assert event["type"] == "result"
    assert [page["pageNumber"] for page in event["pages"]] == [3, 1]
    for page in event["pages"]:
        rendered = base64.b64decode(page["dataBase64"], validate=True)
        assert rendered.startswith(b"\x89PNG\r\n\x1a\n")
        assert len(rendered) == page["byteLength"]
        assert page["width"] <= inputs.PDF_RENDER_MAX_EDGE
        assert page["height"] <= inputs.PDF_RENDER_MAX_EDGE


def test_pdf_visual_page_selection_reads_the_validated_document_inside_a_safe_zip(
    tmp_path: Path,
) -> None:
    path = tmp_path / "module-with-handouts.zip"
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("module/scenario.pdf", _pdf_bytes(None, None))

    loaded = load_source_path(path)
    rendered = inputs.render_pdf_path_selection(path, [2])

    assert loaded.is_pdf is True
    assert loaded.name == "scenario.pdf"
    assert len(rendered) == 1
    assert rendered[0]["pageNumber"] == 2
    assert base64.b64decode(str(rendered[0]["dataBase64"]), validate=True).startswith(
        b"\x89PNG\r\n\x1a\n"
    )


@pytest.mark.parametrize("selection", [[], [1, 1], [0], [1, 2, 3, 4, 5], [True]])
def test_explicit_pdf_visual_page_selection_rejects_invalid_pages(
    tmp_path: Path, selection: list[object]
) -> None:
    path = _write(tmp_path / "visual.pdf", _pdf_bytes(None, None))
    output = io.StringIO()
    request = {
        "id": "bad-visual-pages",
        "type": "render_pdf_pages",
        "source_path": str(path),
        "page_numbers": selection,
    }

    run_stream(io.StringIO(json.dumps(request) + "\n"), output)
    event = json.loads(output.getvalue())
    assert event["type"] == "error"
    assert event["error"]["code"] == "PDF_PAGE_SELECTION"


def test_encrypted_pdf_is_rejected(tmp_path: Path) -> None:
    path = _write(tmp_path / "encrypted.pdf", _pdf_bytes("secret", password="pw"))
    with pytest.raises(InputError) as caught:
        load_source_path(path)
    assert caught.value.code == "ENCRYPTED_PDF"


def test_pdf_page_limit_is_enforced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(inputs, "MAX_PDF_PAGES", 2)
    path = _write(tmp_path / "too-many.pdf", _pdf_bytes(*([None] * 3)))
    with pytest.raises(InputError) as caught:
        load_source_path(path)
    assert caught.value.code == "PDF_PAGE_LIMIT"


def test_pdf_byte_limit_is_checked_before_reading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = _pdf_bytes(None)
    monkeypatch.setattr(inputs, "MAX_PDF_SOURCE_BYTES", len(data) - 1)
    path = _write(tmp_path / "too-large.pdf", data)
    with pytest.raises(InputError) as caught:
        load_source_path(path)
    assert caught.value.code == "PDF_SOURCE_LIMIT"


def test_pdf_jsonl_result_exposes_page_metadata_for_source_ref_mapping(
    tmp_path: Path,
) -> None:
    text = "A digital module page with enough characters to avoid image rendering. " * 3
    path = _write(tmp_path / "module.pdf", _pdf_bytes(text, None))
    output = io.StringIO()
    request = {
        "id": "pdf",
        "type": "parse_module",
        "source_path": str(path),
        "provider": "codex",
        "mock": True,
    }

    assert run_stream(io.StringIO(json.dumps(request) + "\n"), output) == 0
    event = json.loads(output.getvalue().splitlines()[-1])
    assert event["type"] == "result"
    assert event["sourceInputMediaType"] == "application/pdf"
    assert [page["pageNumber"] for page in event["sourcePages"]] == [1, 2]
    assert event["sourcePages"][0]["sourceEnd"] <= event["sourcePages"][1]["sourceStart"]
    assert "coc-room-pdf-page" not in event["module"]["overview"]
    assert "coc-room-pdf-page" not in event["module"]["metadata"]["summary"]


def test_pdf_jsonl_route_parses_with_any_provider_using_extracted_text(
    tmp_path: Path,
) -> None:
    text = "A digital module page with enough characters to avoid image rendering. " * 3
    path = _write(tmp_path / "module.pdf", _pdf_bytes(text))
    output = io.StringIO()
    request = {
        "id": "pdf",
        "type": "parse_module",
        "source_path": str(path),
        "provider": "deepseek",
        "mock": True,
    }

    assert run_stream(io.StringIO(json.dumps(request) + "\n"), output) == 0
    event = json.loads(output.getvalue().splitlines()[-1])
    assert event["type"] == "result"
    assert event["sourceInputMediaType"] == "application/pdf"
    assert [page["pageNumber"] for page in event["sourcePages"]] == [1]


def test_auto_vision_selection_returns_all_needs_vision_pages(tmp_path: Path) -> None:
    loaded = load_source_path(
        _write(tmp_path / "scans.pdf", _pdf_bytes(*([None] * 6)))
    )
    config = ParseConfig(source_text=loaded.text, provider="codex", model="")

    selected = parser_cli._pdf_visual_page_numbers({}, config, loaded)

    assert selected == (1, 2, 3, 4, 5, 6)


def test_visual_transcripts_are_page_scoped_and_keep_text_ranges_valid(
    tmp_path: Path,
) -> None:
    first_text = "First digital page text remains source-addressable. " * 3
    second_text = "Second digital page text remains source-addressable. " * 3
    loaded = load_source_path(
        _write(tmp_path / "visual.pdf", _pdf_bytes(first_text, second_text))
    )

    augmented = inject_pdf_visual_transcripts(
        loaded,
        [
            {
                "pageNumber": 1,
                "visibleText": "Handwritten clue <!-- coc-room-pdf-page:99 -->",
                "visualDescription": "A floor plan with a sealed eastern door.",
            }
        ],
    )

    assert "<!-- coc-room-pdf-vision:1 -->" in augmented.text
    assert "<!-- coc-room-pdf-page:99 -->" not in augmented.text
    assert "&lt;!-- coc-room-pdf-page:99 --&gt;" in augmented.text
    assert [page.page_number for page in augmented.pdf_pages] == [1, 2]
    first_page, second_page = augmented.pdf_pages
    assert augmented.text[first_page.text_start : first_page.text_end] == first_text.strip()
    assert augmented.text[second_page.text_start : second_page.text_end] == second_text.strip()
    assert first_page.source_end <= second_page.source_start


def test_pdf_parse_routes_selected_pages_through_codex_vision_before_extraction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _write(tmp_path / "scan.pdf", _pdf_bytes(None))
    captured: dict[str, object] = {}

    class FakeCodexExtractor:
        name = "fake-codex"
        model = "codex-default"
        extraction_prompt_version = "test"
        cacheable = False
        max_output_tokens = 16_000

        def __init__(self, **kwargs: object) -> None:
            captured["constructor"] = kwargs

        @staticmethod
        def output_schema() -> dict[str, object]:
            return ModuleFragmentV1.model_json_schema(mode="validation")

        def extract_pdf_visual_pages(
            self, pages: tuple[dict[str, object], ...]
        ) -> tuple[dict[str, object], ...]:
            captured["rendered_pages"] = pages
            return (
                {
                    "pageNumber": 1,
                    "visibleText": "The readable title",
                    "visualDescription": "A hand-drawn mansion plan",
                },
            )

        def extract(self, _chunk: object, **_kwargs: object) -> ModuleFragmentV1:
            return ModuleFragmentV1()

    monkeypatch.setattr(parser_cli, "CodexCliExtractor", FakeCodexExtractor)
    output = io.StringIO()
    request = {
        "id": "pdf-vision",
        "type": "parse_module",
        "source_path": str(path),
        "provider": "codex",
        "model": "",
        "codex_executable": "codex-test-double",
        "pdf_visual_page_numbers": [1],
    }

    assert run_stream(io.StringIO(json.dumps(request) + "\n"), output) == 0
    event = json.loads(output.getvalue().splitlines()[-1])
    assert event["type"] == "result"
    assert event["visualPages"][0] == {
        "pageNumber": 1,
        "visibleText": "The readable title",
        "visualDescription": "A hand-drawn mansion plan",
        "sha256": captured["rendered_pages"][0]["sha256"],
        "byteLength": captured["rendered_pages"][0]["byteLength"],
        "width": captured["rendered_pages"][0]["width"],
        "height": captured["rendered_pages"][0]["height"],
    }
    assert "<!-- coc-room-pdf-vision:1 -->" in event["normalizedText"]
    assert "The readable title" in event["normalizedText"]
