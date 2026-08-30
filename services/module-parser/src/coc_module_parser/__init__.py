"""CoC module parser sidecar."""

from .canonical import CanonicalModulePackageV1, to_canonical_package
from .character_provider import (
    Coc7CharacterWireV1,
    GenerateCharacterDraftTaskV1,
    generate_character_draft,
)
from .models import ModulePackageV1, ParseIssueV1, ParseResultV1
from .npc_context import (
    NpcContextWindowV1,
    NpcReplyOutputV1,
    PrepareNpcReplyTaskV1,
    build_npc_context,
)
from .npc_provider import GenerateNpcReplyTaskV1, generate_npc_reply
from .npc_stats_provider import GenerateNpcStatsDraftTaskV1, generate_npc_stats_draft
from .workflow import ModuleParser, ParseConfig

__all__ = [
    "ModulePackageV1",
    "CanonicalModulePackageV1",
    "Coc7CharacterWireV1",
    "GenerateCharacterDraftTaskV1",
    "GenerateNpcReplyTaskV1",
    "GenerateNpcStatsDraftTaskV1",
    "ModuleParser",
    "ParseConfig",
    "ParseIssueV1",
    "ParseResultV1",
    "NpcContextWindowV1",
    "NpcReplyOutputV1",
    "PrepareNpcReplyTaskV1",
    "build_npc_context",
    "generate_character_draft",
    "generate_npc_reply",
    "generate_npc_stats_draft",
    "to_canonical_package",
]

__version__ = "0.1.0"
