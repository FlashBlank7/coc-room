import {
  createRoomWorldStateV2,
  type NpcSessionMessageV2,
  type RoomEntityV2,
  type RoomEventProposalV2,
  type RoomEventV2,
  type RoomWorldStateV2,
} from "@coc-room/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NPC_CONTEXT_MAX_MESSAGE_CODE_POINTS,
  NPC_CONTEXT_MAX_MESSAGES,
  NpcInteractionBroker,
  TauriNpcReplyProvider,
  selectNpcPanelMessages,
  type NpcInteractionJobStatusV1,
  type RestrictedNpcReplyProvider,
  type RestrictedNpcReplyRequestV1,
} from "./npc-interaction-broker";

const ids = {
  room: "room-v2",
  host: "seat-host",
  player: "seat-player",
  npc: "npc-one",
  session: "npc-session-one",
  humanMessage: "00000000-0000-4000-8000-000000000010",
};

afterEach(() => vi.useRealTimers());

describe("selectNpcPanelMessages", () => {
  it(`keeps at most ${NPC_CONTEXT_MAX_MESSAGES} recent messages and measures astral text as Unicode code points`, () => {
    const total = NPC_CONTEXT_MAX_MESSAGES + 10;
    const smallMessages = Array.from({ length: total }, (_, index) => ({
      id: `message-${index}`,
      role: "human" as const,
      content: `old-${index}`,
    }));

    const capped = selectNpcPanelMessages(smallMessages);

    expect(capped).toHaveLength(NPC_CONTEXT_MAX_MESSAGES);
    expect(capped[0]?.id).toBe("message-10");
    expect(capped.at(-1)?.id).toBe(`message-${total - 1}`);

    const messages = smallMessages.map((message, index) => (index === total - 1
      ? { ...message, content: "🦋".repeat(NPC_CONTEXT_MAX_MESSAGE_CODE_POINTS + 20_000) }
      : message));

    const selected = selectNpcPanelMessages(messages);

    expect(selected).toHaveLength(1);
    expect(selected[0]?.id).toBe(`message-${total - 1}`);
    expect([...selected[0]!.content]).toHaveLength(NPC_CONTEXT_MAX_MESSAGE_CODE_POINTS);
    expect(selected[0]?.content).toBe("🦋".repeat(NPC_CONTEXT_MAX_MESSAGE_CODE_POINTS));
  });

  it("uses the newest contiguous suffix without skipping an over-budget older message", () => {
    const selected = selectNpcPanelMessages([
      { id: "old", role: "human", content: "x".repeat(NPC_CONTEXT_MAX_MESSAGE_CODE_POINTS) },
      { id: "middle", role: "npc", content: "y".repeat(NPC_CONTEXT_MAX_MESSAGE_CODE_POINTS - 1) },
      { id: "new", role: "human", content: "z" },
    ]);
    expect(selected.map(({ id }) => id)).toEqual(["middle", "new"]);
  });
});

