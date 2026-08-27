"""CoC module parser sidecar."""

from .canonical import CanonicalModulePackageV1, to_canonical_package
from .models import ModulePackageV1, ParseIssueV1, ParseResultV1
from .workflow import ModuleParser, ParseConfig

__all__ = [
    "ModulePackageV1",
    "CanonicalModulePackageV1",
    "ModuleParser",
    "ParseConfig",
    "ParseIssueV1",
    "ParseResultV1",
    "to_canonical_package",
]

__version__ = "0.1.0"
