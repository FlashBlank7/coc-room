import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import {
  exportEventsToHtml,
  exportEventsToMarkdown,
  modulePackageSchema,
  type RoomEventV1,
} from "@coc-room/protocol";
import { App } from "./App";
import { getRepository, type RoomRecord } from "./data/repository";
import { runNetworkDiagnostic, type NetworkDiagnosticMode } from "./lib/network-diagnostic";
import {
  runProcessNetworkDiagnostic,
  type NetworkProcessRole,
  type NetworkSmokeMode,
  type NetworkSmokeRendezvous,
} from "./lib/process-network-diagnostic";
import {
  runProcessRoomSessionDiagnostic,
  type RoomSessionSmokeMode,
} from "./lib/process-room-session-diagnostic";
import {
  getModuleParserProvenance,
  parseModule,
  type ParserError,
  type ParserResult,
} from "./lib/module-parser";
import { createStorageSmokeMarker } from "./lib/storage-smoke";
import "./styles.css";

type AutomatedSmokeMode = NetworkSmokeMode | "storage";

interface NetworkSmokeConfig {
  relayUrl?: string;
  mode: AutomatedSmokeMode;
  processRole?: NetworkProcessRole;
  runId?: string;
}

interface StorageSmokeExportResult {
  markdownFile: string;
  htmlFile: string;
  markdownBytes: number;
  htmlBytes: number;
}

const root = ReactDOM.createRoot(document.getElementById("root")!);

void bootstrap();

