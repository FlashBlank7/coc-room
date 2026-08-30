from __future__ import annotations

from typing import Literal

from pydantic import AliasChoices, ConfigDict, Field, model_validator

from .models import NPCV1, StrictModel


MAX_NPC_CONTEXT_PINS = 12
MAX_NPC_CONTEXT_MESSAGES = 40
MAX_NPC_CONTEXT_MESSAGE_CHARS = 24_000
MAX_NPC_PIN_TOTAL_CHARS = 120_000


class NpcContextPinV1(StrictModel):
    id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(min_length=1, max_length=20_000)


class NpcPanelMessageV1(StrictModel):
    id: str = Field(min_length=1, max_length=128)
    role: Literal["human", "npc"]
    content: str = Field(min_length=1, max_length=100_000)
    sender_label: str | None = Field(
        default=None,
        max_length=200,
        validation_alias=AliasChoices("senderLabel", "sender_label"),
        serialization_alias="senderLabel",
    )


class NpcContextMessageV1(NpcPanelMessageV1):
    truncated_prefix: bool = Field(
        default=False,
        validation_alias=AliasChoices("truncatedPrefix", "truncated_prefix"),
        serialization_alias="truncatedPrefix",
    )


class NpcContextSelectionV1(StrictModel):
    available_message_count: int = Field(
        ge=0,
        validation_alias=AliasChoices("availableMessageCount", "available_message_count"),
        serialization_alias="availableMessageCount",
    )
    selected_message_count: int = Field(
        ge=0,
        le=MAX_NPC_CONTEXT_MESSAGES,
        validation_alias=AliasChoices("selectedMessageCount", "selected_message_count"),
        serialization_alias="selectedMessageCount",
    )
    omitted_message_count: int = Field(
        ge=0,
        validation_alias=AliasChoices("omittedMessageCount", "omitted_message_count"),
        serialization_alias="omittedMessageCount",
    )
    message_char_count: int = Field(
        ge=0,
        le=MAX_NPC_CONTEXT_MESSAGE_CHARS,
        validation_alias=AliasChoices("messageCharCount", "message_char_count"),
        serialization_alias="messageCharCount",
    )
    truncated_newest_message: bool = Field(
        validation_alias=AliasChoices(
            "truncatedNewestMessage", "truncated_newest_message"
        ),
        serialization_alias="truncatedNewestMessage",
    )


class NpcContextWindowV1(StrictModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True, populate_by_name=True)

    npc_card: NPCV1 = Field(
        validation_alias=AliasChoices("npcCard", "npc_card"),
        serialization_alias="npcCard",
    )
    pins: list[NpcContextPinV1] = Field(
        default_factory=list,
        max_length=MAX_NPC_CONTEXT_PINS,
    )
    messages: list[NpcContextMessageV1] = Field(
        default_factory=list,
        max_length=MAX_NPC_CONTEXT_MESSAGES,
    )
    selection: NpcContextSelectionV1


class NpcReplyOutputV1(StrictModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True, populate_by_name=True)

    spoken_text: str = Field(
        min_length=1,
        max_length=4_000,
        validation_alias=AliasChoices("spokenText", "spoken_text"),
        serialization_alias="spokenText",
    )
    stage_direction: str | None = Field(
        default=None,
        max_length=2_000,
        validation_alias=AliasChoices("stageDirection", "stage_direction"),
        serialization_alias="stageDirection",
    )
    emotion: str | None = Field(default=None, max_length=100)


class PrepareNpcReplyTaskV1(StrictModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True, populate_by_name=True)

    provider: Literal["deepseek", "codex"]
    model: str = Field(default="", max_length=100)
    npc_card: NPCV1 = Field(
        validation_alias=AliasChoices("npcCard", "npc_card"),
        serialization_alias="npcCard",
    )
    pins: list[NpcContextPinV1] = Field(
        default_factory=list,
        max_length=MAX_NPC_CONTEXT_PINS,
    )
    messages: list[NpcPanelMessageV1] = Field(default_factory=list, max_length=500)
    mock_response: NpcReplyOutputV1 | None = Field(
        default=None,
        validation_alias=AliasChoices("mockResponse", "mock_response"),
        serialization_alias="mockResponse",
    )

    @model_validator(mode="after")
    def validate_pin_budget(self) -> PrepareNpcReplyTaskV1:
        if sum(len(pin.title) + len(pin.content) for pin in self.pins) > MAX_NPC_PIN_TOTAL_CHARS:
            raise ValueError("pinned context exceeds the character limit")
        return self


def build_npc_context(task: PrepareNpcReplyTaskV1) -> NpcContextWindowV1:
    """Build the only context shape an NPC provider adapter is allowed to receive.

    Messages are considered newest-first but returned in chronological order. Complete
    messages are retained until the 24,000-code-point budget would be exceeded. The only
    partial-message case is a newest message that alone exceeds the budget; its newest
    24,000 code points are retained and explicitly marked as prefix-truncated. Older
    messages are never summarized or backfilled across a skipped message.
    """

    recent = task.messages[-MAX_NPC_CONTEXT_MESSAGES:]
    selected_newest_first: list[NpcContextMessageV1] = []
    remaining = MAX_NPC_CONTEXT_MESSAGE_CHARS
    truncated_newest = False
    for message in reversed(recent):
        content_length = len(message.content)
        if content_length <= remaining:
            selected_newest_first.append(
                NpcContextMessageV1.model_validate(message.model_dump(mode="python"))
            )
            remaining -= content_length
            continue
        if not selected_newest_first and remaining:
            truncated = message.model_dump(mode="python")
            truncated["content"] = message.content[-remaining:]
            truncated["truncated_prefix"] = True
            selected_newest_first.append(
                NpcContextMessageV1.model_validate(truncated)
            )
            remaining = 0
            truncated_newest = True
        break

    selected = list(reversed(selected_newest_first))
    selected_chars = sum(len(message.content) for message in selected)
    return NpcContextWindowV1(
        npc_card=task.npc_card,
        pins=task.pins,
        messages=selected,
        selection=NpcContextSelectionV1(
            available_message_count=len(task.messages),
            selected_message_count=len(selected),
            omitted_message_count=len(task.messages) - len(selected),
            message_char_count=selected_chars,
            truncated_newest_message=truncated_newest,
        ),
    )


def npc_reply_output_schema() -> dict[str, object]:
    """Strict provider output boundary; no room actions or arbitrary fields exist."""

    return NpcReplyOutputV1.model_json_schema(mode="validation", by_alias=True)