describe("NpcInteractionBroker", () => {
  it("sends only the NPC card, <=12 pins and this panel's bounded messages", async () => {
    const captures: RestrictedNpcReplyRequestV1[] = [];
    const provider: RestrictedNpcReplyProvider = {
      generateReply: async (request) => {
        captures.push(request);
        return { spokenText: "你们来晚了。", emotion: "戒备" };
      },
    };
    const fixture = makeWorld({
      mode: "autonomous",
      pins: 12,
      panelMessages: [humanPanelMessage(ids.humanMessage, "调查员的问题")],
    });
    // These are available to the host world but must never cross the provider boundary.
    fixture.world = {
      ...fixture.world,
      artifacts: new Map([["secret-artifact", {
        schemaVersion: 2,
        artifactId: "secret-artifact",
        revision: 1,
        kind: "note",
        title: "DO_NOT_LEAK_ARTIFACT",
        description: "",
        body: "DO_NOT_LEAK_ROOM_SECRET",
        attachments: [],
        audience: { kind: "host" },
        locked: true,
        archived: false,
        extensions: {},
      }]]),
    };
    const published: RoomEventProposalV2[] = [];
    const broker = new NpcInteractionBroker({
      getWorld: () => fixture.world,
      provider,
      publish: async (proposal) => { published.push(proposal); },
    });

    expect(broker.observeEvent(humanEvent())).toBe("queued");
    await broker.whenIdle();

    expect(captures).toHaveLength(1);
    expect(captures[0]?.pins).toHaveLength(12);
    expect(captures[0]?.messages).toEqual([{
      id: ids.humanMessage,
      role: "human",
      content: "调查员的问题",
    }]);
    expect(Object.keys(captures[0]!)).toEqual(["provider", "model", "npcCard", "pins", "messages"]);
    const serialized = JSON.stringify(captures[0]);
    expect(serialized).not.toContain("DO_NOT_LEAK_ARTIFACT");
    expect(serialized).not.toContain("DO_NOT_LEAK_ROOM_SECRET");
    expect(serialized).not.toContain("filesystem");
    expect(serialized).not.toContain("tools");
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "npc.session.message",
      payload: { role: "npc", spokenText: "你们来晚了。", emotion: "戒备" },
    });
  });

  it("deduplicates human messages and never chains from an NPC message", async () => {
    const provider = { generateReply: vi.fn(async () => ({ spokenText: "一次回复" })) };
    const fixture = makeWorld({ mode: "autonomous" });
    const publish = vi.fn(async () => undefined);
    const broker = new NpcInteractionBroker({ getWorld: () => fixture.world, provider, publish });
    const event = humanEvent();

    expect(broker.observeEvent(event)).toBe("queued");
    expect(broker.observeEvent(event)).toBe("duplicate");
    await broker.whenIdle();
    expect(broker.observeEvent(npcEvent())).toBe("ignored");
    await broker.whenIdle();

    expect(provider.generateReply).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("keeps shadow replies host-local and emits status without publishing", async () => {
    const fixture = makeWorld({ mode: "shadow" });
    const statuses: NpcInteractionJobStatusV1[] = [];
    const shadows: unknown[] = [];
    const publish = vi.fn(async () => undefined);
    const broker = new NpcInteractionBroker({
      getWorld: () => fixture.world,
      provider: { generateReply: async () => ({ spokenText: "影子回答" }) },
      publish,
      onStatus: (status) => statuses.push(status),
      onShadowReply: (result) => shadows.push(result),
    });

    broker.observeEvent(humanEvent());
    await broker.whenIdle();

    expect(publish).not.toHaveBeenCalled();
    expect(shadows).toHaveLength(1);
    expect(statuses.map(({ status }) => status)).toEqual(["queued", "running", "completed"]);
  });

  it("stops a running session immediately and never publishes the late result", async () => {
    const fixture = makeWorld({ mode: "autonomous" });
    let resolveProvider!: (value: { spokenText: string }) => void;
    const providerPromise = new Promise<{ spokenText: string }>((resolve) => { resolveProvider = resolve; });
    const publish = vi.fn(async () => undefined);
    const statuses: NpcInteractionJobStatusV1[] = [];
    const broker = new NpcInteractionBroker({
      getWorld: () => fixture.world,
      provider: { generateReply: () => providerPromise },
      publish,
      onStatus: (status) => statuses.push(status),
    });

    broker.observeEvent(humanEvent());
    await Promise.resolve();
    broker.stopSession(ids.session);
    resolveProvider({ spokenText: "不应发布" });
    await broker.whenIdle();

    expect(publish).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.status).toBe("cancelled");
  });

  it("turns timeouts and provider failures into status only", async () => {
    vi.useFakeTimers();
    const fixture = makeWorld({ mode: "autonomous" });
    const statuses: NpcInteractionJobStatusV1[] = [];
    const publish = vi.fn(async () => undefined);
    const broker = new NpcInteractionBroker({
      getWorld: () => fixture.world,
      provider: { generateReply: () => new Promise(() => undefined) },
      publish,
      timeoutMs: 10,
      onStatus: (status) => statuses.push(status),
    });

    broker.observeEvent(humanEvent());
    await vi.advanceTimersByTimeAsync(11);
    await broker.whenIdle();

    expect(publish).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toMatchObject({ status: "failed", message: "NPC 回复超时，未生成替代内容" });
  });

  it("does not retroactively answer messages observed while autoReply is disabled", async () => {
    const fixture = makeWorld({ mode: "autonomous", autoReply: false });
    const provider = { generateReply: vi.fn(async () => ({ spokenText: "不应生成" })) };
    const broker = new NpcInteractionBroker({
      getWorld: () => fixture.world,
      provider,
      publish: async () => undefined,
    });
    const event = humanEvent();

    expect(broker.observeEvent(event)).toBe("ignored");
    fixture.setAutoReply(true);
    expect(broker.observeEvent(event)).toBe("duplicate");
    expect(provider.generateReply).not.toHaveBeenCalled();
  });

  it("can prime a replayed authority log without answering historical prompts", () => {
    const fixture = makeWorld({ mode: "autonomous" });
    const provider = { generateReply: vi.fn(async () => ({ spokenText: "不应生成" })) };
    const broker = new NpcInteractionBroker({
      getWorld: () => fixture.world,
      provider,
      publish: async () => undefined,
    });
    const event = humanEvent();

    broker.primeHistory([event]);
    expect(broker.observeEvent(event)).toBe("duplicate");
    expect(provider.generateReply).not.toHaveBeenCalled();
  });
});

