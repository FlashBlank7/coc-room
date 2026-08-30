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
tests. The desktop and `parse_file.py` default real provider invoke the locally installed,
user-authenticated Codex CLI through its supported non-interactive mode. The adapter does
not read or copy Codex credentials and does not open an HTTP proxy:

```json
{
  "id": "parse-codex",
  "source_path": "C:\\scenarios\\example.docx",
  "provider": "codex",
  "model": "gpt-5.6-luna",
  "codex_executable": "C:\\path\\to\\codex.exe",
  "codex_timeout_seconds": 900,
  "codex_heartbeat_seconds": 15,
  "cache_dir": "C:\\Users\\me\\AppData\\Local\\coc-room\\module-cache"
}
```

An empty Codex model uses the CLI build's built-in default and deliberately disables the
persistent extraction cache, because that default may be rerouted without a local version
change. Set an explicit model to enable reproducible cache reuse. The adapter uses an isolated
temporary working directory, ignores user config and rules, enables the read-only sandbox,
disables shell/unified execution and web search, passes source text only through stdin,
and runs ephemerally. Entity extraction uses a deliberately small strict transport Schema
(`payload_json` only); the complete machine-owned target Schema travels in the same stdin
request, and the decoded inner object must still pass duplicate-key checks and the full
Pydantic model before it can enter a draft or cache. PDF visual transcription keeps its
separate small direct Schema.
Inference still happens through OpenAI; this is not an offline model. Read-only sandboxing
prevents writes but is not a strict allowlist for every readable file on the machine.
See the official [Codex non-interactive mode documentation](https://developers.openai.com/codex/non-interactive-mode).

Each Codex call defaults to a 900-second timeout and accepts 30–1,800 seconds; heartbeat
intervals default to 15 seconds and accept 5–60 seconds. The JSONL sidecar emits safe
`codex_started`, `codex_waiting`, `codex_completed`, or `codex_timed_out` progress details,
plus the safe CLI phase (`starting`, `connected`, `generating`, `reported_error`, `completed`,
or `failed`), without forwarding model text or provider error text. The documented generic
`error` event is non-terminal and is not assumed to mean a network failure. If no subsequent
event arrives for 45 seconds, or repeated generic errors continue for 120 seconds without a
normal turn/item event, the child is killed and reaped as `CODEX_CLI_STALLED`. A terminal
`turn.failed` is always preferred over timeout or
exit-code classification and stopped promptly. Completed `codex exec --json` turns contribute the available
input, cache, output, and reasoning token counts to the final `usage` object. A host should
treat heartbeats as activity and keep an independent cancelable total-job limit. Sequential
multi-chunk parses in the Vite development bridge have a fixed 45-minute total-job limit and
a 60-second idle limit. Every valid, request-bound JSONL heartbeat resets only the idle timer;
the browser cannot configure either deadline. Aborting or disconnecting the HTTP client kills
the Python/Codex process tree before the bridge removes its per-request temporary files.

DeepSeek remains an explicit fallback. Its key is passed only inside stdin JSON:

```json
{
  "id": "parse-1",
  "source_path": "C:\\scenarios\\example.docx",
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "api_key": "<provided-at-runtime>",
  "cache_dir": "C:\\Users\\me\\AppData\\Local\\coc-room\\module-cache"
}
```

Never put the key in command-line arguments. The key is held as a Pydantic `SecretStr`,
passed only to the DeepSeek `Authorization` header, excluded from model dumps, and is
not logged, returned, or written to the extraction cache. The Tauri host, or the one-shot
development wrapper described below, obtains it from Windows Credential Manager and clears
its own in-memory copy.

During `pnpm dev`, Vite's same-origin development bridge starts
`scripts/dev_bridge_sidecar.py` as a one-shot wrapper around this same protocol. The wrapper
accepts only module parsing, bounded PDF page rendering, character drafts, NPC statistics
drafts, and bounded-context NPC replies. It verifies every file path is below the bridge-owned
temporary directory, discovers the Codex executable itself, and reads the DeepSeek keyring
entry directly. Browser requests cannot supply an operation name, `api_key`, `source_path`,
`base_url`, `codex_executable`, commands, timeouts, or tool configuration. The three short AI
routes have a fixed 120-second lifetime, bounded output, and exactly one terminal JSONL event.
Use `pnpm ai:key:set` from the repository root to populate the Windows credential through
hidden terminal input.

Each Vite server process also creates a fresh 256-bit development-session capability. Vite
injects it only into that process's development HTML and the browser returns it in a custom
request header. The capability is never placed in a URL, cookie, persistent browser storage,
production build, or log; restarting Vite invalidates every previously opened page.

For a local Codex development import, sign in with `codex login`, then run:

```powershell
uv run python scripts/parse_file.py scenario.zip ..\..\local-modules\scenario.cocmod.json `
  --provider codex --model gpt-5.6-luna --max-retries 0 `
  --max-chunk-chars 6000 --chunk-overlap-chars 250 `
  --codex-timeout-seconds 900 --cache-dir ..\..\local-modules\.cache
```

Before a large import, the production first-chunk probe runs the same 6,000-character
chunk through both strict Codex stages and writes their validated values to the same cache
identities used by the full command. It never writes a module file:

```powershell
uv run python scripts/parse_file.py scenario.zip --probe-first-chunk `
  --provider codex --model gpt-5.6-luna --max-retries 0 `
  --max-chunk-chars 6000 --chunk-overlap-chars 250 `
  --codex-timeout-seconds 900 --cache-dir ..\..\local-modules\.cache
```

Re-run the full command above after a successful probe; its first World and Evidence calls
are cache hits. If a live run stops on timeout or its call limit without producing any
validated fragment, `parse_file.py` exits nonzero and does not create or replace the output.

For DeepSeek, add `--provider deepseek --model deepseek-v4-flash`; the helper prompts for
the key without echoing it. The cache contains validated fragments, never credentials:

```powershell
uv run python scripts/parse_file.py scenario.zip ..\..\local-modules\scenario.cocmod.json `
  --provider deepseek --model deepseek-v4-flash --cache-dir ..\..\local-modules\.cache
```

Every output line contains `protocol_version`, `request_id`, and `type`. Parse requests
emit zero or more `progress` events followed by exactly one `result` or `error` event.
Long Codex chunks emit periodic waiting heartbeats, so a UI can distinguish active inference
from a dead sidecar. Chunk completion events include usage when the CLI reported it.
The result event exposes a top-level `module` in the exact camelCase shape of
`packages/protocol/src/schemas/module.ts`, plus `normalizedText`, `warnings`, `issues`,
`parseStatus`, and `usage`. Exhausted per-chunk retries produce a valid partial package
with `parseStatus: "needs_review"` and an issue pointing to the failed chunk.

Supported operations are:

- `parse_module` (or omitted `type`): accepts top-level or nested `payload` fields.
- `prepare_npc_reply`: validates an NPC-only interaction task, builds its bounded context,
  returns the strict reply Schema, and optionally validates `mockResponse`. This foundation
  operation never calls a provider. `npc_reply_context` is an equivalent route name.
- `generate_npc_reply`: generates exactly one bounded NPC reply through DeepSeek Responses
  or the locally authenticated Codex CLI. `run_npc_reply` is an equivalent route name. The
  provider input contains only `npcCard`, `pins`, and the already-trimmed `messages`; the
  result contains the fixed reply plus non-content context-window counts.
- `generate_character_draft`: accepts a provider/model, one bounded natural-language
  `prompt`, `playerName`, and `ownerSeatId` (plus the in-memory DeepSeek credential when
  applicable). It rejects room/module/file/tool/network configuration, sends only the prompt
  and player name to the provider, and returns a complete protocol-shaped CoC 7e character
  draft. `character_draft` is an equivalent route name.
- `validate_module`: validates a v1 package.
- `migrate_module`: upgrades the pre-v1 draft shape and validates it.
- `apply_corrections`: deep-merges editor corrections (arrays replace atomically) and
  validates the result.
- `ping`: reports sidecar health and version.
- `render_pdf_pages`: renders an explicit selection of 1–4 one-based PDF page numbers to
  bounded PNG results (`dataBase64`, SHA-256, byte length, width, and height) for a visual
  page picker. It accepts a direct PDF or the single PDF document inside the same validated
  ZIP shape used by extraction; it never opens an arbitrary archive member. Duplicate,
  out-of-range, empty, and oversized selections are rejected.

## Input safety and normalization

`source_text` accepts pasted text. `source_path` accepts `.txt`, `.md`, `.docx`, `.pdf`, or a
`.zip` containing exactly one supported document plus bounded static PNG/JPEG/WebP image
attachments. Attachment bytes are not sent to the text extractor; the result exposes only
validated metadata in `sourceAttachments`. ZIP metadata such as `__MACOSX` and AppleDouble
files is ignored. Archives are rejected for path traversal, symlinks, encryption, excess
expansion/compression ratio, unsupported payloads, or multiple documents.
Macro-enabled DOCX, VBA projects, ActiveX, embedded objects, DTDs, and malformed Office
packages are rejected.

PDF input is Codex-only, capped at 50 MiB and 300 pages, and rejects encrypted or malformed
documents. `pypdf` extracts digital text into the same normalized character-offset flow used
by other inputs. Every page receives a stable marker and a `sourcePages` range in the JSONL
result so source references can be mapped back to page numbers. Pages with fewer than 80
non-whitespace characters are marked `low_text` or `scanned`; at most four such pages per
load are rendered to bounded 1600-pixel PNG metadata with PDFium, with later pages marked
`pending`. A live Codex parse accepts an explicit 1–4 page selection, or defaults to the
first four pages that need vision. The sidecar re-renders those pages from the authorized
PDF (including a PDF selected through a validated single-document ZIP), verifies each PNG
descriptor and hash, writes only temporary image files, and attaches them to a separate
tool-disabled `codex exec` call with a strict page-transcript schema. The
bounded transcript is escaped, tagged with its page number, and inserted into normalized
text before structured extraction; `visualPages` reports what was used. Temporary PNGs are
deleted with the isolated execution directory. Mock parsing never invokes this vision path.

DOCX headings, paragraphs, list items, and tables are converted in document order to
canonical Markdown. Images are intentionally ignored. UTF-8/UTF-16/GB18030 text is
accepted, then all sources go through Unicode/newline/control-character normalization.

## Bounded NPC interaction context

`prepare_npc_reply` accepts only one NPC card, up to 12 explicitly mounted pins, current
panel messages, a provider/model label, and an optional mock reply. It has no room-chat,
filesystem, tool, database, or arbitrary context field. The pure context builder considers
only the newest 40 panel messages and caps their combined content at 24,000 Python Unicode
code points. It keeps complete messages from newest to oldest and stops at the first older
message that does not fit. If the newest message alone is oversized, only its newest 24,000
code points are retained and the context marks the discarded prefix; older turns are never
summarized. Provider output is restricted to `spokenText`, `stageDirection`, and `emotion`.

`generate_npc_reply` uses the same pure context builder before any provider call. A DeepSeek
request uses `POST /responses`, an empty tool list, `tool_choice: none`, and a strict JSON
Schema. The key is accepted only as `apiKey`/`api_key`, held as `SecretStr`, sent only in the
Authorization header, and never returned or logged. A Codex request uses `codex exec` in an
empty temporary directory with `--ephemeral`, the read-only sandbox, ignored user config and
rules, disabled shell/unified execution, web, browser, computer, app, plugin, image and
collaboration surfaces, and `--output-schema`. Codex uses its own saved login; inference is a
remote service and no model is run locally. Neither adapter exposes a generic prompt, tool,
file, network, database, or room-action proxy.

Character drafting uses a separate closed Schema rather than the NPC prompt. The model can
produce only identity/background text, characteristics, skills and inventory. The sidecar
adds protocol IDs, stable seat ownership, empty status/extensions, an update timestamp and
deterministically derived HP/MP/SAN/MOV/build/damage bonus after validation. The result is
still marked `status: draft` and must be confirmed by the player/KP before publication.

## Workflow and cache

The compiled LangGraph is linear at the document level:

1. normalize text;
2. split at heading/paragraph boundaries with overlap;
3. extract each chunk with the selected Codex CLI or DeepSeek provider and a
   Pydantic-generated JSON Schema;
4. resolve/deduplicate references and discard invalid source locations;
5. validate the complete `ModulePackageV1`;
6. summarize issues for editor review.

The extraction Schema preserves location aliases, NPC traits and explicit CoC character
statistics, core-clue flags, and independent player-facing handouts with scene links.
Locations and NPCs may also contain `playerDescription`, generated conservatively from
only immediately perceptible first-encounter facts. It must exclude hidden identities,
motives, allegiances, concealed features, clue solutions, future events, and mechanics;
when safe wording is not supported it is omitted. This text is always a draft for keeper
review and is never published to a room automatically.

Every one of these entities carries verified source references. Chapters are deliberately
not part of the fragment Schema: chapter grouping is created manually in the editor, so
the parser always returns an empty chapter list instead of inventing a structure.

Empty, incomplete/truncated, invalid JSON, and schema-invalid responses are retried only
for their source chunk. Non-retryable HTTP failures stop that chunk immediately. The
Responses API call is non-streaming and uses `POST /responses`, `text.format.type =
json_schema`, and the configurable model name.

Codex parsing is additionally bounded to 64 chunks and 96 actual extraction attempts per
explicit task. Oversized input fails before inference; exhausting the attempt budget stops
new calls and returns a review draft. These are hard safety limits, not output-token claims:
`codex exec` has no matching max-output-token flag, while the adapter independently caps
the final result file at 8 MiB.

For live Codex parsing, the automatic recovery setting caps chunks at 6,000 characters (or
a smaller configured `max_chunk_chars`) and also keeps each source chunk under a 9,000-byte
UTF-8 soft limit. The byte limit matters for CJK-heavy PDF text, where a character-only cap
substantially understates the actual prompt load; it leaves ordinary Latin text unchanged
and commonly lowers dense Chinese/Japanese chunks to about 3,000 characters. Each chunk is
extracted in two calls: World covers metadata, overview, scenes, locations, and NPCs;
Evidence covers clues, complete handouts, suggested checks, keeper notes, and relations.
Each stage has its own strict Schema, prompt version, cache identity, attempt count, progress
events, and usage. Only when both validate are they atomically assembled into the existing
`ModuleFragmentV1` and passed to the existing cross-chunk merge, source-reference cleanup,
and final `ModulePackageV1` validation. A stage timeout or a bounded run of repeated CLI
error events stops new uncached calls; its validated sibling may be cached for a later resume
but is never merged alone into the draft.

A real parse with zero validated fragments and an error never returns an importable empty
module. The sidecar returns an error instead; a partially validated parse may still enter the
editor as `needs_review` so the keeper can inspect and repair it.

Caching is opt-in through `cache_dir`. Cache identities contain the original source
SHA-256, chunk SHA-256/range and splitting parameters, extractor/model identity, extraction
stage, stage Schema hash, and cache format version. Only already-validated stages/fragments are stored. Credentials
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
