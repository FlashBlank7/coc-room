import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve, win32 } from "node:path";
import type { Plugin } from "vite";

export const LOCAL_AI_BRIDGE_PREFIX = "/__coc_room_local_ai/v1";
export const LOCAL_AI_BRIDGE_HEADER = "x-coc-room-local-ai";
export const LOCAL_AI_BRIDGE_TOKEN_META = "coc-room-local-ai-token";

const STATUS_ROUTE = `${LOCAL_AI_BRIDGE_PREFIX}/status`;
const PARSE_ROUTE = `${LOCAL_AI_BRIDGE_PREFIX}/parse-module`;
const RENDER_ROUTE = `${LOCAL_AI_BRIDGE_PREFIX}/render-pdf-pages`;
const CHARACTER_DRAFT_ROUTE = `${LOCAL_AI_BRIDGE_PREFIX}/character-draft`;
const NPC_STATS_DRAFT_ROUTE = `${LOCAL_AI_BRIDGE_PREFIX}/npc-stats-draft`;
const NPC_REPLY_ROUTE = `${LOCAL_AI_BRIDGE_PREFIX}/npc-reply`;
const MAX_TEXT_CHARACTERS = 50_000_000;
const MAX_REGULAR_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_PDF_SOURCE_BYTES = 200 * 1024 * 1024;
const MAX_REQUEST_BYTES = 300 * 1024 * 1024;
const MAX_CHARACTER_DRAFT_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_NPC_STATS_DRAFT_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_NPC_REPLY_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_PARSE_STDOUT_BYTES = 256 * 1024 * 1024;
const MAX_FIXED_AI_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_PDF_RENDER_STDOUT_BYTES = 384 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
export const SIDECAR_TOTAL_TIMEOUT_MS = 12 * 60 * 60 * 1_000;
export const SIDECAR_IDLE_TIMEOUT_MS = 15 * 60 * 1_000;
export const FIXED_AI_TIMEOUT_MS = 30 * 60 * 1_000;
const ALLOWED_SOURCE_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".docx", ".pdf", ".zip"]);
const SIDECAR_INHERITED_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "CODEX_HOME",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
]);

type SidecarDeadline = "total" | "idle";

interface DisconnectEmitter {
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

/** Fixed bridge deadlines. Browser input can neither alter nor disable them. */
export class SidecarLifecycle {
  private totalTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly onDeadline: (deadline: SidecarDeadline) => void,
    totalTimeoutMs = SIDECAR_TOTAL_TIMEOUT_MS,
    private readonly idleTimeoutMs: number | null = SIDECAR_IDLE_TIMEOUT_MS,
  ) {
    this.totalTimer = setTimeout(() => this.expire("total"), totalTimeoutMs);
    this.armIdleTimer();
  }

  /** Only a parsed JSON object with the matching request ID calls this method. */
  noteValidMessage(): void {
    if (this.stopped) return;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.armIdleTimer();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.totalTimer !== undefined) clearTimeout(this.totalTimer);
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.totalTimer = undefined;
    this.idleTimer = undefined;
  }

  private armIdleTimer(): void {
    if (this.idleTimeoutMs !== null) {
      this.idleTimer = setTimeout(() => this.expire("idle"), this.idleTimeoutMs);
    }
  }

  private expire(deadline: SidecarDeadline): void {
    if (this.stopped) return;
    this.stop();
    this.onDeadline(deadline);
  }
}

/** Converts an aborted upload or disconnected response into one shared signal. */
export function bindHttpDisconnectAbort(
  request: DisconnectEmitter,
  response: DisconnectEmitter & { writableEnded: boolean },
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onRequestAborted = () => controller.abort();
  const onResponseClosed = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once("aborted", onRequestAborted);
  response.once("close", onResponseClosed);
  return {
    signal: controller.signal,
    dispose: () => {
      request.removeListener("aborted", onRequestAborted);
      response.removeListener("close", onResponseClosed);
    },
  };
}

interface BridgePluginOptions {
  workspaceRoot: string;
  expectedOrigin: string;
}

interface WireSourceFile {
  name: string;
  byteLength: number;
  sha256: string;
  dataBase64: string;
}

interface BridgeParseRequest {
  id?: string;
  sourceText?: string;
  sourceFile?: WireSourceFile;
  sourceName?: string;
  provider?: string;
  model?: string;
  pdfVisualPageNumbers?: number[];
  mock?: boolean;
}

interface BridgeRenderRequest {
  id?: string;
  sourceFile?: WireSourceFile;
  pageNumbers?: number[];
}

interface BridgeCharacterDraftRequest {
  id?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  playerName?: string;
  ownerSeatId?: string;
}

interface BridgeNpcStatsDraftRequest {
  id?: string;
  provider?: string;
  model?: string;
  npcId?: string;
  name?: string;
  description?: string;
  guidance?: string;
}

interface BridgeNpcReplyRequest {
  id?: string;
  provider?: string;
  model?: string;
  npcCard?: unknown;
  pins?: unknown;
  messages?: unknown;
}

interface SidecarCommand {
  executable: string;
  args: string[];
}

type BridgeProvider = "codex" | "deepseek";