describe("TauriNpcReplyProvider", () => {
  it("uses a fixed NPC-only native command and rejects action-shaped output", async () => {
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const adapter = new TauriNpcReplyProvider(async <T>(command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      return [{ type: "result", result: { reply: { spokenText: "你好" } } }] as T;
    });
    const input = safeProviderInput();
    const result = await adapter.generateReply(input, {
      signal: new AbortController().signal,
      requestId: "00000000-0000-4000-8000-000000000090",
    });

    expect(result).toEqual({ spokenText: "你好" });
    expect(calls[0]?.command).toBe("run_npc_reply");
    expect(Object.keys((calls[0]?.args.request as Record<string, unknown>))).toEqual([
      "id", "action", "provider", "model", "npc_card", "pins", "messages",
    ]);

    const invalid = new TauriNpcReplyProvider(async <T>() => ([{
      type: "result",
      result: { reply: { spokenText: "你好", roomAction: { type: "dice.roll" } } },
    }] as T));
    await expect(invalid.generateReply(input, {
      signal: new AbortController().signal,
      requestId: "00000000-0000-4000-8000-000000000091",
    })).rejects.toThrow("unsupported fields");
  });

  it("forwards abort to the native process-tree cancellation command", async () => {
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const commands: string[] = [];
    const adapter = new TauriNpcReplyProvider(<T>(command: string) => {
      commands.push(command);
      if (command === "cancel_npc_reply") return Promise.resolve(true as T);
      return new Promise<T>(() => undefined);
    });
    const controller = new AbortController();
    const operation = adapter.generateReply(safeProviderInput(), {
      signal: controller.signal,
      requestId: "00000000-0000-4000-8000-000000000092",
    });
    controller.abort();

    await expect(operation).rejects.toBeDefined();
    await Promise.resolve();
    expect(commands).toEqual(["run_npc_reply", "cancel_npc_reply"]);
  });

  it("uses the fixed web-development reply action with panel context only", async () => {
    Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__");
    const invokeNative = vi.fn();
    const runWeb = vi.fn(async () => ([{
      type: "result",
      result: { reply: { spokenText: "你好" } },
    }]));
    const adapter = new TauriNpcReplyProvider(invokeNative, runWeb);
    const signal = new AbortController().signal;
    const input = safeProviderInput();

    await expect(adapter.generateReply(input, {
      signal,
      requestId: "00000000-0000-4000-8000-000000000093",
    })).resolves.toEqual({ spokenText: "你好" });
    expect(invokeNative).not.toHaveBeenCalled();
    expect(runWeb).toHaveBeenCalledWith("npc-reply", {
      id: "00000000-0000-4000-8000-000000000093",
      provider: "codex",
      model: "",
      npcCard: input.npcCard,
      pins: input.pins,
      messages: input.messages,
    }, signal);
    expect(JSON.stringify(runWeb.mock.calls[0])).not.toMatch(/apiKey|path|command|tools|timeout|baseUrl|executable|room|module/i);
  });
});

