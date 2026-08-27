import type { DiceRollResult } from "./dice.js";
import type { Coc7Character } from "./schemas/character.js";
import type { RoomEventV1 } from "./schemas/room.js";
import { roomEventSchema } from "./schemas/room.js";

export interface TranscriptExportOptions {
  readonly title?: string;
  readonly roomName?: string;
  readonly roomId?: string;
  readonly generatedAt?: Date | string;
}

export function exportEventsToMarkdown(
  candidateEvents: readonly RoomEventV1[],
  options: TranscriptExportOptions = {},
): string {
  const events = normalizeEvents(candidateEvents);
  const title = options.title ?? "CoC 跑团记录";
  const roomId = resolveRoomId(events, options.roomId);
  const generatedAt = normalizeDate(options.generatedAt);
  const lines = [
    `# ${escapeMarkdown(title)}`,
    "",
    `- 房间：${escapeMarkdown(options.roomName ?? roomId ?? "未指定")}`,
    ...(roomId === undefined ? [] : [`- 房间 ID：\`${escapeMarkdown(roomId)}\``]),
    `- 导出时间：${escapeMarkdown(generatedAt)}`,
    `- 事件数：${events.length}`,
    "",
    "## 记录",
    "",
  ];

  if (events.length === 0) {
    lines.push("_暂无记录。_", "");
  } else {
    for (const event of events) {
      lines.push(...eventToMarkdown(event), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function exportEventsToHtml(
  candidateEvents: readonly RoomEventV1[],
  options: TranscriptExportOptions = {},
): string {
  const events = normalizeEvents(candidateEvents);
  const title = options.title ?? "CoC 跑团记录";
  const roomId = resolveRoomId(events, options.roomId);
  const roomName = options.roomName ?? roomId ?? "未指定";
  const generatedAt = normalizeDate(options.generatedAt);
  const eventMarkup =
    events.length === 0
      ? '<p class="empty">暂无记录。</p>'
      : events.map((event) => eventToHtml(event)).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.6; }
    body { margin: 0 auto; max-width: 920px; padding: 2rem 1.25rem 4rem; background: Canvas; color: CanvasText; }
    header { border-bottom: 1px solid color-mix(in srgb, CanvasText 20%, transparent); margin-bottom: 1.5rem; }
    h1 { line-height: 1.2; margin-bottom: .5rem; }
    .meta { color: color-mix(in srgb, CanvasText 68%, transparent); display: flex; flex-wrap: wrap; gap: .4rem 1.25rem; padding: 0; list-style: none; }
    .event { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: .65rem; margin: .8rem 0; padding: .8rem 1rem; break-inside: avoid; }
    .event-header { align-items: baseline; display: flex; flex-wrap: wrap; gap: .3rem .8rem; margin-bottom: .45rem; }
    .sequence { color: color-mix(in srgb, CanvasText 60%, transparent); font-variant-numeric: tabular-nums; }
    .sender { font-weight: 700; }
    time, .type { color: color-mix(in srgb, CanvasText 62%, transparent); font-size: .88rem; }
    .body { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem .9rem; margin: .5rem 0 0; }
    dt { font-weight: 650; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .revealed { border-left: .3rem solid #98733f; padding-left: .8rem; }
    .empty { font-style: italic; }
    @media print { body { max-width: none; padding: 0; } .event { border-color: #aaa; } }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <ul class="meta">
      <li>房间：${escapeHtml(roomName)}</li>
      ${roomId === undefined ? "" : `<li>房间 ID：${escapeHtml(roomId)}</li>`}
      <li>导出时间：${escapeHtml(generatedAt)}</li>
      <li>事件数：${events.length}</li>
    </ul>
  </header>
  <main>
${eventMarkup}
  </main>
</body>
</html>
`;
}

function normalizeEvents(candidateEvents: readonly RoomEventV1[]): RoomEventV1[] {
  const events = roomEventSchema.array().parse(candidateEvents);
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const event of events) {
    if (ids.has(event.eventId)) throw new Error(`Duplicate event ID: ${event.eventId}`);
    if (sequences.has(event.sequence)) throw new Error(`Duplicate event sequence: ${event.sequence}`);
    ids.add(event.eventId);
    sequences.add(event.sequence);
  }
  return [...events].sort((left, right) => left.sequence - right.sequence);
}

function resolveRoomId(events: readonly RoomEventV1[], explicitRoomId?: string): string | undefined {
  const roomIds = new Set(events.map((event) => event.roomId));
  if (explicitRoomId !== undefined) roomIds.add(explicitRoomId);
  if (roomIds.size > 1) {
    throw new Error("Cannot export events from multiple rooms in one transcript");
  }
  return roomIds.values().next().value;
}

function normalizeDate(value?: Date | string): string {
  if (value === undefined) return new Date().toISOString();
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.valueOf())) throw new Error("generatedAt must be a valid date");
  return date.toISOString();
}

function markdownHeading(event: RoomEventV1, label: string): string {
  return `### ${event.sequence.toString().padStart(6, "0")} · ${escapeMarkdown(label)}`;
}

function markdownMetadata(event: RoomEventV1): string {
  return `_${escapeMarkdown(event.occurredAt)} · ${escapeMarkdown(event.sender.displayName)}_`;
}

function eventToMarkdown(event: RoomEventV1): string[] {
  switch (event.type) {
    case "chat.message":
      return [
        markdownHeading(event, "聊天"),
        markdownMetadata(event),
        "",
        ...escapeMarkdownBlock(event.payload.message),
      ];
    case "system.notice":
      return [
        markdownHeading(event, `系统 · ${event.payload.level}`),
        markdownMetadata(event),
        "",
        ...escapeMarkdownBlock(event.payload.message),
      ];
    case "dice.result":
      return [
        markdownHeading(event, "骰子"),
        markdownMetadata(event),
        "",
        `- 原因：${escapeMarkdown(event.payload.reason || "未注明")}`,
        ...diceToMarkdown(event.payload.result),
      ];
    case "character.updated":
      return [
        markdownHeading(event, "角色卡更新"),
        markdownMetadata(event),
        "",
        ...characterToMarkdown(event.payload.character),
      ];
    case "module.switched":
      return [
        markdownHeading(event, "切换模组"),
        markdownMetadata(event),
        "",
        `**${escapeMarkdown(event.payload.title)}**（修订 ${event.payload.revision}，ID：\`${escapeMarkdown(event.payload.moduleId)}\`）`,
      ];
    case "content.revealed":
      return [
        markdownHeading(event, `公开内容 · ${event.payload.contentType}`),
        markdownMetadata(event),
        "",
        `**${escapeMarkdown(event.payload.title)}**`,
        "",
        ...escapeMarkdownBlock(event.payload.body),
      ];
  }
}

function diceToMarkdown(result: DiceRollResult): string[] {
  if (result.kind === "standard") {
    return [
      `- 骰式：\`${escapeMarkdown(result.expression)}\``,
      `- 掷骰：${result.rolls.join("，")}${result.modifier === 0 ? "" : `；修正 ${signed(result.modifier)}`}`,
      `- 结果：**${result.total}**`,
    ];
  }
  return [
    `- 骰式：\`1d100\`${result.bonusDice > 0 ? `（${result.bonusDice} 个奖励骰）` : ""}${result.penaltyDice > 0 ? `（${result.penaltyDice} 个惩罚骰）` : ""}`,
    `- 候选：${result.candidates.join("，")}`,
    `- 结果：**${result.total}**`,
    ...(result.check === undefined
      ? []
      : [`- 检定：${escapeMarkdown(result.check.outcome)}（目标 ${result.check.target}，${result.check.success ? "成功" : "失败"}）`]),
  ];
}

function characterToMarkdown(character: Coc7Character): string[] {
  const attributes = Object.entries(character.characteristics)
    .map(([name, value]) => `${name.toUpperCase()} ${value}`)
    .join("，");
  return [
    `- 角色：**${escapeMarkdown(character.name)}**（玩家：${escapeMarkdown(character.playerName)}）`,
    `- 职业：${escapeMarkdown(character.occupation || "未填写")}；年龄：${character.age}`,
    `- 属性：${escapeMarkdown(attributes)}`,
    `- 状态：HP ${character.derived.hitPoints}/${character.derived.maxHitPoints}；MP ${character.derived.magicPoints}/${character.derived.maxMagicPoints}；SAN ${character.derived.sanity}/${character.derived.maxSanity}`,
    `- 技能数：${character.skills.length}；物品数：${character.inventory.length}`,
  ];
}

function eventToHtml(event: RoomEventV1): string {
  const header = `<div class="event-header"><span class="sequence">#${event.sequence.toString().padStart(6, "0")}</span><span class="sender">${escapeHtml(event.sender.displayName)}</span><time datetime="${escapeHtml(event.occurredAt)}">${escapeHtml(event.occurredAt)}</time><span class="type">${escapeHtml(event.type)}</span></div>`;
  let body: string;

  switch (event.type) {
    case "chat.message":
    case "system.notice":
      body = `<p class="body">${escapeHtml(event.payload.message)}</p>`;
      break;
    case "dice.result":
      body = diceToHtml(event.payload.result, event.payload.reason);
      break;
    case "character.updated":
      body = characterToHtml(event.payload.character);
      break;
    case "module.switched":
      body = `<p class="body">切换至 <strong>${escapeHtml(event.payload.title)}</strong>（修订 ${event.payload.revision}，ID：${escapeHtml(event.payload.moduleId)}）</p>`;
      break;
    case "content.revealed":
      body = `<div class="revealed"><strong>${escapeHtml(event.payload.title)}</strong><p class="body">${escapeHtml(event.payload.body)}</p></div>`;
      break;
  }
  return `    <article class="event event-${escapeHtml(event.type.replace(".", "-"))}">${header}${body}</article>`;
}

function diceToHtml(result: DiceRollResult, reason: string): string {
  const pairs: Array<[string, string]> = [["原因", reason || "未注明"]];
  if (result.kind === "standard") {
    pairs.push(
      ["骰式", result.expression],
      ["掷骰", `${result.rolls.join("，")}${result.modifier === 0 ? "" : `；修正 ${signed(result.modifier)}`}`],
      ["结果", String(result.total)],
    );
  } else {
    pairs.push(
      ["骰式", `1d100${result.bonusDice > 0 ? `（${result.bonusDice} 个奖励骰）` : ""}${result.penaltyDice > 0 ? `（${result.penaltyDice} 个惩罚骰）` : ""}`],
      ["候选", result.candidates.join("，")],
      ["结果", String(result.total)],
    );
    if (result.check !== undefined) {
      pairs.push(["检定", `${result.check.outcome}（目标 ${result.check.target}，${result.check.success ? "成功" : "失败"}）`]);
    }
  }
  return definitionList(pairs);
}

function characterToHtml(character: Coc7Character): string {
  const attributes = Object.entries(character.characteristics)
    .map(([name, value]) => `${name.toUpperCase()} ${value}`)
    .join("，");
  return definitionList([
    ["角色", `${character.name}（玩家：${character.playerName}）`],
    ["职业", character.occupation || "未填写"],
    ["年龄", String(character.age)],
    ["属性", attributes],
    ["状态", `HP ${character.derived.hitPoints}/${character.derived.maxHitPoints}；MP ${character.derived.magicPoints}/${character.derived.maxMagicPoints}；SAN ${character.derived.sanity}/${character.derived.maxSanity}`],
    ["条目", `技能 ${character.skills.length}；物品 ${character.inventory.length}`],
  ]);
}

function definitionList(pairs: ReadonlyArray<readonly [string, string]>): string {
  return `<dl>${pairs.map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
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
  return value.split(/\r?\n/).map((line) => escapeMarkdown(line));
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