/**
 * Same-origin Vite middleware for the web-first development shell.
 *
 * It deliberately exposes three fixed operations, accepts no local path or
 * command from the browser, and starts the existing one-shot JSONL parser.
 * The DeepSeek credential is injected by the Python wrapper from Windows
 * Credential Manager and is never returned to JavaScript.
 */
export function localAiBridgePlugin(options: BridgePluginOptions): Plugin {
  const workspaceRoot = resolve(options.workspaceRoot);
  const parserRoot = join(workspaceRoot, "services", "module-parser");
  const wrapperPath = join(parserRoot, "scripts", "dev_bridge_sidecar.py");
  const tempRoot = join(tmpdir(), "coc-room-local-ai-bridge");
  const cacheRoot = resolve(
    process.env.LOCALAPPDATA ?? tmpdir(),
    "coc-room",
    "module-parser",
  );
  let runningTasks = 0;
  const MAX_CONCURRENT_TASKS = 4;
  // This capability is created once per Vite server process. It is injected
  // only into that server's development HTML, never into a production build,
  // URL, cookie, persistent browser storage, or log line.
  const developmentSessionToken = randomBytes(32).toString("base64url");

  return {
    name: "coc-room-local-ai-bridge",
    apply: "serve",
    transformIndexHtml: {
      order: "pre",
      handler: () => [{
        tag: "meta",
        attrs: {
          name: LOCAL_AI_BRIDGE_TOKEN_META,
          content: developmentSessionToken,
        },
        injectTo: "head",
      }],
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url?.split("?", 1)[0];
        if (!pathname?.startsWith(LOCAL_AI_BRIDGE_PREFIX)) {
          next();
          return;
        }

        applyPrivateResponseHeaders(response);
        const disconnect = bindHttpDisconnectAbort(request, response);
        try {
          validateBridgeHttpRequest(request, options.expectedOrigin, developmentSessionToken);
          if (request.url?.includes("?")) throw new BridgeHttpError(404, "ROUTE_NOT_FOUND", "本地 AI 桥不接受查询参数");

          if (pathname === STATUS_ROUTE && request.method === "POST") {
            const statusBody = requireRecord(await readJsonBody(request, 1_024));
            assertExactKeys(statusBody, []);
            const messages = await runSidecar({
              command: resolveSidecarCommand(parserRoot),
              wrapperPath,
              parserRoot,
              tempRoot,
              cacheRoot,
              payload: { id: randomUUID(), action: "bridge_status" },
              signal: disconnect.signal,
            });
            const result = messages.find((message) => message.type === "result");
            if (!result) throw new BridgeHttpError(503, "BRIDGE_UNAVAILABLE", "本地 AI 桥没有返回状态");
            writeJson(response, 200, result.result ?? {});
            return;
          }

          if (pathname === PARSE_ROUTE && request.method === "POST") {
            if (runningTasks >= MAX_CONCURRENT_TASKS) throw new BridgeHttpError(409, "PARSER_BUSY", "本地 AI 并发任务已满，请稍候");
            const raw = await readJsonBody(request, MAX_REQUEST_BYTES);
            const parsed = validateParseRequest(raw);
            runningTasks += 1;
            try {
              await withTemporarySource(parsed.sourceFile, tempRoot, async (sourcePath) => {
                const payload = {
                  id: parsed.id,
                  action: "parse_module",
                  source_text: parsed.sourceText,
                  source_path: sourcePath,
                  source_name: parsed.sourceName,
                  provider: parsed.provider,
                  model: parsed.model,
                  pdf_visual_page_numbers: parsed.mock ? undefined : parsed.pdfVisualPageNumbers,
                  mock: parsed.mock,
                };
                await streamSidecar(response, {
                  command: resolveSidecarCommand(parserRoot),
                  wrapperPath,
                  parserRoot,
                  tempRoot,
                  cacheRoot,
                  payload,
                  signal: disconnect.signal,
                });
              });
            } finally {
              runningTasks -= 1;
            }
            return;
          }

          if (pathname === RENDER_ROUTE && request.method === "POST") {
            if (runningTasks >= MAX_CONCURRENT_TASKS) throw new BridgeHttpError(409, "PARSER_BUSY", "本地 AI 并发任务已满，请稍候");
            const raw = await readJsonBody(request, MAX_REQUEST_BYTES);
            const parsed = validateRenderRequest(raw);
            runningTasks += 1;
            try {
              await withTemporarySource(parsed.sourceFile, tempRoot, async (sourcePath) => {
                await streamSidecar(response, {
                  command: resolveSidecarCommand(parserRoot),
                  wrapperPath,
                  parserRoot,
                  tempRoot,
                  cacheRoot,
                  payload: {
                    id: parsed.id,
                    action: "render_pdf_pages",
                    source_path: sourcePath,
                    page_numbers: parsed.pageNumbers,
                  },
                  signal: disconnect.signal,
                });
              });
            } finally {
              runningTasks -= 1;
            }
            return;
          }

          if (request.method === "POST" && (
            pathname === CHARACTER_DRAFT_ROUTE
            || pathname === NPC_STATS_DRAFT_ROUTE
            || pathname === NPC_REPLY_ROUTE
          )) {
            if (runningTasks >= MAX_CONCURRENT_TASKS) throw new BridgeHttpError(409, "LOCAL_AI_BUSY", "本地 AI 并发任务已满，请稍候");
            const requestLimit = pathname === CHARACTER_DRAFT_ROUTE
              ? MAX_CHARACTER_DRAFT_REQUEST_BYTES
              : pathname === NPC_STATS_DRAFT_ROUTE
                ? MAX_NPC_STATS_DRAFT_REQUEST_BYTES
                : MAX_NPC_REPLY_REQUEST_BYTES;
            const raw = await readJsonBody(request, requestLimit);
            let payload: Record<string, unknown>;
            if (pathname === CHARACTER_DRAFT_ROUTE) {
              const parsed = validateCharacterDraftRequest(raw);
              payload = {
                id: parsed.id,
                action: "generate_character_draft",
                provider: parsed.provider,
                model: parsed.model,
                prompt: parsed.prompt,
                playerName: parsed.playerName,
                ownerSeatId: parsed.ownerSeatId,
              };
            } else if (pathname === NPC_STATS_DRAFT_ROUTE) {
              const parsed = validateNpcStatsDraftRequest(raw);
              payload = {
                id: parsed.id,
                action: "generate_npc_stats_draft",
                provider: parsed.provider,
                model: parsed.model,
                npcId: parsed.npcId,
                name: parsed.name,
                description: parsed.description,
                guidance: parsed.guidance,
              };
            } else {
              const parsed = validateNpcReplyRequest(raw);
              payload = {
                id: parsed.id,
                action: "generate_npc_reply",
                provider: parsed.provider,
                model: parsed.model,
                npc_card: parsed.npcCard,
                pins: parsed.pins,
                messages: parsed.messages,
              };
            }
            runningTasks += 1;
            try {
              await streamSidecar(response, {
                command: resolveSidecarCommand(parserRoot),
                wrapperPath,
                parserRoot,
                tempRoot,
                cacheRoot,
                payload,
                signal: disconnect.signal,
              });
            } finally {
              runningTasks -= 1;
            }
            return;
          }

          throw new BridgeHttpError(404, "ROUTE_NOT_FOUND", "不支持的本地 AI 桥路由");
        } catch (error) {
          if (disconnect.signal.aborted || response.destroyed) return;
          if (response.headersSent) {
            response.end();
            return;
          }
          const failure = sanitizeBridgeError(error);
          writeJson(response, failure.status, {
            error: { code: failure.code, message: failure.message },
          });
        } finally {
          disconnect.dispose();
        }
      });
    },
  };
}

