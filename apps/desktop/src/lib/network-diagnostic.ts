import type { ParticipantV1 } from "@coc-room/protocol";

import { RoomTransport, type ConnectionPath, type RoomWireMessage } from "../network/RoomTransport";

export type NetworkDiagnosticMode = "direct" | "relay";

export interface NetworkDiagnosticResult {
  mode: NetworkDiagnosticMode;
  hostPath: ConnectionPath;
  playerPath: ConnectionPath;
  durationMs: number;
  payloadBytes: number;
}

interface CreatedRelayRoom {
  roomId: string;
  hostPeerId: string;
  hostToken: string;
  joinToken: string;
  websocketUrl: string;
}

/** Runs two throwaway peers through the configured node using the real browser transport. */
export async function runNetworkDiagnostic(
  relayOrigin: string,
  mode: NetworkDiagnosticMode,
): Promise<NetworkDiagnosticResult> {
  const startedAt = performance.now();
  const host: ParticipantV1 = {
    peerId: `diagnostic-host-${crypto.randomUUID()}`,
    displayName: "诊断房主",
    role: "host",
  };
  const player: ParticipantV1 = {
    peerId: `diagnostic-player-${crypto.randomUUID()}`,
    displayName: "诊断玩家",
    role: "player",
  };
  const created = await createRelayRoom(relayOrigin, host.peerId);
  const forceRelay = mode === "relay";
  const hostTransport = new RoomTransport({
    roomId: created.roomId,
    token: created.hostToken,
    relayUrl: created.websocketUrl,
    participant: host,
    hostPeerId: host.peerId,
    forceRelay,
  });
  const playerTransport = new RoomTransport({
    roomId: created.roomId,
    token: created.joinToken,
    relayUrl: created.websocketUrl,
    participant: player,
    hostPeerId: host.peerId,
    forceRelay,
  });
  const errors: string[] = [];
  let hostPath: ConnectionPath = "connecting";
  let playerPath: ConnectionPath = "connecting";
  let hostSawPlayer = false;
  let playerSawHost = false;
  const hostMessages: RoomWireMessage[] = [];
  const playerMessages: RoomWireMessage[] = [];
  hostTransport.onError = (message) => errors.push(`host: ${message}`);
  playerTransport.onError = (message) => errors.push(`player: ${message}`);
  hostTransport.onPresence = (participants) => {
    hostSawPlayer = participants.some(({ peerId }) => peerId === player.peerId);
  };
  playerTransport.onPresence = (participants) => {
    playerSawHost = participants.some(({ peerId }) => peerId === host.peerId);
  };
  hostTransport.onPathChange = (peerId, path) => {
    if (peerId === player.peerId) hostPath = path;
  };
  playerTransport.onPathChange = (peerId, path) => {
    if (peerId === host.peerId) playerPath = path;
  };
  hostTransport.onWireMessage = (_peerId, message) => hostMessages.push(message);
  playerTransport.onWireMessage = (_peerId, message) => playerMessages.push(message);

  try {
    await hostTransport.start();
    await playerTransport.start();
    await waitUntil(
      () => hostSawPlayer && playerSawHost,
      errors,
      "双方未能在中继节点会合",
    );
    await waitUntil(
      () => mode === "relay"
        ? hostPath === "relay"
        : hostPath === "direct" && playerPath === "direct",
      errors,
      mode === "relay" ? "未进入强制中继路径" : "WebRTC DataChannel 未能建立",
      mode === "direct" ? 15_000 : 5_000,
    );

    const request: RoomWireMessage = {
      kind: "sync.request",
      requestId: crypto.randomUUID(),
      lastSequence: 0,
    };
    const largeBody = "见🦋".repeat(12_000);
    const largeEvent: RoomWireMessage = {
      kind: "event",
      event: {
        protocolVersion: 1,
        roomId: created.roomId,
        eventId: crypto.randomUUID(),
        sequence: 1,
        sender: host,
        occurredAt: new Date().toISOString(),
        type: "content.revealed",
        payload: {
          moduleId: "diagnostic-module",
          revision: 1,
          contentId: "diagnostic-handout",
          contentType: "handout",
          title: "网络自检大文本",
          body: largeBody,
        },
      },
    };
    if (!playerTransport.sendToHost(request)) throw new Error("玩家到房主的测试消息发送失败");
    if (!hostTransport.sendToPeer(player.peerId, largeEvent)) throw new Error("房主到玩家的测试消息发送失败");
    await waitUntil(
      () => hostMessages.length === 1 && playerMessages.length === 1,
      errors,
      "测试消息未在期限内送达",
    );
    if (JSON.stringify(hostMessages[0]) !== JSON.stringify(request)) {
      throw new Error("玩家到房主的测试消息内容不一致");
    }
    if (JSON.stringify(playerMessages[0]) !== JSON.stringify(largeEvent)) {
      throw new Error("房主到玩家的大文本内容不一致");
    }

    return {
      mode,
      hostPath,
      playerPath: mode === "relay" && playerPath === "connecting" ? "relay" : playerPath,
      durationMs: Math.round(performance.now() - startedAt),
      payloadBytes: new TextEncoder().encode(JSON.stringify(largeEvent)).byteLength,
    };
  } finally {
    playerTransport.stop();
    hostTransport.stop();
  }
}

async function createRelayRoom(origin: string, hostPeerId: string): Promise<CreatedRelayRoom> {
  const normalized = origin.replace(/\/$/u, "").replace(/^ws:/u, "http:").replace(/^wss:/u, "https:");
  const response = await fetch(`${normalized}/v1/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostPeerId }),
  });
  if (!response.ok) throw new Error(`创建诊断房间失败（HTTP ${response.status}）`);
  return await response.json() as CreatedRelayRoom;
}

async function waitUntil(
  predicate: () => boolean,
  errors: string[],
  timeoutMessage: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (errors.length > 0) throw new Error(errors.join("\n"));
    if (predicate()) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
  throw new Error(`${timeoutMessage}${errors.length > 0 ? `：${errors.join("；")}` : ""}`);
}
