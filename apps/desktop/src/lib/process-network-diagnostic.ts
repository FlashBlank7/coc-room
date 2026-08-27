import type { ParticipantV1 } from "@coc-room/protocol";

import { RoomTransport, type ConnectionPath, type RoomWireMessage } from "../network/RoomTransport";
import {
  createRelayRoom,
  type CreatedRelayRoom,
  type NetworkDiagnosticMode,
} from "./network-diagnostic";

export type NetworkProcessRole = "host" | "player";

export interface NetworkSmokeRendezvous {
  protocolVersion: 1;
  runId: string;
  mode: NetworkDiagnosticMode;
  roomId: string;
  hostPeerId: string;
  joinToken: string;
  websocketUrl: string;
}

export interface ProcessNetworkDiagnosticOptions {
  relayOrigin: string;
  mode: NetworkDiagnosticMode;
  role: NetworkProcessRole;
  runId: string;
  publishRendezvous(rendezvous: NetworkSmokeRendezvous): Promise<void>;
  readRendezvous(): Promise<NetworkSmokeRendezvous | null>;
}

export interface ProcessNetworkDiagnosticResult {
  mode: NetworkDiagnosticMode;
  role: NetworkProcessRole;
  runId: string;
  path: Exclude<ConnectionPath, "connecting" | "offline">;
  outgoingPayloadBytes: number;
  incomingPayloadBytes: number;
  bidirectionalAcknowledgements: true;
  durationMs: number;
}

export interface ProcessParticipants {
  host: ParticipantV1;
  player: ParticipantV1;
}

interface DiagnosticMessages {
  hostPayload: RoomWireMessage;
  playerPayload: RoomWireMessage;
  hostAcknowledgement: RoomWireMessage;
  playerAcknowledgement: RoomWireMessage;
}

const HOST_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const PLAYER_EVENT_ID = "22222222-2222-4222-8222-222222222222";
const HOST_ACK_ID = "33333333-3333-4333-8333-333333333333";
const PLAYER_ACK_ID = "44444444-4444-4444-8444-444444444444";
const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const POST_ACK_DRAIN_MS = 750;