export function validateBridgeHttpRequest(
  request: Pick<IncomingMessage, "headers" | "method">,
  expectedOrigin: string,
  expectedSessionToken: string,
): void {
  const origin = headerValue(request.headers, "origin");
  if (origin !== expectedOrigin) {
    throw new BridgeHttpError(403, "INVALID_ORIGIN", "本地 AI 桥只接受当前 Vite 页面");
  }
  if (headerValue(request.headers, "host") !== new URL(expectedOrigin).host) {
    throw new BridgeHttpError(403, "INVALID_HOST", "本地 AI 桥 Host 无效");
  }
  const suppliedSessionToken = headerValue(request.headers, LOCAL_AI_BRIDGE_HEADER);
  if (!isMatchingSessionToken(suppliedSessionToken, expectedSessionToken)) {
    throw new BridgeHttpError(403, "INVALID_BRIDGE_SESSION", "本地 AI 桥开发会话无效");
  }
  const fetchSite = headerValue(request.headers, "sec-fetch-site");
  if (fetchSite !== "same-origin") {
    throw new BridgeHttpError(403, "CROSS_SITE_REQUEST", "本地 AI 桥拒绝跨站请求");
  }
  if (request.method === "POST") {
    const contentType = headerValue(request.headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new BridgeHttpError(415, "JSON_REQUIRED", "本地 AI 桥只接受 JSON 请求");
    }
  }
}

function isMatchingSessionToken(candidate: string | undefined, expected: string): boolean {
  if (!candidate || candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(expected, "utf8"));
}

export function validateParseRequest(raw: unknown): Required<Pick<BridgeParseRequest, "id" | "sourceName" | "provider" | "model" | "mock">>
  & Pick<BridgeParseRequest, "sourceText" | "sourceFile" | "pdfVisualPageNumbers"> {
  const value = requireRecord(raw);
  assertExactKeys(value, ["id", "sourceText", "sourceFile", "sourceName", "provider", "model", "pdfVisualPageNumbers", "mock"]);
  const sourceText = optionalString(value.sourceText);
  const sourceFile = value.sourceFile === undefined ? undefined : validateWireSourceFile(value.sourceFile);
  if ((sourceText === undefined) === (sourceFile === undefined)) {
    throw new BridgeHttpError(400, "INVALID_SOURCE", "必须且只能提供文字或一个模组文件");
  }
  if (sourceText !== undefined && (sourceText.length === 0 || sourceText.length > MAX_TEXT_CHARACTERS)) {
    throw new BridgeHttpError(413, "SOURCE_TOO_LARGE", "模组文字为空或超过 500 万字符");
  }
  const sourceName = requireSafeSourceName(value.sourceName ?? sourceFile?.name);
  const provider = requireString(value.provider);
  if (provider !== "codex" && provider !== "deepseek") {
    throw new BridgeHttpError(400, "INVALID_PROVIDER", "解析服务只能是 Codex 或 DeepSeek");
  }
  const model = requireString(value.model);
  if ((provider === "deepseek" && model.length === 0) || !/^[A-Za-z0-9._-]{0,100}$/.test(model)) {
    throw new BridgeHttpError(400, "INVALID_MODEL", "解析模型名称无效");
  }
  const mock = value.mock === undefined ? false : requireBoolean(value.mock);
  const pdfVisualPageNumbers = value.pdfVisualPageNumbers === undefined
    ? undefined
    : validatePageNumbers(value.pdfVisualPageNumbers);
  if (sourceFile !== undefined && extname(sourceFile.name).toLowerCase() === ".pdf" && provider !== "codex") {
    throw new BridgeHttpError(400, "PDF_REQUIRES_CODEX", "PDF 模组解析只支持 Codex");
  }
  if (pdfVisualPageNumbers && (provider !== "codex" || mock || sourceFile === undefined || extname(sourceFile.name).toLowerCase() !== ".pdf")) {
    throw new BridgeHttpError(400, "PDF_PAGE_SELECTION", "PDF 视觉页只允许用于真实 Codex PDF 解析");
  }
  return {
    id: validateRequestId(value.id),
    sourceName,
    provider,
    model,
    mock,
    sourceText,
    sourceFile,
    pdfVisualPageNumbers,
  };
}

