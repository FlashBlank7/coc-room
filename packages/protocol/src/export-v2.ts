import type { DiceRollResult } from "./dice.js";
import type { Coc7Character } from "./schemas/character.js";
import {
  roomEventViewV2Schema,
  type AssetDescriptorV1,
  type AudienceTargetV2,
  type AudienceV2,
  type BoardItemV1,
  type RoomEventV2,
  type RoomEventViewV2,
} from "./schemas/room-v2.js";

export interface TranscriptExportOptionsV2 {
  readonly title?: string;
  readonly roomName?: string;
  readonly roomId?: string;
  readonly generatedAt?: Date | string;
  /** Optional local-view attribution. It does not affect visibility. */
  readonly seatName?: string;
  readonly seatId?: string;
  /** Locally resolved bytes for assets already referenced by this seat's full views. */
  readonly embeddedAssets?: readonly TranscriptEmbeddedAssetV2[];
}

export interface TranscriptEmbeddedAssetV2 {
  readonly assetId: string;
  readonly mediaType: string;
  /** Raw file bytes encoded as standard Base64; the exporter constructs the data URL. */
  readonly base64?: string;
  /** Human-readable local omission reason. Never include filesystem paths. */
  readonly unavailableReason?: string;
}

interface RenderedEventV2 {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly label: string;
  readonly sender?: string;
  readonly type?: RoomEventV2["type"];
  readonly audience?: AudienceV2;
  readonly paragraphs: readonly string[];
  readonly fields: ReadonlyArray<readonly [string, string]>;
  readonly assets?: readonly AssetDescriptorV1[];
  readonly redacted: boolean;
}

/**
 * Exports exactly the event views held by one seat. Redacted views remain
 * opaque ordering placeholders; this function never attempts to reconstruct
 * their event type, sender, audience, payload, or referenced asset hashes.
 */
