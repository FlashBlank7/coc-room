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
from coc_module_parser.models import (
    CharacterV1,
    ClueV1,
    HandoutV1,
    LocationV1,
    ModuleFragmentV1,
    NPCV1,
    SceneV1,
    SourceRefV1,
)
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
    source_ref = SourceRefV1(
        chunk_id="chunk-0001", start=0, end=4, excerpt="test"
    )
    expected = ModuleFragmentV1(
        scenes=[
            SceneV1(
                id="scene:test",
                title="Scene",
                handout_ids=["handout:test"],
                source_refs=[source_ref],
            )
        ],
        locations=[
            LocationV1(
                id="location:test",
                name="Archive",
                aliases=["Old Library"],
                source_refs=[source_ref],
            )
        ],
        npcs=[
            NPCV1(
                id="npc:test",
                name="Keeper",
                traits=["stern"],
                character=CharacterV1(
                    characteristics={"STR": 60},
                    skills={"Spot Hidden": 55},
                    hit_points=12,
                    sanity=70,
                ),
                source_refs=[source_ref],
            )
        ],
        clues=[
            ClueV1(
                id="clue:test",
                title="Key",
                content="Essential clue",
                is_core=True,
                source_refs=[source_ref],
            )
        ],
        handouts=[
            HandoutV1(
                id="handout:test",
                title="Letter",
                content="Player-facing text",
                scene_ids=["scene:test"],
                source_refs=[source_ref],
            )
        ],
    )
    extractor, requests = client_for(completed(expected.model_dump_json()))
    assert extractor.extract(CHUNK) == expected
    request_body = json.loads(requests[0].content)
    assert request_body["text"]["format"]["type"] == "json_schema"
    assert request_body["text"]["format"]["name"] == "module_fragment_v1"
    assert request_body["model"] == "deepseek-v4-flash"
    assert extractor.extraction_prompt_version == DEEPSEEK_EXTRACTION_PROMPT_VERSION
    assert DEEPSEEK_EXTRACTION_PROMPT_VERSION == "deepseek-fragment-v4-lossless-entities"
    assert "handout_text only for a short exact player-safe clue reveal" in request_body[
        "instructions"
    ]
    assert "independent handouts" in request_body["instructions"]
    assert "Do not create chapters" in request_body["instructions"]
    schema = request_body["text"]["format"]["schema"]
    assert "chapters" not in schema["properties"]
    assert "handouts" in schema["properties"]
    assert "aliases" in schema["$defs"]["LocationV1"]["properties"]
    assert "character" in schema["$defs"]["NPCV1"]["properties"]
    assert "is_core" in schema["$defs"]["ClueV1"]["properties"]
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