export function validateRenderRequest(raw: unknown): Required<Pick<BridgeRenderRequest, "id" | "sourceFile" | "pageNumbers">> {
  const value = requireRecord(raw);
  assertExactKeys(value, ["id", "sourceFile", "pageNumbers"]);
  const sourceFile = validateWireSourceFile(value.sourceFile);
  if (extname(sourceFile.name).toLowerCase() !== ".pdf") {
    throw new BridgeHttpError(400, "PDF_REQUIRED", "页面预览只接受 PDF 文件");
  }
  return {
    id: validateRequestId(value.id),
    sourceFile,
    pageNumbers: validatePageNumbers(value.pageNumbers),
  };
}

export function validateCharacterDraftRequest(raw: unknown): {
  id: string;
  provider: BridgeProvider;
  model: string;
  prompt: string;
  playerName: string;
  ownerSeatId: string;
} {
  const value = requireRecord(raw);
  assertExactKeys(value, ["id", "provider", "model", "prompt", "playerName", "ownerSeatId"]);
  return {
    id: validateFixedAiRequestId(value.id),
    provider: validateProvider(value.provider),
    model: validateModel(value.model),
    prompt: requireBoundedText(value.prompt, 1, 8_000, "角色草稿描述"),
    playerName: requireBoundedText(value.playerName, 1, 160, "玩家称呼"),
    ownerSeatId: requireIdentifier(value.ownerSeatId, "玩家席位"),
  };
}

export function validateNpcStatsDraftRequest(raw: unknown): {
  id: string;
  provider: BridgeProvider;
  model: string;
  npcId: string;
  name: string;
  description: string;
  guidance: string;
} {
  const value = requireRecord(raw);
  assertExactKeys(value, ["id", "provider", "model", "npcId", "name", "description", "guidance"]);
  return {
    id: validateFixedAiRequestId(value.id),
    provider: validateProvider(value.provider),
    model: validateModel(value.model),
    npcId: requireIdentifier(value.npcId, "NPC"),
    name: requireBoundedText(value.name, 1, 300, "NPC 名称"),
    description: requireBoundedText(value.description, 0, 30_000, "NPC 描述"),
    guidance: requireBoundedText(value.guidance, 0, 8_000, "NPC 补充要求"),
  };
}

export function validateNpcReplyRequest(raw: unknown): {
  id: string;
  provider: BridgeProvider;
  model: string;
  npcCard: Record<string, unknown>;
  pins: Record<string, unknown>[];
  messages: Record<string, unknown>[];
} {
  const value = requireRecord(raw);
  assertExactKeys(value, ["id", "provider", "model", "npcCard", "pins", "messages"]);
  const npcCard = validateNpcCard(value.npcCard);
  const pins = validateNpcPins(value.pins);
  const messages = validateNpcMessages(value.messages);
  return {
    id: validateFixedAiRequestId(value.id),
    provider: validateProvider(value.provider),
    model: validateModel(value.model),
    npcCard,
    pins,
    messages,
  };
}

function validateNpcCard(raw: unknown): Record<string, unknown> {
  const value = requireRecord(raw);
  assertExactKeys(value, [
    "id", "name", "description", "player_description", "role", "motivations",
    "traits", "character", "source_refs",
  ]);
  const sourceRefs = value.source_refs;
  if (!Array.isArray(sourceRefs) || sourceRefs.length !== 0) {
    throw new BridgeHttpError(400, "INVALID_NPC_CONTEXT", "NPC 卡不能携带原文引用");
  }
  const playerDescription = value.player_description === undefined || value.player_description === null
    ? value.player_description
    : requireBoundedText(value.player_description, 0, 20_000, "NPC 公开描述");
  return {
    id: requireIdentifier(value.id, "NPC"),
    name: requireBoundedText(value.name, 1, 300, "NPC 名称"),
    description: requireBoundedText(value.description, 0, 30_000, "NPC 描述"),
    ...(playerDescription === undefined ? {} : { player_description: playerDescription }),
    role: requireBoundedText(value.role, 0, 1_000, "NPC 身份"),
    motivations: validateBoundedStringArray(value.motivations, 100, 4_000, "NPC 动机"),
    traits: validateBoundedStringArray(value.traits, 100, 500, "NPC 特征"),
    ...(value.character === undefined ? {} : { character: validateNpcCharacter(value.character) }),
    source_refs: [],
  };
}