export function exportEventsV2ToMarkdown(
  candidateViews: readonly RoomEventViewV2[],
  options: TranscriptExportOptionsV2 = {},
): string {
  const views = normalizeViews(candidateViews);
  const entries = views.map(renderView);
  const metadata = resolveMetadata(views, options);
  const lines = [
    `# ${escapeMarkdown(metadata.title)}`,
    "",
    `- 协议版本：2`,
    `- 房间：${escapeMarkdown(metadata.roomName)}`,
    ...(metadata.roomId === undefined ? [] : [`- 房间 ID：${escapeMarkdown(metadata.roomId)}`]),
    ...(options.seatName === undefined ? [] : [`- 导出席位：${escapeMarkdown(options.seatName)}`]),
    ...(options.seatId === undefined ? [] : [`- 席位 ID：${escapeMarkdown(options.seatId)}`]),
    `- 导出时间：${escapeMarkdown(metadata.generatedAt)}`,
    `- 事件视图数：${entries.length}`,
    `- 受限占位数：${entries.filter(({ redacted }) => redacted).length}`,
    "",
    "## 记录",
    "",
  ];

  if (entries.length === 0) {
    lines.push("_暂无记录。_", "");
  } else {
    for (const entry of entries) {
      lines.push(...entryToMarkdown(entry), "");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Produces a script-free offline HTML transcript of one seat's V2 views. */
export function exportEventsV2ToHtml(
  candidateViews: readonly RoomEventViewV2[],
  options: TranscriptExportOptionsV2 = {},
): string {
  const views = normalizeViews(candidateViews);
  const entries = views.map(renderView);
  const embeddedAssets = normalizeEmbeddedAssets(options.embeddedAssets ?? []);
  const referencedAssets = uniqueAssets(entries.flatMap((entry) => entry.assets ?? []));
  const embeddedCount = referencedAssets.filter((asset) => embeddedAssets.get(asset.assetId)?.base64 !== undefined).length;
  const metadata = resolveMetadata(views, options);
  const eventMarkup = entries.length === 0
    ? '<p class="empty">暂无记录。</p>'
    : entries.map((entry) => entryToHtml(entry, embeddedAssets)).join("\n");
  const seatMarkup = [
    options.seatName === undefined ? "" : `<li>导出席位：${escapeHtml(options.seatName)}</li>`,
    options.seatId === undefined ? "" : `<li>席位 ID：${escapeHtml(options.seatId)}</li>`,
  ].filter(Boolean).join("\n      ");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:">
  <title>${escapeHtml(metadata.title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.6; }
    body { margin: 0 auto; max-width: 920px; padding: 2rem 1.25rem 4rem; background: Canvas; color: CanvasText; }
    header { border-bottom: 1px solid #8886; margin-bottom: 1.5rem; }
    h1 { line-height: 1.2; margin-bottom: .5rem; }
    .meta { color: GrayText; display: flex; flex-wrap: wrap; gap: .35rem 1.25rem; padding: 0; list-style: none; }
    .event { border: 1px solid #8885; border-radius: .65rem; margin: .8rem 0; padding: .8rem 1rem; break-inside: avoid; }
    .event.redacted { border-style: dashed; color: GrayText; }
    .event-header { align-items: baseline; display: flex; flex-wrap: wrap; gap: .3rem .8rem; margin-bottom: .45rem; }
    .sequence { color: GrayText; font-variant-numeric: tabular-nums; }
    .sender { font-weight: 700; }
    time, .type, .audience { color: GrayText; font-size: .88rem; }
    .body { margin: .35rem 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .2rem .9rem; margin: .5rem 0 0; }
    dt { font-weight: 650; }
    dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    .attachments { display: grid; gap: .7rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); margin-top: .75rem; }
    .attachment { border: 1px solid #8884; border-radius: .55rem; margin: 0; overflow: hidden; padding: .65rem; }
    .attachment img { display: block; max-height: 28rem; max-width: 100%; margin: 0 auto; object-fit: contain; }
    .attachment audio { display: block; width: 100%; }
    .attachment figcaption, .asset-missing { color: GrayText; font-size: .82rem; margin-top: .45rem; overflow-wrap: anywhere; }
    .empty { font-style: italic; }
    @media print { body { max-width: none; padding: 0; } .event { border-color: #aaa; } }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(metadata.title)}</h1>
    <ul class="meta">
      <li>协议版本：2</li>
      <li>房间：${escapeHtml(metadata.roomName)}</li>
      ${metadata.roomId === undefined ? "" : `<li>房间 ID：${escapeHtml(metadata.roomId)}</li>`}
      ${seatMarkup}
      <li>导出时间：${escapeHtml(metadata.generatedAt)}</li>
      <li>事件视图数：${entries.length}</li>
      <li>受限占位数：${entries.filter(({ redacted }) => redacted).length}</li>
      <li>离线媒体：${embeddedCount} / ${referencedAssets.length} 个已嵌入</li>
    </ul>
  </header>
  <main>
${eventMarkup}
  </main>
</body>
</html>
`;
}

function normalizeViews(candidateViews: readonly RoomEventViewV2[]): RoomEventViewV2[] {
  const views = roomEventViewV2Schema.array().parse(candidateViews);
  const eventIds = new Set<string>();
  const sequences = new Set<number>();
  for (const view of views) {
    const identity = viewIdentity(view);
    if (eventIds.has(identity.eventId)) throw new Error(`Duplicate V2 event ID: ${identity.eventId}`);
    if (sequences.has(identity.sequence)) throw new Error(`Duplicate V2 event sequence: ${identity.sequence}`);
    eventIds.add(identity.eventId);
    sequences.add(identity.sequence);
  }
  return [...views].sort((left, right) => viewIdentity(left).sequence - viewIdentity(right).sequence);
}

function resolveMetadata(
  views: readonly RoomEventViewV2[],
  options: TranscriptExportOptionsV2,
): { title: string; roomName: string; roomId?: string; generatedAt: string } {
  const roomIds = new Set(views.map((view) => viewIdentity(view).roomId));
  if (options.roomId !== undefined) roomIds.add(options.roomId);
  if (roomIds.size > 1) throw new Error("Cannot export V2 views from multiple rooms in one transcript");
  const roomId = roomIds.values().next().value as string | undefined;
  return {
    title: options.title ?? "CoC 跑团记录（V2）",
    roomName: options.roomName ?? roomId ?? "未指定",
    ...(roomId === undefined ? {} : { roomId }),
    generatedAt: normalizeDate(options.generatedAt),
  };
}

function normalizeDate(value?: Date | string): string {
  if (value === undefined) return new Date().toISOString();
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.valueOf())) throw new Error("generatedAt must be a valid date");
  return date.toISOString();
}

function viewIdentity(view: RoomEventViewV2): {
  readonly roomId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
} {
  return view.view === "full" ? view.event : view;
}

function renderView(view: RoomEventViewV2): RenderedEventV2 {
  if (view.view === "redacted") {
    return {
      sequence: view.sequence,
      occurredAt: view.occurredAt,
      label: "受限事件",
      paragraphs: ["此事件不在当前席位的可见范围内，内容已隐藏。"],
      fields: [],
      redacted: true,
    };
  }
  return renderFullEvent(view.event);
}

function renderFullEvent(event: RoomEventV2): RenderedEventV2 {
  const base = {
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    sender: event.sender.displayName,
    type: event.type,
    audience: event.audience,
    redacted: false,
  } as const;

  switch (event.type) {
    case "chat.message":
      return { ...base, label: "聊天", paragraphs: [event.payload.message], fields: [["格式", event.payload.format]] };
    case "system.notice":
      return { ...base, label: "系统提示", paragraphs: [event.payload.message], fields: [["级别", event.payload.level]] };
    case "dice.result":
      return {
        ...base,
        label: "骰子结果",
        paragraphs: [],
        fields: [
          ...diceFields(event.payload.result, event.payload.reason),
          ...(event.payload.checkRequestId === undefined
            ? []
            : [["检定申请", event.payload.checkRequestId] as const]),
        ],
      };
    case "character.updated":
      return { ...base, label: "角色卡更新", paragraphs: [], fields: characterFields(event.payload.character) };
    case "check.requested":
      return {
        ...base,
        label: event.payload.pushOfRequestId === undefined ? "申请检定" : "申请强推",
        paragraphs: event.payload.goal !== undefined || event.payload.approach !== undefined
          ? [
              ...(event.payload.goal === undefined ? [] : [`目标：${event.payload.goal}`]),
              ...(event.payload.approach === undefined ? [] : [`做法：${event.payload.approach}`]),
            ]
          : [event.payload.reason],
        fields: [
          ["调查员", event.payload.characterName],
          ["玩家建议技能", event.payload.suggestedSkillName ?? event.payload.skillName],
          ["建议目标", event.payload.proposedTarget === undefined ? "未提供" : String(event.payload.proposedTarget)],
          ...(event.payload.pushOfRequestId === undefined
            ? []
            : [["基于失败检定", event.payload.pushOfRequestId] as const]),
          ["申请 ID", event.payload.requestId],
        ],
      };
    case "check.authorized":
      return {
        ...base,
        label: event.payload.failureConsequence === undefined ? "KP 允许检定" : "KP 允许强推",
        paragraphs: [event.payload.note].filter(Boolean),
        fields: [
          ["申请 ID", event.payload.requestId],
          ...(event.payload.skillName === undefined
            ? []
            : [["KP 采用技能", event.payload.skillName] as const]),
          ["目标", String(event.payload.target)],
          ["难度", event.payload.requiredDifficulty],
          ["奖励 / 惩罚骰", `${event.payload.bonusDice} / ${event.payload.penaltyDice}`],
          ...(event.payload.failureConsequence === undefined
            ? []
            : [["强推失败代价", event.payload.failureConsequence] as const]),
        ],
      };
    case "check.closed": {
      const outcome = {
        "no-roll": { label: "KP 裁定无需掷骰", value: "无需掷骰" },
        declined: { label: "KP 拒绝检定", value: "拒绝" },
        cancelled: { label: "取消检定申请", value: "取消" },
      }[event.payload.outcome];
      return {
        ...base,
        label: outcome.label,
        paragraphs: [event.payload.note].filter(Boolean),
        fields: [
          ["申请 ID", event.payload.requestId],
          ["处理结果", outcome.value],
        ],
      };
    }
    case "check.outcome.described":
      return {
        ...base,
        label: "KP 描述检定结果",
        paragraphs: [event.payload.text],
        fields: [["申请 ID", event.payload.requestId]],
      };
    case "clue.claimed":
      return {
        ...base,
        label: "关注线索",
        paragraphs: [`${event.payload.characterName} 将这条公开线索标记为正在关注。`],
        fields: [["线索资料", event.payload.artifactId], ["角色", event.payload.characterId]],
      };
    case "clue.unclaimed":
      return {
        ...base,
        label: "取消关注线索",
        paragraphs: [`${event.payload.characterName} 不再将这条公开线索标记为个人重点。`],
        fields: [["线索资料", event.payload.artifactId], ["角色", event.payload.characterId]],
      };
    case "module.switched":
      return {
        ...base,
        label: "切换模组",
        paragraphs: [event.payload.title],
        fields: [["模组 ID", event.payload.moduleId], ["修订", String(event.payload.revision)]],
      };
    case "room.settings.updated":
      return {
        ...base,
        label: "房间设置更新",
        paragraphs: [],
        fields: [["新内容默认可见范围", event.payload.defaultVisibility === "public" ? "公开" : "秘密"]],
      };
    case "entity.upserted": {
      const entity = event.payload.entity;
      return {
        ...base,
        label: "实体更新",
        paragraphs: [entity.name, entity.description].filter(Boolean),
        fields: [
          ["实体 ID", entity.entityId],
          ["种类", entity.kind],
          ["修订", String(entity.revision)],
          ["关联资料", entity.artifactIds.join("、") || "无"],
          ["结构化数据", formatUnknown(entity.data)],
        ],
      };
    }
    case "scene.focused":
      return {
        ...base,
        label: "推进当前场景",
        paragraphs: ["KP 将跑团焦点切换到了新的场景。"],
        fields: [["场景实体 ID", event.payload.sceneEntityId]],
      };
    case "artifact.upserted": {
      const artifact = event.payload.artifact;
      const assets = [...artifact.attachments, ...(artifact.asset === undefined ? [] : [artifact.asset])];
      return {
        ...base,
        label: "资料更新",
        paragraphs: [artifact.title, artifact.description, artifact.body].filter(Boolean),
        fields: [
          ["资料 ID", artifact.artifactId],
          ["种类", artifact.kind],
          ["修订", String(artifact.revision)],
          ["状态", `${artifact.locked ? "已锁定" : "可编辑"}；${artifact.archived ? "已归档" : "使用中"}`],
          ...(artifact.sourceEntityId === undefined ? [] : [["来源实体", artifact.sourceEntityId] as const]),
          ["附件", assets.length === 0 ? "无" : assets.map(assetSummary).join("\n")],
        ],
        assets,
      };
    }
    case "board.created":
      return boardEntry(base, "创建画板", event.payload.board);
    case "board.updated":
      return boardEntry(base, "更新画板", event.payload.board);
    case "board.activated":
      return { ...base, label: "切换当前画板", paragraphs: [], fields: [["画板 ID", event.payload.boardId]] };
    case "board.item.upserted":
      return {
        ...base,
        label: "画板项目更新",
        paragraphs: [event.payload.item.label].filter(Boolean),
        fields: [
          ["画板 ID", event.payload.boardId],
          ["画板修订", String(event.payload.boardRevision)],
          ...boardItemFields(event.payload.item),
        ],
      };
    case "board.item.removed":
      return {
        ...base,
        label: "移除画板项目",
        paragraphs: [],
        fields: [["画板 ID", event.payload.boardId], ["画板修订", String(event.payload.boardRevision)], ["项目 ID", event.payload.itemId]],
      };
    case "board.edge.upserted":
      return {
        ...base,
        label: "画板关系更新",
        paragraphs: [event.payload.edge.label].filter(Boolean),
        fields: [
          ["画板 ID", event.payload.boardId],
          ["画板修订", String(event.payload.boardRevision)],
          ["关系 ID", event.payload.edge.edgeId],
          ["种类", event.payload.edge.kind],
          ["连接", `${event.payload.edge.fromItemId} → ${event.payload.edge.toItemId}`],
        ],
      };
    case "board.edge.removed":
      return {
        ...base,
        label: "移除画板关系",
        paragraphs: [],
        fields: [["画板 ID", event.payload.boardId], ["画板修订", String(event.payload.boardRevision)], ["关系 ID", event.payload.edgeId]],
      };
    case "board.fog.revealed":
      return {
        ...base,
        label: "揭示地图迷雾",
        paragraphs: [],
        fields: [
          ["画板 ID", event.payload.boardId],
          ["画板修订", String(event.payload.boardRevision)],
          ["迷雾 ID", event.payload.maskId],
          ["迷雾修订", String(event.payload.maskRevision)],
          ["区域 ID", event.payload.region.regionId],
          ["多边形顶点", String(event.payload.region.points.length)],
        ],
      };
    case "audience.expanded":
      return {
        ...base,
        label: "扩大可见范围",
        paragraphs: [],
        fields: [["目标", audienceTargetSummary(event.payload.target)], ["新可见范围", audienceSummary(event.payload.audience)]],
      };
    case "npc.session.upserted": {
      const session = event.payload.session;
      return {
        ...base,
        label: "NPC 互动面板更新",
        paragraphs: [session.title, session.description].filter(Boolean),
        fields: [
          ["会话 ID", session.sessionId],
          ["NPC 实体 ID", session.npcEntityId],
          ["修订", String(session.revision)],
          ["状态", session.status],
          ["提供者 / 模型", `${session.provider}${session.model ? ` / ${session.model}` : ""}`],
          ["自动回复", session.autoReply ? `已开启（${session.mode}）` : "已关闭"],
          ...(session.endedAt ? [["结束时间", session.endedAt] as const] : []),
          ["固定上下文", session.pinnedContext.length === 0
            ? "无"
            : session.pinnedContext.map((pin) => `${pin.title}\n${pin.body}`).join("\n\n")],
        ],
      };
    }
    case "npc.session.message": {
      const message = event.payload;
      return {
        ...base,
        label: "NPC 互动消息",
        paragraphs: [message.spokenText],
        fields: [
          ["会话 ID", message.sessionId],
          ["发言身份", message.role === "human" ? event.sender.displayName : npcRoleLabel(message.role)],
          ...(message.speakerSeatId === undefined ? [] : [["发言席位", message.speakerSeatId] as const]),
          ...(message.stageDirection === undefined ? [] : [["动作描写", message.stageDirection] as const]),
          ...(message.emotion === undefined ? [] : [["情绪", message.emotion] as const]),
        ],
      };
    }
    case "audio.cued":
      return {
        ...base,
        label: "开始播放音频",
        paragraphs: [],
        fields: [
          ["播放 ID", event.payload.cueId],
          ["资源", assetSummary(event.payload.asset)],
          ["循环", event.payload.loop ? "是" : "否"],
          ["房主基准音量", `${Math.round(event.payload.volume * 100)}%`],
          ["淡入", `${event.payload.fadeInMs} ms`],
          ["开始偏移", `${event.payload.startOffsetMs} ms`],
        ],
        assets: [event.payload.asset],
      };
    case "audio.stopped":
      return {
        ...base,
        label: "停止播放音频",
        paragraphs: [],
        fields: [["播放 ID", event.payload.cueId], ["淡出", `${event.payload.fadeOutMs} ms`]],
      };
    default:
      return assertNever(event);
  }
}

function boardEntry(
  base: Omit<RenderedEventV2, "label" | "paragraphs" | "fields">,
  label: string,
  board: Extract<RoomEventV2, { type: "board.created" }>["payload"]["board"],
): RenderedEventV2 {
  return {
    ...base,
    label,
    paragraphs: [board.name, board.description].filter(Boolean),
    fields: [
      ["画板 ID", board.boardId],
      ["种类", board.kind],
      ["修订", String(board.revision)],
      ["逻辑尺寸", `${board.logicalSize.width} × ${board.logicalSize.height}`],
      ["状态", board.archived ? "已归档" : "使用中"],
      ...(board.backgroundArtifactId === undefined ? [] : [["背景资料", board.backgroundArtifactId] as const]),
      ["项目 / 关系", `${board.items.length} / ${board.edges.length}`],
      ["迷雾", board.fogMask === undefined ? "无" : `${board.fogMask.revealedRegions.length} 个已揭示区域`],
    ],
  };
}

function boardItemFields(item: BoardItemV1): ReadonlyArray<readonly [string, string]> {
  return [
    ["项目 ID", item.itemId],
    ["引用", boardReferenceSummary(item.reference)],
    ["位置", `(${item.position.x}, ${item.position.y})`],
    ["旋转 / 缩放", `${item.rotationDegrees}° / ${item.scale}`],
    ["层级", String(item.zIndex)],
    ["状态", item.locked ? "已锁定" : "可编辑"],
  ];
}

function boardReferenceSummary(reference: BoardItemV1["reference"]): string {
  switch (reference.kind) {
    case "entity": return `实体：${reference.entityId}`;
    case "artifact": return `资料：${reference.artifactId}`;
    case "npc-session": return `NPC 会话：${reference.sessionId}`;
    case "text": return `文字：${reference.text}`;
    default: return assertNever(reference);
  }
}

function audienceTargetSummary(target: AudienceTargetV2): string {
  switch (target.kind) {
    case "event": return `事件 ${target.eventId}`;
    case "entity": return `实体 ${target.entityId}`;
    case "artifact": return `资料 ${target.artifactId}`;
    case "board": return `画板 ${target.boardId}`;
    case "board-item": return `画板项目 ${target.boardId} / ${target.itemId}`;
    case "board-edge": return `画板关系 ${target.boardId} / ${target.edgeId}`;
    case "fog-mask": return `迷雾 ${target.boardId} / ${target.maskId}`;
    case "npc-session": return `NPC 会话 ${target.sessionId}`;
    default: return assertNever(target);
  }
}

function audienceSummary(audience: AudienceV2): string {
  switch (audience.kind) {
    case "room": return "全房间";
    case "host": return "仅 KP";
    case "seats": return `指定席位：${audience.seatIds.join("、")}`;
    default: return assertNever(audience);
  }
}

function assetSummary(asset: AssetDescriptorV1): string {
  const dimensions = asset.width === undefined ? "" : `；${asset.width} × ${asset.height}`;
  const duration = asset.durationMs === undefined ? "" : `；${asset.durationMs} ms`;
  return `${asset.mediaType}；${asset.byteLength} 字节${dimensions}${duration}；${asset.assetId}`;
}

function npcRoleLabel(role: "human" | "npc" | "system"): string {
  if (role === "human") return "调查员";
  if (role === "npc") return "NPC";
  return "系统";
}

function diceFields(result: DiceRollResult, reason: string): ReadonlyArray<readonly [string, string]> {
  if (result.kind === "standard") {
    return [
      ["原因", reason || "未注明"],
      ["骰式", result.expression],
      ["掷骰", `${result.rolls.join("、")}${result.modifier === 0 ? "" : `；修正 ${signed(result.modifier)}`}`],
      ["结果", String(result.total)],
    ];
  }
  return [
    ["原因", reason || "未注明"],
    ["骰式", `1d100${result.bonusDice > 0 ? `；${result.bonusDice} 个奖励骰` : ""}${result.penaltyDice > 0 ? `；${result.penaltyDice} 个惩罚骰` : ""}`],
    ["候选", result.candidates.join("、")],
    ["结果", String(result.total)],
    ...(result.check === undefined
      ? []
      : [["检定", `${result.check.outcome}（目标 ${result.check.target}；${result.check.success ? "成功" : "失败"}）`] as const]),
  ];
}

function characterFields(character: Coc7Character): ReadonlyArray<readonly [string, string]> {
  const characteristics = Object.entries(character.characteristics)
    .map(([key, value]) => `${key.toUpperCase()} ${value}`)
    .join("、");
  const skills = character.skills
    .map((skill) => `${skill.name}${skill.specialization ? `（${skill.specialization}）` : ""} ${skill.value}`)
    .join("、") || "未填写";
  const inventory = character.inventory
    .map((item) => `${item.name} × ${item.quantity}${item.description ? `：${item.description}` : ""}`)
    .join("\n") || "无";
  const statuses = [
    character.status.temporaryInsanity ? "临时性疯狂" : "",
    character.status.indefiniteInsanity ? "不定性疯狂" : "",
    character.status.majorWound ? "重伤" : "",
    character.status.dying ? "濒死" : "",
    character.status.unconscious ? "昏迷" : "",
  ].filter(Boolean).join("、") || "无";
  return [
    ["角色", `${character.name}（玩家：${character.playerName}）`],
    ["角色 ID", character.id],
    ["职业 / 年龄", `${character.occupation || "未填写"} / ${character.age}`],
    ["居住地 / 出生地", `${character.residence || "未填写"} / ${character.birthplace || "未填写"}`],
    ["属性", characteristics],
    ["衍生数值", `HP ${character.derived.hitPoints}/${character.derived.maxHitPoints}；MP ${character.derived.magicPoints}/${character.derived.maxMagicPoints}；SAN ${character.derived.sanity}/${character.derived.maxSanity}；MOV ${character.derived.movementRate}；体格 ${character.derived.build}；伤害加值 ${character.derived.damageBonus}`],
    ["异常状态", statuses],
    ["技能", skills],
    ["物品", inventory],
    ["备注", character.notes || "未填写"],
    ["更新时间", character.updatedAt],
  ];
}

function entryToMarkdown(entry: RenderedEventV2): string[] {
  const metadata = [entry.occurredAt, entry.sender, entry.type].filter((value): value is string => value !== undefined);
  return [
    `### ${String(entry.sequence).padStart(6, "0")} · ${escapeMarkdown(entry.label)}`,
    `_${metadata.map(escapeMarkdown).join(" · ")}_`,
    ...(entry.audience === undefined ? [] : [`_可见范围：${escapeMarkdown(audienceSummary(entry.audience))}_`]),
    "",
    ...entry.paragraphs.flatMap((paragraph, index) => [
      ...escapeMarkdownBlock(paragraph),
      ...(index === entry.paragraphs.length - 1 ? [] : [""]),
    ]),
    ...(entry.paragraphs.length === 0 || entry.fields.length === 0 ? [] : [""]),
    ...entry.fields.flatMap(fieldToMarkdown),
  ];
}

function fieldToMarkdown([label, value]: readonly [string, string]): string[] {
  const [first = "", ...rest] = escapeMarkdownBlock(value);
  return [`- ${escapeMarkdown(label)}：${first}`, ...rest.map((line) => `  ${line}`)];
}

function entryToHtml(entry: RenderedEventV2, embeddedAssets: ReadonlyMap<string, TranscriptEmbeddedAssetV2>): string {
  const sender = entry.sender === undefined ? "" : `<span class="sender">${escapeHtml(entry.sender)}</span>`;
  const type = entry.type === undefined ? "" : `<span class="type">${escapeHtml(entry.type)}</span>`;
  const audience = entry.audience === undefined ? "" : `<span class="audience">可见范围：${escapeHtml(audienceSummary(entry.audience))}</span>`;
  const paragraphs = entry.paragraphs.map((paragraph) => `<p class="body">${escapeHtml(paragraph)}</p>`).join("");
  const fields = entry.fields.length === 0 ? "" : definitionList(entry.fields);
  const assets = entry.assets?.length ? attachmentMarkup(entry.assets, embeddedAssets) : "";
  return `    <article class="event${entry.redacted ? " redacted" : ""}"><div class="event-header"><span class="sequence">#${String(entry.sequence).padStart(6, "0")}</span><strong>${escapeHtml(entry.label)}</strong>${sender}<time datetime="${escapeHtml(entry.occurredAt)}">${escapeHtml(entry.occurredAt)}</time>${type}${audience}</div>${paragraphs}${fields}${assets}</article>`;
}

function attachmentMarkup(
  assets: readonly AssetDescriptorV1[],
  embeddedAssets: ReadonlyMap<string, TranscriptEmbeddedAssetV2>,
): string {
  const items = uniqueAssets(assets).map((asset) => {
    const embedded = embeddedAssets.get(asset.assetId);
    const summary = escapeHtml(assetSummary(asset));
    if (embedded && embedded.mediaType !== asset.mediaType) {
      throw new Error(`Embedded transcript asset media type does not match ${asset.assetId}`);
    }
    if (!embedded?.base64) {
      const reason = embedded?.unavailableReason ?? "导出时没有取得这份本机媒体";
      return `<figure class="attachment"><div class="asset-missing">媒体未嵌入：${escapeHtml(reason)}</div><figcaption>${summary}</figcaption></figure>`;
    }
    const source = `data:${embedded.mediaType};base64,${embedded.base64}`;
    const media = embedded.mediaType.startsWith("image/")
      ? `<img src="${source}" alt="记录附件">`
      : embedded.mediaType.startsWith("audio/")
        ? `<audio controls preload="metadata" src="${source}">当前浏览器无法播放此音频。</audio>`
        : `<div class="asset-missing">该媒体格式不能直接显示。</div>`;
    return `<figure class="attachment">${media}<figcaption>${summary}</figcaption></figure>`;
  }).join("");
  return `<div class="attachments">${items}</div>`;
}

function normalizeEmbeddedAssets(
  candidates: readonly TranscriptEmbeddedAssetV2[],
): ReadonlyMap<string, TranscriptEmbeddedAssetV2> {
  const values = new Map<string, TranscriptEmbeddedAssetV2>();
  let totalBase64Characters = 0;
  for (const candidate of candidates) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(candidate.assetId)) throw new Error("Embedded transcript asset ID is invalid");
    if (!/^(?:image\/(?:jpeg|png|webp)|audio\/(?:mpeg|ogg|wav))$/u.test(candidate.mediaType)) {
      throw new Error("Embedded transcript asset media type is unsupported");
    }
    if ((candidate.base64 === undefined) === (candidate.unavailableReason === undefined)) {
      throw new Error("Embedded transcript asset must contain bytes or one omission reason");
    }
    if (candidate.base64 !== undefined && (
      candidate.base64.length === 0
      || candidate.base64.length > 24 * 1024 * 1024
      || candidate.base64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(candidate.base64)
    )) throw new Error("Embedded transcript asset Base64 is invalid");
    totalBase64Characters += candidate.base64?.length ?? 0;
    if (totalBase64Characters > 44 * 1024 * 1024) throw new Error("Embedded transcript media exceeds the HTML export limit");
    if (candidate.unavailableReason !== undefined && (
      candidate.unavailableReason.length < 1 || candidate.unavailableReason.length > 240
    )) throw new Error("Embedded transcript asset omission reason is invalid");
    if (values.has(candidate.assetId)) throw new Error(`Duplicate embedded transcript asset: ${candidate.assetId}`);
    values.set(candidate.assetId, candidate);
  }
  return values;
}

function uniqueAssets(assets: readonly AssetDescriptorV1[]): AssetDescriptorV1[] {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    if (seen.has(asset.assetId)) return false;
    seen.add(asset.assetId);
    return true;
  });
}

function definitionList(fields: ReadonlyArray<readonly [string, string]>): string {
  return `<dl>${fields.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
}

function formatUnknown(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nested: unknown) => typeof nested === "bigint" ? nested.toString() : nested, 2) ?? "null";
  } catch {
    return "[无法序列化]";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}()#+\-.!|])/g, "\\$1");
}

function escapeMarkdownBlock(value: string): string[] {
  return value.split(/\r?\n/).map(escapeMarkdown);
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported V2 transcript value: ${String(value)}`);
}
