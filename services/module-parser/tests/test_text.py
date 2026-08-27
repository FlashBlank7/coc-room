from coc_module_parser.text import normalize_text, segment_text


def test_normalize_text_normalizes_newlines_controls_and_blank_runs() -> None:
    assert normalize_text("\ufeffA\r\n\x00B\n\n\n\nC  \r") == "A\nB\n\n\nC"


def test_segment_text_is_stable_and_bounded() -> None:
    text = "\n\n".join(f"## Scene {index}\n" + ("x" * 700) for index in range(5))
    chunks = segment_text(text, max_chars=1_200, overlap_chars=100)
    assert len(chunks) > 1
    assert all(len(chunk.text) <= 1_200 for chunk in chunks)
    assert [chunk.id for chunk in chunks] == [
        f"chunk-{index:04d}" for index in range(1, len(chunks) + 1)
    ]
    assert chunks[-1].end == len(text)