function validateNpcCharacter(raw: unknown): Record<string, unknown> {
  const value = requireRecord(raw);
  assertExactKeys(value, ["characteristics", "skills", "hit_points", "sanity"]);
  const hitPoints = value.hit_points;
  const sanity = value.sanity;
  if (hitPoints !== undefined && !isIntegerInRange(hitPoints, 0, 99)) {
    throw new BridgeHttpError(400, "INVALID_NPC_CONTEXT", "NPC HP 无效");
  }
  if (sanity !== undefined && !isIntegerInRange(sanity, 0, 100)) {
    throw new BridgeHttpError(400, "INVALID_NPC_CONTEXT", "NPC SAN 无效");
  }
  return {
    characteristics: validatePercentageRecord(value.characteristics, 32, "NPC 属性"),
    skills: validatePercentageRecord(value.skills, 200, "NPC 技能"),
    ...(hitPoints === undefined ? {} : { hit_points: hitPoints }),
    ...(sanity === undefined ? {} : { sanity }),
  };
}

function validateNpcPins(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.length > 12) {
    throw new BridgeHttpError(400, "INVALID_NPC_CONTEXT", "NPC 挂载资料最多 12 条");
  }
  let totalCharacters = 0;
  const pins = raw.map((candidate) => {
    const value = requireRecord(candidate);
    assertExactKeys(value, ["id", "title", "content"]);
    const title = requireBoundedText(value.title, 1, 300, "NPC 资料标题");
    const content = requireBoundedText(value.content, 1, 20_000, "NPC 资料正文");
    totalCharacters += [...title].length + [...content].length;
    return {
      id: requireBoundedText(value.id, 1, 128, "NPC 资料 ID"),
      title,
      content,
    };
  });
  if (totalCharacters > 120_000) {
    throw new BridgeHttpError(400, "INVALID_NPC_CONTEXT", "NPC 挂载资料超过 120,000 字符");
  }
  return pins;
}

function validateNpcMessages(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 40) {
    throw new BridgeHttpError(400, "INVALID_NPC_CONTEXT", "NPC 对话只能包含最近 1–40 条消息");
  }
  let totalCharacters = 0;
  const messages = raw.map((candidate) => {
    const value = requireRecord(candidate);
    assertExactKeys(value, ["id", "role", "content", "senderLabel"]);
    if (value.role !== "human" && value.role !== "npc") {
      throw new BridgeHttpError(400, "INVALID_NPC_CONTEXT", "NPC 对话角色无效");
    }
    const content = requireBoundedText(value.content, 1, 24_000, "NPC 对话正文");
    totalCharacters += [...content].length;
    const senderLabel = value.senderLabel === undefined
      ? undefined
      : requireBoundedText(value.senderLabel, 0, 200, "NPC 对话称呼");
    return {
      id: requireBoundedText(value.id, 1, 128, "NPC 消息 ID"),
      role: value.role,
      content,
      ...(senderLabel === undefined ? {} : { senderLabel }),
    };
  });
  if (totalCharacters > 24_000) {
    throw new BridgeHttpError(400, "INVALID_NPC_CONTEXT", "NPC 对话超过 24,000 字符窗口");
  }
  return messages;
}

/** Validates the minimal JSONL envelope before it is allowed to refresh idle time. */
export function validateSidecarActivityMessage(raw: unknown, requestId: string): Record<string, unknown> {
  let message: Record<string, unknown>;
  try {
    message = requireRecord(raw);
  } catch {
    throw new BridgeHttpError(502, "INVALID_PARSER_OUTPUT", "模组解析器返回了无效 JSONL 对象");
  }
  if (message.protocol_version !== "1.0") {
    throw new BridgeHttpError(502, "PARSER_PROTOCOL_MISMATCH", "模组解析器协议版本不匹配");
  }
  if (message.request_id !== requestId) {
    throw new BridgeHttpError(502, "PARSER_REQUEST_MISMATCH", "模组解析器响应 ID 不匹配");
  }
  if (message.type !== "progress" && message.type !== "result" && message.type !== "error") {
    throw new BridgeHttpError(502, "INVALID_PARSER_OUTPUT", "模组解析器 JSONL 类型无效");
  }
  if (message.type === "progress" && (typeof message.stage !== "string" || typeof message.message !== "string")) {
    throw new BridgeHttpError(502, "INVALID_PARSER_OUTPUT", "模组解析器进度心跳结构无效");
  }
  if (message.type === "error" && typeof message.message !== "string") {
    throw new BridgeHttpError(502, "INVALID_PARSER_OUTPUT", "模组解析器错误消息结构无效");
  }
  return message;
}

