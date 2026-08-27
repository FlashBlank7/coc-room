import {
  CORS_HEADERS,
  JSON_HEADERS,
  MAX_CREATE_ROOM_BODY_BYTES,
  MAX_FRAME_BYTES,
  MAX_ROOM_PEERS,
  PEER_ID_PATTERN,
  PROTOCOL_VERSION,
  ROOM_ID_PATTERN,
} from "./constants";
import { RelayRoom } from "./room";
import {
  deriveJoinSecret,
  deriveRoomId,
  formatJoinToken,
  randomToken,
} from "./security";
import type { CreateRoomRequest, CreateRoomResponse, Env } from "./types";

export { RelayRoom };
export type * from "./types";

const ROOM_WEBSOCKET_PATH = /^\/v1\/rooms\/([A-Za-z0-9_-]+)\/ws$/u;
const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.protocol !== "https:" && !isLoopbackHostname(url.hostname)) {
      return jsonResponse(
        426,
        {
          error: "HTTPS_REQUIRED",
          message: "Public relay requests must use HTTPS and WSS.",
        },
        { Upgrade: "TLS/1.2" },
      );
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(200, {
        ok: true,
        service: "coc-room-relay",
        protocolVersion: PROTOCOL_VERSION,
        maxPeers: MAX_ROOM_PEERS,
        maxFrameBytes: MAX_FRAME_BYTES,
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/rooms") {
      return createRoom(request);
    }

    const match = ROOM_WEBSOCKET_PATH.exec(url.pathname);
    const roomId = match?.[1];
    if (request.method === "GET" && roomId !== undefined) {
      if (!ROOM_ID_PATTERN.test(roomId)) {
        return jsonResponse(400, {
          error: "INVALID_ROOM_ID",
          message: "The room identifier is malformed.",
        });
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return jsonResponse(426, {
          error: "WEBSOCKET_REQUIRED",
          message: "Use a WebSocket upgrade request.",
        });
      }

      const id = env.ROOMS.idFromName(roomId);
      return env.ROOMS.get(id).fetch(request);
    }

    return jsonResponse(404, {
      error: "NOT_FOUND",
      message: "The requested relay endpoint does not exist.",
    });
  },
} satisfies ExportedHandler<Env>;

export default worker;

async function createRoom(request: Request): Promise<Response> {
  if (!isJsonContentType(request.headers.get("Content-Type"))) {
    return jsonResponse(415, {
      error: "UNSUPPORTED_MEDIA_TYPE",
      message: "Room creation requires an application/json request body.",
    });
  }

  const parsed = await readBoundedJson(request, MAX_CREATE_ROOM_BODY_BYTES);
  if (parsed.kind === "too-large") {
    return jsonResponse(413, {
      error: "CREATE_REQUEST_TOO_LARGE",
      message: "The room creation request is too large.",
    });
  }
  if (parsed.kind === "invalid") {
    return jsonResponse(400, {
      error: "INVALID_CREATE_REQUEST",
      message: "The create request must include a valid hostPeerId.",
    });
  }
  const body = parsed.value;

  if (!isCreateRoomRequest(body)) {
    return jsonResponse(400, {
      error: "INVALID_CREATE_REQUEST",
      message: "The create request must include a valid hostPeerId.",
    });
  }

  const hostToken = randomToken(32);
  const joinSecret = await deriveJoinSecret(hostToken);
  const joinToken = formatJoinToken(body.hostPeerId, joinSecret);
  const roomId = await deriveRoomId(joinToken);

  const websocketUrl = new URL(
    `/v1/rooms/${encodeURIComponent(roomId)}/ws`,
    request.url,
  );
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";

  const response: CreateRoomResponse = {
    protocolVersion: PROTOCOL_VERSION,
    roomId,
    hostPeerId: body.hostPeerId,
    hostToken,
    joinToken,
    websocketUrl: websocketUrl.toString(),
  };
  return jsonResponse(201, response);
}

function isCreateRoomRequest(value: unknown): value is CreateRoomRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "hostPeerId" in value &&
    typeof value.hostPeerId === "string" &&
    PEER_ID_PATTERN.test(value.hostPeerId)
  );
}

function jsonResponse(
  status: number,
  body: unknown,
  additionalHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS, ...additionalHeaders },
  });
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname)
  );
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

type BoundedJsonResult =
  | { kind: "ok"; value: unknown }
  | { kind: "invalid" }
  | { kind: "too-large" };

async function readBoundedJson(
  request: Request,
  maximumBytes: number,
): Promise<BoundedJsonResult> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
      return { kind: "too-large" };
    }
  }

  if (request.body === null) {
    return { kind: "invalid" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      try {
        await reader.cancel();
      } catch {
        // The body may already have ended while cancellation is scheduled.
      }
      return { kind: "too-large" };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}
