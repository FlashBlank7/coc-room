# CoC Module Parser Sidecar

Python 3.12 sidecar that converts unstructured CoC scenario text into a validated
`ModulePackageV1` draft. It is intentionally stateless: the desktop process sends a
request over stdin, receives JSON Lines progress/result events on stdout, and owns
storage and credential management.

## Development

```powershell
uv sync --extra dev --python 3.12
uv run pytest
```

The default CLI mode reads the first non-empty JSON line and exits. `--loop` keeps the
process alive and handles lines sequentially until EOF.

```powershell
'{"id":"demo","source_text":"# 雾中车站\n## 月台\n线索：一张旧车票","mock":true}' |
  uv run python -m coc_module_parser
```

The deterministic `mock` path never opens a network connection and is the default for
tests. A real request passes the key only inside stdin JSON:

```json
{
  "id": "parse-1",
  "source_path": "C:\\scenarios\\example.docx",
  "model": "deepseek-v4-flash",
  "api_key": "<provided-at-runtime>",
  "cache_dir": "C:\\Users\\me\\AppData\\Local\\coc-room\\module-cache"
}
```

Never put the key in command-line arguments. The key is held as a Pydantic `SecretStr`,
passed only to the DeepSeek `Authorization` header, excluded from model dumps, and is
not logged, returned, or written to the extraction cache. The Tauri host is responsible
for obtaining it from Windows Credential Manager and clearing its own in-memory copy.

For a local development import, the helper below prompts for the key without echoing it
and writes only the validated module package. The cache contains validated fragments,
never credentials:

```powershell
uv run python scripts/parse_file.py scenario.zip ..\..\local-modules\scenario.cocmod.json `
  --cache-dir ..\..\local-modules\.cache
```

Every output line contains `protocol_version`, `request_id`, and `type`. Parse requests
emit zero or more `progress` events followed by exactly one `result` or `error` event.
The result event exposes a top-level `module` in the exact camelCase shape of
`packages/protocol/src/schemas/module.ts`, plus `normalizedText`, `warnings`, `issues`,
`parseStatus`, and `usage`. Exhausted per-chunk retries produce a valid partial package
with `parseStatus: "needs_review"` and an issue pointing to the failed chunk.

Supported operations are:

- `parse_module` (or omitted `type`): accepts top-level or nested `payload` fields.
- `validate_module`: validates a v1 package.
- `migrate_module`: upgrades the pre-v1 draft shape and validates it.
- `apply_corrections`: deep-merges editor corrections (arrays replace atomically) and
  validates the result.
- `ping`: reports sidecar health and version.

## Input safety and normalization

`source_text` accepts pasted text. `source_path` accepts `.txt`, `.md`, `.docx`, or a
`.zip` containing exactly one supported document. ZIP metadata such as `__MACOSX` and
AppleDouble files is ignored. Archives are rejected for path traversal, symlinks,
encryption, excess expansion/compression ratio, extra payloads, or multiple documents.
Macro-enabled DOCX, VBA projects, ActiveX, embedded objects, DTDs, and malformed Office
packages are rejected.

DOCX headings, paragraphs, list items, and tables are converted in document order to
canonical Markdown. Images are intentionally ignored. UTF-8/UTF-16/GB18030 text is
accepted, then all sources go through Unicode/newline/control-character normalization.

## Workflow and cache

The compiled LangGraph is linear at the document level:

1. normalize text;
2. split at heading/paragraph boundaries with overlap;
3. extract each chunk with the DeepSeek Responses API and a Pydantic-generated JSON
   Schema;
4. resolve/deduplicate references and discard invalid source locations;
5. validate the complete `ModulePackageV1`;
6. summarize issues for editor review.

The extraction Schema preserves location aliases, NPC traits and explicit CoC character
statistics, core-clue flags, and independent player-facing handouts with scene links.
Every one of these entities carries verified source references. Chapters are deliberately
not part of the fragment Schema: chapter grouping is created manually in the editor, so
the parser always returns an empty chapter list instead of inventing a structure.

Empty, incomplete/truncated, invalid JSON, and schema-invalid responses are retried only
for their source chunk. Non-retryable HTTP failures stop that chunk immediately. The
Responses API call is non-streaming and uses `POST /responses`, `text.format.type =
json_schema`, and the configurable model name.

Caching is opt-in through `cache_dir`. Cache identities contain the original source
SHA-256, chunk SHA-256/range and splitting parameters, extractor/model identity, schema
hash, and cache format version. Only already-validated fragments are stored. Credentials
are not accepted by the cache API and cannot become part of either cache keys or values.

Source-reference offsets use Python Unicode code points in the normalized document.
For a development audit of an existing canonical package, run:

```powershell
uv run python scripts/audit_source_refs.py scenario.cocmod.json scenario.zip
```

Add `--fix` to relocate only globally unique excerpt matches and remove every reference
that remains ambiguous or cannot be verified. The report contains paths and offsets but
never copies source excerpts.

## Windows sidecar build

```powershell
.\scripts\build.ps1
```

The script uses Python 3.12, syncs the `dev` dependencies, runs the checked-in
PyInstaller spec, and copies the one-file executable to
`dist/coc-module-parser-x86_64-pc-windows-msvc.exe`, the filename Tauri expects for an
external binary. Build artifacts are not source files and should remain ignored.