function validateWireSourceFile(raw: unknown): WireSourceFile {
  const value = requireRecord(raw);
  assertExactKeys(value, ["name", "byteLength", "sha256", "dataBase64"]);
  const name = requireSafeSourceName(value.name);
  const extension = extname(name).toLowerCase();
  if (!ALLOWED_SOURCE_EXTENSIONS.has(extension)) {
    throw new BridgeHttpError(400, "UNSUPPORTED_SOURCE", "仅支持 TXT、Markdown、DOCX、PDF 或安全 ZIP");
  }
  const byteLength = requireInteger(value.byteLength);
  const byteLimit = extension === ".pdf" ? MAX_PDF_SOURCE_BYTES : MAX_REGULAR_SOURCE_BYTES;
  if (byteLength < 1 || byteLength > byteLimit) {
    throw new BridgeHttpError(413, "SOURCE_TOO_LARGE", `模组文件超过 ${byteLimit / 1024 / 1024} MiB 上限`);
  }
  const sha256 = requireString(value.sha256).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new BridgeHttpError(400, "INVALID_SOURCE_HASH", "模组文件哈希无效");
  }
  const dataBase64 = requireString(value.dataBase64);
  if (dataBase64.length > Math.ceil(byteLimit / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
    throw new BridgeHttpError(400, "INVALID_SOURCE_ENCODING", "模组文件编码无效");
  }
  const decoded = Buffer.from(dataBase64, "base64");
  if (decoded.byteLength !== byteLength || createHash("sha256").update(decoded).digest("hex") !== sha256) {
    decoded.fill(0);
    throw new BridgeHttpError(400, "SOURCE_INTEGRITY_FAILED", "模组文件长度或哈希不匹配");
  }
  decoded.fill(0);
  return { name, byteLength, sha256, dataBase64 };
}

async function withTemporarySource<T>(
  sourceFile: WireSourceFile | undefined,
  tempRoot: string,
  operation: (sourcePath: string | undefined) => Promise<T>,
): Promise<T> {
  if (!sourceFile) return operation(undefined);
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, "request-"));
  try {
    const sourcePath = join(directory, sourceFile.name);
    const bytes = Buffer.from(sourceFile.dataBase64, "base64");
    try {
      await writeFile(sourcePath, bytes, { flag: "wx", mode: 0o600 });
    } finally {
      bytes.fill(0);
    }
    const metadata = await stat(sourcePath);
    if (!metadata.isFile() || metadata.size !== sourceFile.byteLength) {
      throw new BridgeHttpError(400, "SOURCE_WRITE_FAILED", "临时模组文件校验失败");
    }
    return await operation(sourcePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface RunSidecarOptions {
  command: SidecarCommand;
  wrapperPath: string;
  parserRoot: string;
  tempRoot: string;
  cacheRoot: string;
  payload: Record<string, unknown>;
  signal: AbortSignal;
}

function isFixedAiAction(action: unknown): boolean {
  return action === "generate_character_draft"
    || action === "generate_npc_stats_draft"
    || action === "generate_npc_reply";
}

export function hasExactlyOneTerminalMessage(messages: Record<string, unknown>[]): boolean {
  const terminals = messages.filter(({ type }) => type === "result" || type === "error");
  const last = messages[messages.length - 1];
  return terminals.length === 1 && last === terminals[0];
}

export function sanitizeSidecarMessage(
  message: Record<string, unknown>,
  action: unknown,
): Record<string, unknown> {
  if (!isFixedAiAction(action) || message.type !== "error") return message;
  const rawError = isPlainRecord(message.error);
  const rawCode = rawError?.code;
  const code = typeof rawCode === "string" && /^[A-Z0-9_]{1,80}$/u.test(rawCode)
    ? rawCode
    : "LOCAL_AI_FAILED";
  const publicMessage = action === "generate_character_draft"
    ? "角色草稿生成失败，未创建替代内容"
    : action === "generate_npc_stats_draft"
      ? "NPC 属性草稿生成失败，未修改人物"
      : "NPC 回复生成失败，未发布替代内容";
  return {
    protocol_version: "1.0",
    request_id: String(message.request_id ?? "unknown"),
    type: "error",
    message: publicMessage,
    error: {
      code,
      message: publicMessage,
      retryable: rawError?.retryable === true,
    },
  };
}

function isPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Keep credentials and unrelated developer secrets out of the parser process.
 * Provider credentials are resolved by the wrapper itself and Codex receives a
 * second, narrower environment at its own subprocess boundary.
 */
export function createBridgeSidecarEnvironment(
  parserRoot: string,
  tempRoot: string,
  cacheRoot: string,
  inherited: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && SIDECAR_INHERITED_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      environment[key] = value;
    }
  }
  return {
    ...environment,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONPATH: join(parserRoot, "src"),
    COC_ROOM_DEV_BRIDGE_TEMP_ROOT: tempRoot,
    COC_ROOM_DEV_BRIDGE_CACHE_DIR: cacheRoot,
  };
}

async function streamSidecar(response: ServerResponse, options: RunSidecarOptions): Promise<void> {
  let started = false;
  const buffered = isFixedAiAction(options.payload.action);
  const writeMessage = (message: Record<string, unknown>) => {
    if (!started) {
      started = true;
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.flushHeaders();
    }
    response.write(`${JSON.stringify(sanitizeSidecarMessage(message, options.payload.action))}\n`);
  };
  try {
    const messages = await runSidecar(options, buffered ? undefined : writeMessage);
    if (buffered) messages.forEach(writeMessage);
    response.end();
  } catch (error) {
    if (started && error instanceof BridgeHttpError && !response.destroyed && !response.writableEnded) {
      response.write(`${JSON.stringify({
        protocol_version: "1.0",
        request_id: String(options.payload.id ?? "unknown"),
        type: "error",
        message: error.message,
        error: { code: error.code, message: error.message, retryable: false },
      })}\n`);
      response.end();
      return;
    }
    throw error;
  }
}