function makeWorld(options: {
  mode: "shadow" | "autonomous";
  autoReply?: boolean;
  pins?: number;
  panelMessages?: NpcSessionMessageV2[];
}): { world: RoomWorldStateV2; setAutoReply(value: boolean): void } {
  const entity: RoomEntityV2 = {
    schemaVersion: 2,
    entityId: ids.npc,
    revision: 1,
    kind: "npc",
    name: "蝶夫人",
    description: "说话轻柔、谨慎观察来客。",
    artifactIds: [],
    audience: { kind: "room" },
    data: {
      npcCard: {
        id: ids.npc,
        name: "蝶夫人",
        description: "只相信持有银蝶的人。",
        sourceRefs: [],
        role: "守门人",
        motivation: "保护仪式",
        traits: ["克制"],
      },
    },
    extensions: {},
  };
  let autoReply = options.autoReply ?? true;
  const makeSession = () => ({
    schemaVersion: 1 as const,
    sessionId: ids.session,
    revision: 1,
    npcEntityId: ids.npc,
    title: "与蝶夫人交谈",
    description: "受限互动",
    status: "active" as const,
    audience: { kind: "room" as const },
    provider: "codex" as const,
    model: "",
    autoReply,
    mode: options.mode,
    pinnedContext: Array.from({ length: options.pins ?? 0 }, (_, index) => ({
      pinId: `pin-${index}`,
      title: `资料 ${index}`,
      body: `只允许挂载内容 ${index}`,
    })),
    startedAt: "2026-08-29T00:00:00.000Z",
    extensions: {},
  });
  const base = createRoomWorldStateV2(ids.room);
  const holder = {
    world: {
      ...base,
      entities: new Map([[ids.npc, entity]]),
      npcSessions: new Map([[ids.session, makeSession()]]),
      npcMessages: new Map([[ids.session, options.panelMessages ?? [humanPanelMessage(ids.humanMessage, "你好")]]]),
    } as RoomWorldStateV2,
    setAutoReply(value: boolean) {
      autoReply = value;
      holder.world = { ...holder.world, npcSessions: new Map([[ids.session, makeSession()]]) };
    },
  };
  return holder;
}

function humanPanelMessage(messageId: string, text: string): NpcSessionMessageV2 {
  return {
    sessionId: ids.session,
    messageId,
    role: "human",
    speakerSeatId: ids.player,
    spokenText: text,
    occurredAt: "2026-08-29T00:00:01.000Z",
  };
}

function eventBase(eventId: string, sequence: number) {
  return {
    protocolVersion: 2 as const,
    roomId: ids.room,
    eventId,
    sequence,
    sender: {
      seatId: ids.player,
      role: "player" as const,
      displayName: "调查员",
      peerId: "peer-player",
      extensions: {},
    },
    occurredAt: "2026-08-29T00:00:01.000Z",
    audience: { kind: "room" as const },
  };
}

function humanEvent(): RoomEventV2 {
  return {
    ...eventBase("00000000-0000-4000-8000-000000000011", 1),
    type: "npc.session.message",
    payload: {
      sessionId: ids.session,
      messageId: ids.humanMessage,
      role: "human",
      speakerSeatId: ids.player,
      spokenText: "调查员的问题",
    },
  };
}

function npcEvent(): RoomEventV2 {
  return {
    ...eventBase("00000000-0000-4000-8000-000000000012", 2),
    type: "npc.session.message",
    payload: {
      sessionId: ids.session,
      messageId: "00000000-0000-4000-8000-000000000013",
      role: "npc",
      spokenText: "NPC 输出",
    },
  };
}

function safeProviderInput(): RestrictedNpcReplyRequestV1 {
  return {
    provider: "codex",
    model: "",
    npcCard: {
      id: ids.npc,
      name: "蝶夫人",
      description: "谨慎",
      source_refs: [],
      role: "守门人",
      motivations: ["保护仪式"],
      traits: [],
    },
    pins: [],
    messages: [{ id: ids.humanMessage, role: "human", content: "你好" }],
  };
}
