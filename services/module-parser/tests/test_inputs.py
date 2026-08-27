from __future__ import annotations

from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from docx import Document

from coc_module_parser.inputs import InputError, docx_to_markdown, load_source_path


def make_docx() -> bytes:
    stream = BytesIO()
    document = Document()
    document.add_heading("雾中车站", level=1)
    document.add_paragraph("调查员在雨夜抵达。")
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "姓名"
    table.cell(0, 1).text = "身份"
    table.cell(1, 0).text = "林"
    table.cell(1, 1).text = "站长"
    document.save(stream)
    return stream.getvalue()


def write_zip(path: Path, entries: dict[str, bytes]) -> None:
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)


def test_docx_to_markdown_preserves_heading_paragraph_and_table() -> None:
    markdown = docx_to_markdown(make_docx())
    assert "# 雾中车站" in markdown
    assert "调查员在雨夜抵达。" in markdown
    assert "| 姓名 | 身份 |" in markdown
    assert "| 林 | 站长 |" in markdown


def test_zip_allows_one_document_and_ignores_macos_metadata(tmp_path: Path) -> None:
    path = tmp_path / "module.zip"
    write_zip(
        path,
        {
            "scenario.docx": make_docx(),
            "__MACOSX/._scenario.docx": b"metadata",
        },
    )
    loaded = load_source_path(path)
    assert loaded.name == "scenario.docx"
    assert "雾中车站" in loaded.text
    assert len(loaded.sha256) == 64


def test_zip_rejects_path_traversal(tmp_path: Path) -> None:
    path = tmp_path / "bad.zip"
    write_zip(path, {"../scenario.md": b"# no"})
    with pytest.raises(InputError) as caught:
        load_source_path(path)
    assert caught.value.code == "UNSAFE_ARCHIVE"


def test_zip_rejects_multiple_documents(tmp_path: Path) -> None:
    path = tmp_path / "many.zip"
    write_zip(path, {"one.md": b"# one", "two.txt": b"two"})
    with pytest.raises(InputError) as caught:
        load_source_path(path)
    assert caught.value.code == "MULTI_SOURCE_ARCHIVE"


def test_docx_rejects_macro_payload() -> None:
    stream = BytesIO()
    with ZipFile(stream, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types />")
        archive.writestr("word/document.xml", "<document />")
        archive.writestr("word/vbaProject.bin", b"macro")
    with pytest.raises(InputError) as caught:
        docx_to_markdown(stream.getvalue())
    assert caught.value.code == "ACTIVE_DOCUMENT"