async function runSidecar(
  options: RunSidecarOptions,
  onMessage?: (message: Record<string, unknown>) => void,
): Promise<Record<string, unknown>[]> {
  if (options.signal.aborted) {
    throw new BridgeHttpError(499, "CLIENT_DISCONNECTED", "客户端已断开，本地 AI 任务已取消");
  }
  await mkdir(options.tempRoot, { recursive: true });
  await mkdir(options.cacheRoot, { recursive: true });
  const child = spawn(options.command.executable, [...options.command.args, options.wrapperPath], {
    cwd: options.parserRoot,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: createBridgeSidecarEnvironment(
      options.parserRoot,
      options.tempRoot,
      options.cacheRoot,
    ),
  });
  const requestId = String(options.payload.id ?? "");
  const messages: Record<string, unknown>[] = [];
  let stdout = "";
  let stdoutBytes = 0;
  const stdoutLimit = options.payload.action === "render_pdf_pages"
    ? MAX_PDF_RENDER_STDOUT_BYTES
    : isFixedAiAction(options.payload.action)
      ? MAX_FIXED_AI_STDOUT_BYTES
      : MAX_PARSE_STDOUT_BYTES;
  let stderrBytes = 0;
  let settled = false;

  return await new Promise((resolvePromise, rejectPromise) => {
    let lifecycle: SidecarLifecycle | undefined;
    const onAbort = () => {
      void fail(new BridgeHttpError(499, "CLIENT_DISCONNECTED", "客户端已断开，本地 AI 任务已取消"));
    };
    const cleanup = () => {
      lifecycle?.stop();
      options.signal.removeEventListener("abort", onAbort);
    };
    const fail = async (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      await terminateChildTree(child);
      rejectPromise(error);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(messages);
    };
    const fixedAiAction = isFixedAiAction(options.payload.action);
    lifecycle = new SidecarLifecycle((deadline) => {
      const error = fixedAiAction
        ? new BridgeHttpError(504, "LOCAL_AI_TIMEOUT", "本地 AI 任务达到固定 120 秒上限，已终止")
        : deadline === "total"
          ? new BridgeHttpError(504, "PARSER_TOTAL_TIMEOUT", "模组解析达到固定 45 分钟总上限，已终止")
          : new BridgeHttpError(504, "PARSER_IDLE_TIMEOUT", "模组解析连续 60 秒没有合法 JSONL 心跳，已终止");
      void fail(error);
    }, fixedAiAction ? FIXED_AI_TIMEOUT_MS : SIDECAR_TOTAL_TIMEOUT_MS, fixedAiAction ? null : SIDECAR_IDLE_TIMEOUT_MS);
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
      return;
    }

    child.on("error", () => void fail(new BridgeHttpError(503, "PYTHON_UNAVAILABLE", "未找到可用的 Python 3.12 模组解析环境")));
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_STDERR_BYTES) void fail(new BridgeHttpError(502, "PARSER_STDERR_LIMIT", "模组解析器错误输出超过安全上限"));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > stdoutLimit) {
        void fail(new BridgeHttpError(502, "PARSER_OUTPUT_LIMIT", "模组解析器输出超过安全上限"));
        return;
      }
      stdout += chunk;
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line) {
          let decoded: unknown;
          try {
            decoded = JSON.parse(line);
          } catch {
            void fail(new BridgeHttpError(502, "INVALID_PARSER_OUTPUT", "模组解析器返回了无效 JSONL"));
            return;
          }
          let message: Record<string, unknown>;
          try {
            message = validateSidecarActivityMessage(decoded, requestId);
          } catch (error) {
            void fail(error);
            return;
          }
          lifecycle.noteValidMessage();
          messages.push(message);
          onMessage?.(message);
        }
        newline = stdout.indexOf("\n");
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      if (stdout.trim()) {
        void fail(new BridgeHttpError(502, "TRUNCATED_PARSER_OUTPUT", "模组解析器返回了截断的 JSONL"));
      } else if (code !== 0) {
        void fail(new BridgeHttpError(502, "PARSER_EXITED", stderrBytes ? "模组解析器异常退出（stderr 已脱敏）" : "模组解析器异常退出"));
      } else if (messages.length === 0) {
        void fail(new BridgeHttpError(502, "EMPTY_PARSER_OUTPUT", "模组解析器没有返回结果"));
      } else if (fixedAiAction && !hasExactlyOneTerminalMessage(messages)) {
        void fail(new BridgeHttpError(502, "INVALID_AI_OUTPUT", "本地 AI 执行器没有返回唯一终态"));
      } else {
        finish();
      }
    });

    child.stdin.on("error", () => void fail(new BridgeHttpError(502, "PARSER_STDIN_FAILED", "无法向模组解析器发送任务")));
    child.stdin.end(`${JSON.stringify(options.payload)}\n`, "utf8");
  });
}