/** Runs one side of a diagnostic in its own Tauri/WebView2 process. */
export async function runProcessNetworkDiagnostic(
  options: ProcessNetworkDiagnosticOptions,
): Promise<ProcessNetworkDiagnosticResult> {
  const startedAt = performance.now();
  const participants = processParticipants(options.runId);
  const room = options.role === "host"
    ? await createHostRoom(options, participants.host.peerId)
    : await waitForRendezvous(options);
  assertRendezvous(room.rendezvous, options);

  const participant = options.role === "host" ? participants.host : participants.player;
  const counterpart = options.role === "host" ? participants.player : participants.host;
  const token = options.role === "host" ? room.hostToken : room.rendezvous.joinToken;
  if (!token) throw new Error("房主网络自检缺少临时房间令牌");

  const transport = new RoomTransport({
    roomId: room.rendezvous.roomId,
    token,
    relayUrl: room.rendezvous.websocketUrl,
    participant,
    hostPeerId: participants.host.peerId,
    forceRelay: options.mode === "relay",
  });
  const messages = createDiagnosticMessages(room.rendezvous.roomId, participants);
  const outgoingPayload = options.role === "host" ? messages.hostPayload : messages.playerPayload;
  const incomingPayload = options.role === "host" ? messages.playerPayload : messages.hostPayload;
  const outgoingAcknowledgement = options.role === "host"
    ? messages.hostAcknowledgement
    : messages.playerAcknowledgement;
  const incomingAcknowledgement = options.role === "host"
    ? messages.playerAcknowledgement
    : messages.hostAcknowledgement;
  const errors: string[] = [];
  let counterpartPresent = false;
  let path: ConnectionPath = "connecting";
  const currentPath = (): ConnectionPath => path;
  let receivedPayload = false;
  let receivedAcknowledgement = false;
  let acknowledgementSent = false;

  transport.onError = (message) => errors.push(message);
  transport.onPresence = (present) => {
    counterpartPresent = present.some(({ peerId }) => peerId === counterpart.peerId);
  };
  transport.onPathChange = (peerId, nextPath) => {
    if (peerId === counterpart.peerId) path = nextPath;
  };
  transport.onWireMessage = (fromPeerId, message) => {
    if (fromPeerId !== counterpart.peerId) {
      errors.push(`收到了未知参与者 ${fromPeerId} 的诊断消息`);
      return;
    }
    if (sameMessage(message, incomingPayload)) {
      receivedPayload = true;
      if (!acknowledgementSent) {
        acknowledgementSent = true;
        const sent = options.role === "host"
          ? transport.sendToPeer(counterpart.peerId, outgoingAcknowledgement)
          : transport.sendToHost(outgoingAcknowledgement);
        if (!sent) errors.push("无法发送跨进程载荷确认消息");
      }
      return;
    }
    if (sameMessage(message, incomingAcknowledgement)) {
      receivedAcknowledgement = true;
      return;
    }
    errors.push("收到了与本次跨进程自检不匹配的消息");
  };

  try {
    await transport.start();
    await waitUntil(
      () => counterpartPresent,
      errors,
      "两个独立桌面进程未能在中继节点会合",
      20_000,
    );
    if (options.mode === "direct" || options.role === "host") {
      await waitUntil(
        () => currentPath() === options.mode,
        errors,
        options.mode === "direct"
          ? "两个独立 WebView2 进程未能建立 WebRTC DataChannel"
          : "两个独立 WebView2 进程未进入强制中继路径",
        options.mode === "direct" ? 20_000 : 8_000,
      );
    }

    const sent = options.role === "host"
      ? transport.sendToPeer(counterpart.peerId, outgoingPayload)
      : transport.sendToHost(outgoingPayload);
    if (!sent) throw new Error("无法发送跨进程 Unicode 诊断载荷");
    await waitUntil(
      () => receivedPayload && receivedAcknowledgement,
      errors,
      "跨进程 Unicode 载荷或双向确认未在期限内送达",
      20_000,
    );
    const verifiedPath = currentPath();
    if (verifiedPath !== options.mode) {
      throw new Error(`跨进程连接路径不符：期望 ${options.mode}，实际 ${verifiedPath}`);
    }
    // Keep both reliable transports alive after the symmetric acknowledgements.
    // Otherwise the faster process could exit while its final ack is still buffered.
    await new Promise((resolve) => globalThis.setTimeout(resolve, POST_ACK_DRAIN_MS));
    if (errors.length > 0) throw new Error(errors.join("\n"));

    return {
      mode: options.mode,
      role: options.role,
      runId: options.runId,
      path: verifiedPath,
      outgoingPayloadBytes: serializedBytes(outgoingPayload),
      incomingPayloadBytes: serializedBytes(incomingPayload),
      bidirectionalAcknowledgements: true,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    transport.stop();
  }
}

async function createHostRoom(
  options: ProcessNetworkDiagnosticOptions,
  hostPeerId: string,
): Promise<{ rendezvous: NetworkSmokeRendezvous; hostToken: string }> {
  const created: CreatedRelayRoom = await createRelayRoom(options.relayOrigin, hostPeerId);
  const rendezvous: NetworkSmokeRendezvous = {
    protocolVersion: 1,
    runId: options.runId,
    mode: options.mode,
    roomId: created.roomId,
    hostPeerId: created.hostPeerId,
    joinToken: created.joinToken,
    websocketUrl: created.websocketUrl,
  };
  assertRendezvous(rendezvous, options);
  await options.publishRendezvous(rendezvous);
  return { rendezvous, hostToken: created.hostToken };
}

async function waitForRendezvous(
  options: ProcessNetworkDiagnosticOptions,
): Promise<{ rendezvous: NetworkSmokeRendezvous; hostToken?: undefined }> {
  let rendezvous: NetworkSmokeRendezvous | null = null;
  const errors: string[] = [];
  await waitUntil(
    () => rendezvous !== null,
    errors,
    "房主进程未发布跨进程自检凭据",
    20_000,
    async () => {
      rendezvous = await options.readRendezvous();
    },
  );
  if (!rendezvous) throw new Error("跨进程自检凭据为空");
  return { rendezvous };
}

function assertRendezvous(
  rendezvous: NetworkSmokeRendezvous,
  options: Pick<ProcessNetworkDiagnosticOptions, "mode" | "runId">,
): void {
  if (
    rendezvous.protocolVersion !== 1
    || rendezvous.mode !== options.mode
    || rendezvous.runId !== options.runId
  ) {
    throw new Error("跨进程自检凭据不属于当前运行");
  }
}

function processParticipants(runId: string): ProcessParticipants {
  return {
    host: {
      peerId: `smoke-host-${runId}`,
      displayName: "跨进程诊断房主",
      role: "host",
    },
    player: {
      peerId: `smoke-player-${runId}`,
      displayName: "跨进程诊断玩家",
      role: "player",
    },
  };
}

export function createDiagnosticMessages(
  roomId: string,
  participants: ProcessParticipants,
): DiagnosticMessages {
  const hostPayload: RoomWireMessage = {
    kind: "event",
    event: {
      protocolVersion: 1,
      roomId,
      eventId: HOST_EVENT_ID,
      sequence: 1,
      sender: participants.host,
      occurredAt: FIXED_TIMESTAMP,
      type: "content.revealed",
      payload: {
        moduleId: "network-smoke-module",
        revision: 1,
        contentId: "host-unicode-payload",
        contentType: "handout",
        title: "房主跨进程 Unicode 载荷",
        body: "见🦋".repeat(12_000),
      },
    },
  };
  const playerPayload: RoomWireMessage = {
    kind: "event",
    event: {
      protocolVersion: 1,
      roomId,
      eventId: PLAYER_EVENT_ID,
      sequence: 2,
      sender: participants.player,
      occurredAt: FIXED_TIMESTAMP,
      type: "content.revealed",
      payload: {
        moduleId: "network-smoke-module",
        revision: 1,
        contentId: "player-unicode-payload",
        contentType: "handout",
        title: "玩家跨进程 Unicode 载荷",
        body: "蝶🎲".repeat(12_000),
      },
    },
  };
  return {
    hostPayload,
    playerPayload,
    hostAcknowledgement: {
      kind: "sync.request",
      requestId: HOST_ACK_ID,
      lastSequence: 1,
    },
    playerAcknowledgement: {
      kind: "sync.request",
      requestId: PLAYER_ACK_ID,
      lastSequence: 2,
    },
  };
}

function sameMessage(actual: RoomWireMessage, expected: RoomWireMessage): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function serializedBytes(message: RoomWireMessage): number {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}

async function waitUntil(
  predicate: () => boolean,
  errors: string[],
  timeoutMessage: string,
  timeoutMs: number,
  beforeCheck?: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (errors.length > 0) throw new Error(errors.join("\n"));
    if (beforeCheck) await beforeCheck();
    if (predicate()) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  }
  throw new Error(timeoutMessage);
}