async function bootstrap(): Promise<void> {
  if (window.__TAURI_INTERNALS__) {
    try {
      const config = await invoke<NetworkSmokeConfig | null>("network_smoke_config");
      if (config) {
        root.render(<SmokeStatus message={`${smokeModeLabel(config.mode)}自检中…`} />);
        await runAutomatedSmoke(config);
        return;
      }
    } catch (error) {
      root.render(<SmokeStatus error message={error instanceof Error ? error.message : String(error)} />);
      return;
    }
  }

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

async function runAutomatedSmoke(config: NetworkSmokeConfig): Promise<void> {
  try {
    const result = config.mode === "storage"
      ? await runStorageSmoke()
      : (config.mode === "session-direct" || config.mode === "session-relay") && config.processRole
        ? await runProcessRoomSessionDiagnostic({
          relayOrigin: requireRelayUrl(config),
          mode: config.mode as RoomSessionSmokeMode,
          role: config.processRole,
          runId: requireProcessRunId(config),
          repository: await getRepository(),
          publishRendezvous: (rendezvous) => invoke("publish_network_smoke_rendezvous", { rendezvous }),
          readRendezvous: () => invoke<NetworkSmokeRendezvous | null>("read_network_smoke_rendezvous"),
        })
      : config.processRole
        ? await runProcessNetworkDiagnostic({
          relayOrigin: requireRelayUrl(config),
          mode: config.mode as NetworkDiagnosticMode,
          role: config.processRole,
          runId: requireProcessRunId(config),
          publishRendezvous: (rendezvous) => invoke("publish_network_smoke_rendezvous", { rendezvous }),
          readRendezvous: () => invoke<NetworkSmokeRendezvous | null>("read_network_smoke_rendezvous"),
        })
        : await runNetworkDiagnostic(requireRelayUrl(config), config.mode as NetworkDiagnosticMode);
    root.render(<SmokeStatus message={`${smokeModeLabel(config.mode)}自检通过`} />);
    await invoke("finish_network_smoke", {
      report: {
        ok: true,
        mode: config.mode,
        message: `${config.mode} diagnostic passed`,
        details: result,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    root.render(<SmokeStatus error message={message} />);
    await invoke("finish_network_smoke", {
      report: {
        ok: false,
        mode: config.mode,
        message,
      },
    });
  }
}

async function runStorageSmoke(): Promise<Record<string, unknown>> {
  const repository = await getRepository();
  const runId = crypto.randomUUID();
  const roomId = `storage-smoke-${runId}`;
  const hostPeerId = `storage-host-${runId}`;
  const marker = createStorageSmokeMarker(runId);
  const now = new Date().toISOString();
  const room: RoomRecord = {
    id: roomId,
    name: "自动存储自检",
    localRole: "host",
    localPeerId: hostPeerId,
    hostPeerId,
    inviteToken: runId.replaceAll("-", ""),
    relayUrl: "wss://storage-smoke.invalid/v1/rooms/unused/ws",
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
  const event: RoomEventV1 = {
    protocolVersion: 1,
    roomId,
    eventId: crypto.randomUUID(),
    sequence: 1,
    sender: { peerId: hostPeerId, displayName: "自动存储自检", role: "host" },
    occurredAt: now,
    type: "chat.message",
    payload: { message: marker, format: "plain" },
  };
  let details: Record<string, unknown> | undefined;

  try {
    await repository.saveRoom(room);
    if (await repository.saveEvent(event) !== true) {
      throw new Error("首次保存测试事件没有写入 SQLite");
    }
    if (await repository.saveEvent(event) !== false) {
      throw new Error("重复保存相同事件没有保持幂等");
    }

    const reloadedEvents = await repository.listEvents(roomId);
    const reloadedEvent = reloadedEvents[0];
    if (
      reloadedEvents.length !== 1
      || reloadedEvent?.type !== "chat.message"
      || reloadedEvent.eventId !== event.eventId
      || reloadedEvent.payload.message !== marker
    ) {
      throw new Error("从 SQLite 重读的事件与写入内容不一致");
    }
    const reloadedRoom = (await repository.listRooms()).find((candidate) => candidate.id === roomId);
    if (!reloadedRoom || reloadedRoom.lastSeq !== 1) {
      throw new Error("事件写入后房间 lastSeq 没有持久化为 1");
    }

    const exportOptions = {
      title: "CoC 自动存储自检记录",
      roomName: room.name,
      roomId,
      generatedAt: now,
    };
    const markdown = exportEventsToMarkdown(reloadedEvents, exportOptions);
    const html = exportEventsToHtml(reloadedEvents, exportOptions);
    if (!markdown.includes(marker) || !html.includes(marker)) {
      throw new Error("协议导出器没有保留测试事件正文");
    }
    if (!html.startsWith("<!doctype html>") || /<script\b/iu.test(html)) {
      throw new Error("HTML 导出不是无脚本的自包含文档");
    }

    const sourceText = "# 存储冒烟模组 🦋\n\n地点：临时档案室\nNPC：自动测试员";
    const parserMessages = await parseModule({
      sourceText,
      sourceName: "storage-smoke.md",
      provider: "deepseek",
      model: "deterministic-v1",
      mock: true,
    });
    const parserFailure = parserMessages.find((message): message is ParserError => message.type === "error");
    if (parserFailure) throw new Error(`mock sidecar 返回错误：${parserFailure.message}`);
    const parserResults = parserMessages.filter((message): message is ParserResult => message.type === "result");
    if (parserResults.length !== 1) {
      throw new Error(`mock sidecar 返回了 ${parserResults.length} 个结果，应为 1 个`);
    }
    const parserResult = parserResults[0]!;
    const parsedModule = modulePackageSchema.parse(parserResult.module);
    const provenance = getModuleParserProvenance(parsedModule);
    if (
      parserResult.normalizedText !== sourceText
      || parsedModule.metadata.title !== "存储冒烟模组 🦋"
      || !parsedModule.locations.some((location) => location.name === "临时档案室")
      || !parsedModule.npcs.some((npc) => npc.name === "自动测试员")
      || provenance?.provider !== "mock"
    ) {
      throw new Error("mock sidecar 结果没有通过 UTF-8、结构或来源校验");
    }

    const written = await invoke<StorageSmokeExportResult>("write_storage_smoke_exports", {
      markdown,
      html,
    });
    const markdownBytes = new TextEncoder().encode(markdown).byteLength;
    const htmlBytes = new TextEncoder().encode(html).byteLength;
    if (
      written.markdownFile !== "transcript.md"
      || written.htmlFile !== "transcript.html"
      || written.markdownBytes !== markdownBytes
      || written.htmlBytes !== htmlBytes
    ) {
      throw new Error("Rust 导出命令返回的文件信息与协议导出内容不一致");
    }

    details = {
      roomId,
      eventId: event.eventId,
      marker,
      persistedEvents: reloadedEvents.length,
      lastSeq: reloadedRoom.lastSeq,
      duplicateWasIdempotent: true,
      ...written,
      sidecarTitle: parsedModule.metadata.title,
      sidecarLocations: parsedModule.locations.length,
      sidecarNpcs: parsedModule.npcs.length,
      sidecarProvider: provenance.provider,
    };
  } finally {
    await repository.deleteRoom(roomId);
    const roomStillExists = (await repository.listRooms()).some((candidate) => candidate.id === roomId);
    const orphanedEvents = await repository.listEvents(roomId);
    if (roomStillExists || orphanedEvents.length !== 0) {
      throw new Error("storage smoke 清理失败：测试房间或事件仍留在本地数据库");
    }
  }

  if (!details) throw new Error("storage smoke 没有生成结果");
  return { ...details, cleanupVerified: true };
}

function requireRelayUrl(config: NetworkSmokeConfig): string {
  if (!config.relayUrl) throw new Error(`${config.mode} smoke 缺少中继 URL`);
  return config.relayUrl;
}

function requireProcessRunId(config: NetworkSmokeConfig): string {
  if (!config.runId) throw new Error(`${config.mode} multi-process smoke 缺少运行 ID`);
  return config.runId;
}

function smokeModeLabel(mode: AutomatedSmokeMode): string {
  if (mode === "session-direct") return "RoomSession WebRTC direct";
  if (mode === "session-relay") return "RoomSession forced relay";
  if (mode === "direct") return "WebRTC 直连";
  if (mode === "relay") return "强制中继";
  return "SQLite、导出与 sidecar";
}

function SmokeStatus({ message, error = false }: { message: string; error?: boolean }) {
  return (
    <main className="grid h-screen place-items-center bg-[#101317] p-8 text-ink">
      <div className="max-w-xl rounded-xl border border-zinc-800 bg-zinc-950 p-6 text-center">
        <p className={error ? "text-red-400" : "text-brass"}>{message}</p>
      </div>
    </main>
  );
}