function resolveSidecarCommand(parserRoot: string): SidecarCommand {
  const explicit = process.env.COC_ROOM_MODULE_PARSER_PYTHON;
  if (explicit) {
    if (!isAbsolute(explicit)) throw new BridgeHttpError(503, "INVALID_PYTHON_PATH", "COC_ROOM_MODULE_PARSER_PYTHON 必须是绝对路径");
    return { executable: explicit, args: [] };
  }
  const virtualEnvironmentPython = process.platform === "win32"
    ? join(parserRoot, ".venv", "Scripts", "python.exe")
    : join(parserRoot, ".venv", "bin", "python");
  return process.platform === "win32"
    ? { executable: virtualEnvironmentPython, args: [] }
    : { executable: virtualEnvironmentPython, args: [] };
}

async function terminateChildTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolvePromise) => killer.once("close", () => resolvePromise()));
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    total += chunk.byteLength;
    if (total > maxBytes) throw new BridgeHttpError(413, "REQUEST_TOO_LARGE", "本地 AI 桥请求体超过安全上限");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeHttpError(400, "INVALID_JSON", "本地 AI 桥请求不是有效 JSON");
  }
}

function validatePageNumbers(raw: unknown): number[] {
  if (!Array.isArray(raw)) throw new BridgeHttpError(400, "INVALID_PAGE_SELECTION", "PDF 页码必须是数组");
  const pages = raw.map(requireInteger);
  if (pages.length < 1 || pages.length > 4 || new Set(pages).size !== pages.length || pages.some((page) => page < 1 || page > 300)) {
    throw new BridgeHttpError(400, "INVALID_PAGE_SELECTION", "PDF 页码必须是 1–300 内的 1–4 个不重复整数");
  }
  return pages;
}

function validateRequestId(raw: unknown): string {
  const id = raw === undefined ? randomUUID() : requireString(raw);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new BridgeHttpError(400, "INVALID_REQUEST_ID", "任务 ID 无效");
  return id;
}

function validateFixedAiRequestId(raw: unknown): string {
  const id = requireString(raw);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new BridgeHttpError(400, "INVALID_REQUEST_ID", "本地 AI 任务 ID 无效");
  }
  return id;
}

function requireSafeSourceName(raw: unknown): string {
  const value = requireString(raw);
  if (
    value.length < 1
    || value.length > 240
    || basename(value) !== value
    || win32.basename(value) !== value
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(value)
    || /[. ]$/u.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  ) {
    throw new BridgeHttpError(400, "INVALID_SOURCE_NAME", "模组文件名无效");
  }
  return value;
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) throw new BridgeHttpError(400, "UNEXPECTED_FIELD", `本地 AI 桥不接受字段 ${unexpected}`);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeHttpError(400, "INVALID_REQUEST", "请求必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new BridgeHttpError(400, "INVALID_REQUEST", "请求字段类型无效");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requireString(value);
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new BridgeHttpError(400, "INVALID_REQUEST", "请求字段类型无效");
  return value;
}

function requireInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new BridgeHttpError(400, "INVALID_REQUEST", "请求数字字段无效");
  return value;
}

function validateProvider(value: unknown): BridgeProvider {
  if (value !== "codex" && value !== "deepseek") {
    throw new BridgeHttpError(400, "INVALID_PROVIDER", "AI 服务只能是 Codex 或 DeepSeek");
  }
  return value;
}

function validateModel(value: unknown): string {
  const model = requireString(value);
  if (!/^[A-Za-z0-9._-]{0,100}$/u.test(model)) {
    throw new BridgeHttpError(400, "INVALID_MODEL", "AI 模型名称无效");
  }
  return model;
}

function requireBoundedText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string {
  const text = requireString(value);
  const length = [...text].length;
  if (text.includes("\0") || length < minimum || length > maximum) {
    throw new BridgeHttpError(400, "INVALID_AI_REQUEST", `${label}长度无效`);
  }
  return text;
}

function requireIdentifier(value: unknown, label: string): string {
  const identifier = requireString(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(identifier)) {
    throw new BridgeHttpError(400, "INVALID_AI_REQUEST", `${label} ID 无效`);
  }
  return identifier;
}

function validateBoundedStringArray(
  value: unknown,
  maximumItems: number,
  maximumCharacters: number,
  label: string,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new BridgeHttpError(400, "INVALID_NPC_CONTEXT", `${label}条目过多`);
  }
  return value.map((item) => requireBoundedText(item, 0, maximumCharacters, label));
}

function validatePercentageRecord(
  value: unknown,
  maximumKeys: number,
  label: string,
): Record<string, number> {
  const record = requireRecord(value);
  if (Object.keys(record).length > maximumKeys) {
    throw new BridgeHttpError(400, "INVALID_NPC_CONTEXT", `${label}条目过多`);
  }
  const result: Record<string, number> = {};
  for (const [key, candidate] of Object.entries(record)) {
    if ([...key].length < 1 || [...key].length > 120 || !isIntegerInRange(candidate, 0, 100)) {
      throw new BridgeHttpError(400, "INVALID_NPC_CONTEXT", `${label}无效`);
    }
    result[key] = candidate;
  }
  return result;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function applyPrivateResponseHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

class BridgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function sanitizeBridgeError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof BridgeHttpError) return error;
  return { status: 500, code: "BRIDGE_INTERNAL_ERROR", message: "本地 AI 桥发生内部错误" };
}
