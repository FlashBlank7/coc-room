from __future__ import annotations

import stat
from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

import pytest
from docx import Document
from PIL import Image, PngImagePlugin

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


def make_png(*, embedded_text: str | None = None) -> bytes:
    stream = BytesIO()
    image = Image.new("RGB", (3, 2), "navy")
    metadata = None
    if embedded_text is not None:
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("Description", embedded_text)
    image.save(stream, format="PNG", pnginfo=metadata)
    image.close()
    return stream.getvalue()


def make_animated_gif() -> bytes:
    stream = BytesIO()
    first = Image.new("RGB", (2, 2), "black")
    second = Image.new("RGB", (2, 2), "white")
    first.save(
        stream,
        format="GIF",
        save_all=True,
        append_images=[second],
        duration=100,
        loop=0,
    )
    first.close()
    second.close()
    return stream.getvalue()


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


def test_zip_allows_one_main_document_with_static_image_attachments(
    tmp_path: Path,
) -> None:
    """Synthetic fixture for archives shaped like 寒月-通往天国的终幕曲.zip."""

    path = tmp_path / "synthetic-cold-moon.zip"
    private_marker = "DO-NOT-SEND-ATTACHMENT-CONTENT-OR-PATH-TO-CODEX"
    private_member_name = f"assets/{private_marker}.png"
    write_zip(
        path,
        {
            "module/scenario.md": "# Synthetic module\n\nOnly this text is model input.".encode(),
            private_member_name: make_png(embedded_text=private_marker),
            "assets/npcs/keeper.png": make_png(),
            "assets/maps/finale.png": make_png(),
        },
    )

    loaded = load_source_path(path)

    assert loaded.name == "scenario.md"
    assert loaded.text == "# Synthetic module\n\nOnly this text is model input."
    assert private_marker not in loaded.text
    assert len(loaded.attachments) == 3
    assert all(item.media_type == "image/png" for item in loaded.attachments)
    assert all(item.width == 3 and item.height == 2 for item in loaded.attachments)
    assert all(len(item.sha256) == 64 for item in loaded.attachments)
    assert len(loaded.warnings) == 1
    assert "3 validated static image attachment(s)" in loaded.warnings[0]

    # Neither archive member names nor embedded image text cross the parser boundary.
    exposed_metadata = repr(
        {
            "warnings": loaded.warnings,
            "attachments": [item.to_wire() for item in loaded.attachments],
        }
    )
    assert private_marker not in exposed_metadata
    assert "assets/" not in exposed_metadata


@pytest.mark.parametrize("entry_name", ["assets/map.svg", "notes/readme.json"])
def test_zip_rejects_svg_and_unknown_attachments(
    tmp_path: Path, entry_name: str
) -> None:
    path = tmp_path / "unsupported.zip"
    write_zip(path, {"scenario.md": b"# module", entry_name: b"not accepted"})

    with pytest.raises(InputError) as caught:
        load_source_path(path)

    assert caught.value.code == "UNSUPPORTED_ARCHIVE_ENTRY"


def test_zip_rejects_animated_image_attachment(tmp_path: Path) -> None:
    path = tmp_path / "animated.zip"
    write_zip(
        path,
        {"scenario.md": b"# module", "assets/blinking.gif": make_animated_gif()},
    )

    with pytest.raises(InputError) as caught:
        load_source_path(path)

    assert caught.value.code == "UNSUPPORTED_ARCHIVE_IMAGE"


def test_zip_rejects_image_with_mismatched_extension(tmp_path: Path) -> None:
    path = tmp_path / "spoofed.zip"
    write_zip(path, {"scenario.md": b"# module", "assets/map.jpg": make_png()})

    with pytest.raises(InputError) as caught:
        load_source_path(path)

    assert caught.value.code == "UNSAFE_ARCHIVE_IMAGE"


def test_zip_rejects_high_compression_ratio_before_image_decode(tmp_path: Path) -> None:
    path = tmp_path / "bomb.zip"
    write_zip(
        path,
        {"scenario.md": b"# module", "assets/map.png": b"\x00" * 1_000_000},
    )

    with pytest.raises(InputError) as caught:
        load_source_path(path)

    assert caught.value.code == "ARCHIVE_LIMIT"


def test_zip_rejects_symlink_attachment(tmp_path: Path) -> None:
    path = tmp_path / "symlink.zip"
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("scenario.md", b"# module")
        link = ZipInfo("assets/cover.png")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(link, b"target.png")

    with pytest.raises(InputError) as caught:
        load_source_path(path)

    assert caught.value.code == "UNSAFE_ARCHIVE"


def test_zip_rejects_encrypted_entry_flag(tmp_path: Path) -> None:
    path = tmp_path / "encrypted.zip"
    write_zip(path, {"scenario.md": b"# module", "assets/cover.png": make_png()})

    payload = bytearray(path.read_bytes())
    for signature, flag_offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        cursor = 0
        while (position := payload.find(signature, cursor)) != -1:
            flags_at = position + flag_offset
            flags = int.from_bytes(payload[flags_at : flags_at + 2], "little") | 0x1
            payload[flags_at : flags_at + 2] = flags.to_bytes(2, "little")
            cursor = flags_at + 2
    path.write_bytes(payload)

    with pytest.raises(InputError) as caught:
        load_source_path(path)

    assert caught.value.code == "UNSAFE_ARCHIVE"


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
