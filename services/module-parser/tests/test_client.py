from __future__ import annotations

import json

import httpx
import pytest

from coc_module_parser.client import (
    DEEPSEEK_EXTRACTION_PROMPT_VERSION,
    DeepSeekResponsesExtractor,
    EmptyResponseError,
    InvalidStructureError,
    TruncatedResponseError,
)
from coc_module_parser.models import ModuleFragmentV1
from coc_module_parser.text import TextChunk


CHUNK = TextChunk(id="chunk-0001", start=0, end=4, text="test", sha256="0" * 64)


def client_for(body: dict) -> tuple[DeepSeekResponsesExtractor, list[httpx.Request]]:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=body)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    return DeepSeekResponsesExtractor(api_key="not-a-real-key", client=client), requests


def completed(text: str) -> dict:
    return {
        "status": "completed",
        "output": [
            {
                "type": "message",
                "status": "completed",
                "content": [{"type": "output_text", "text": text}],
            }
        ],
    }


def test_responses_api_uses_json_schema_and_parses_fragment() -> None:
    expected = ModuleFragmentV1()
    extractor, requests = client_for(completed(expected.model_dump_json()))
    assert extractor.extract(CHUNK) == expected
    request_body = json.loads(requests[0].content)
    assert request_body["text"]["format"]["type"] == "json_schema"
    assert request_body["text"]["format"]["name"] == "module_fragment_v1"
    assert request_body["model"] == "deepseek-v4-flash"
    assert extractor.extraction_prompt_version == DEEPSEEK_EXTRACTION_PROMPT_VERSION
    assert DEEPSEEK_EXTRACTION_PROMPT_VERSION == "deepseek-fragment-v2-player-safe-clues"
    assert (
        "handout_text only when the source explicitly contains exact player-safe wording"
        in request_body["instructions"]
    )
    assert "not-a-real-key" not in requests[0].content.decode()


@pytest.mark.parametrize(
    ("body", "error"),
    [
        (completed(""), EmptyResponseError),
        (completed('{"schema_version":"1.0"'), TruncatedResponseError),
        (completed("not json"), InvalidStructureError),
        ({"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}, TruncatedResponseError),
    ],
)
def test_empty_truncated_and_invalid_responses_are_typed(body: dict, error: type[Exception]) -> None:
    extractor, _ = client_for(body)
    with pytest.raises(error):
        extractor.extract(CHUNK)
