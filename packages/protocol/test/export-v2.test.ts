import { describe, expect, it } from "vitest";

import {
  exportEventsV2ToHtml,
  exportEventsV2ToMarkdown,
  projectRoomEventV2,
  roomEventV2Schema,
  type RoomEventV2,
  type RoomEventViewV2,
  type SeatV2,
} from "../src";

const ROOM_ID = "room-export-v2";
const ROOM_AUDIENCE = { kind: "room" } as const;
const HOST: SeatV2 = {
  seatId: "seat-host",
  role: "host",
  displayName: "KP",
  peerId: "peer-host",
  extensions: {},
};
const ALICE: SeatV2 = {
  seatId: "seat-alice",
  role: "player",
  displayName: "Alice",
  peerId: "peer-alice",
  extensions: {},
};
const BOB: SeatV2 = {
  seatId: "seat-bob",
  role: "player",
  displayName: "Bob",
  peerId: "peer-bob",
  extensions: {},
};

describe("V2 transcript exports", () => {
  it("keeps a redacted sequence placeholder without leaking text, type, or resource hash", () => {
    const hash = "b".repeat(64);
    const secret = event(2, {
      type: "artifact.upserted",
      audience: { kind: "seats", seatIds: [ALICE.seatId] },
      payload: {
        artifact: {
          schemaVersion: 2,
          artifactId: "artifact-secret",
          revision: 1,
          kind: "handout-image",
          title: "诱饵秘密：地下祭坛",
          description: "Bob 不应知道",
          body: "绝不能出现在 Bob 的导出里",
          attachments: [{
            schemaVersion: 1,
            assetId: `sha256:${hash}`,
            mediaType: "image/webp",
            byteLength: 512,
            width: 64,
            height: 64,
          }],
          audience: { kind: "seats", seatIds: [ALICE.seatId] },
          locked: false,
          archived: false,
          extensions: {},
        },
      },
    });
    const publicChat = event(1, {
      type: "chat.message",
      audience: ROOM_AUDIENCE,
      payload: { message: "公开内容", format: "plain" },
    });
    const views = [
      projectRoomEventV2(secret, BOB),
      projectRoomEventV2(publicChat, BOB),
    ];

    const markdown = exportEventsV2ToMarkdown(views, fixedOptions());
    expect(markdown.indexOf("000001")).toBeLessThan(markdown.indexOf("000002"));
    expect(markdown).toContain("受限事件");
    expect(markdown).toContain("受限占位数：1");
    expect(markdown).not.toContain("诱饵秘密");
    expect(markdown).not.toContain("artifact.upserted");
    expect(markdown).not.toContain(hash);

    const secretBase64 = "UklGRlNFQ1JFVA==";
    const html = exportEventsV2ToHtml(views, {
      ...fixedOptions(),
      embeddedAssets: [{ assetId: `sha256:${hash}`, mediaType: "image/webp", base64: secretBase64 }],
    });
    expect(html).toContain("受限事件");
    expect(html).not.toContain("Bob 不应知道");
    expect(html).not.toContain("artifact.upserted");
    expect(html).not.toContain(hash);
    expect(html).not.toContain(secretBase64);
  });

  it("embeds visible local media as data URLs and explains unavailable media without scripts", () => {
    const imageHash = "a".repeat(64);
    const audioHash = "d".repeat(64);
    const visible = event(1, {
      type: "artifact.upserted",
      audience: ROOM_AUDIENCE,
      payload: {
        artifact: {
          schemaVersion: 2,
          artifactId: "artifact-visible-handout",
          revision: 1,
          kind: "handout-image",
          title: "公开照片",
          description: "已经交给调查员",
          body: "照片背面写着日期。",
          attachments: [
            { schemaVersion: 1, assetId: `sha256:${imageHash}`, mediaType: "image/webp", byteLength: 12, width: 10, height: 10 },
            { schemaVersion: 1, assetId: `sha256:${audioHash}`, mediaType: "audio/ogg", byteLength: 20 },
          ],
          audience: ROOM_AUDIENCE,
          locked: false,
          archived: false,
          extensions: {},
        },
      },
    });
    const imageBase64 = "UklGRkZBS0VXRUJQ";

    const html = exportEventsV2ToHtml([{ view: "full", event: visible }], {
      ...fixedOptions(),
      embeddedAssets: [
        { assetId: `sha256:${imageHash}`, mediaType: "image/webp", base64: imageBase64 },
        { assetId: `sha256:${audioHash}`, mediaType: "audio/ogg", unavailableReason: "音频超过离线网页上限" },
      ],
    });

    expect(html).toContain(`src="data:image/webp;base64,${imageBase64}"`);
    expect(html).toContain("离线媒体：1 / 2 个已嵌入");
    expect(html).toContain("媒体未嵌入：音频超过离线网页上限");
    expect(html).toContain("img-src data:");
    expect(html).toContain("media-src data:");
    expect(html).not.toMatch(/<script\b/iu);
  });

  it("escapes all untrusted HTML metadata and event content", () => {
    const hostile = event(1, {
      type: "chat.message",
      audience: ROOM_AUDIENCE,
      payload: { message: '<script>alert("event")</script> & 仍可阅读', format: "plain" },
    }, {
      ...HOST,
      displayName: '<img src=x onerror="alert(1)">',
    });

    const html = exportEventsV2ToHtml([{ view: "full", event: hostile }], {
      title: "<危险标题>",
      roomName: '<svg onload="alert(2)">',
      seatName: "A&B",
      seatId: '"><script>alert(3)</script>',
      generatedAt: "2026-08-29T12:30:00.000Z",
    });

    expect(html).toContain("&lt;危险标题&gt;");
    expect(html).toContain("&lt;script&gt;alert(&quot;event&quot;)&lt;/script&gt; &amp; 仍可阅读");
    expect(html).toContain("A&amp;B");
    expect(html).not.toMatch(/<(?:script|img|svg)\b/i);
    expect(html).toContain("Content-Security-Policy");
  });

  it("sorts and renders representative NPC, audio, and board events", () => {
    const npcMessage = event(1, {
      type: "npc.session.message",
      audience: ROOM_AUDIENCE,
      payload: {
        sessionId: "session-curator",
        messageId: uuid(101),
        role: "npc",
        spokenText: "馆长压低声音：不要触碰那只蝶。",
        stageDirection: "指向玻璃展柜",
        emotion: "紧张",
      },
    });
    const audio = event(2, {
      type: "audio.cued",
      audience: ROOM_AUDIENCE,
      payload: {
        cueId: "cue-rain",
        asset: {
          schemaVersion: 1,
          assetId: `sha256:${"c".repeat(64)}`,
          mediaType: "audio/ogg",
          byteLength: 4_096,
          durationMs: 12_000,
        },
        loop: true,
        volume: 0.45,
        fadeInMs: 1_500,
        startOffsetMs: 250,
      },
    });
    const board = event(3, {
      type: "board.created",
      audience: ROOM_AUDIENCE,
      payload: {
        board: {
          schemaVersion: 1,
          boardId: "board-museum",
          revision: 1,
          kind: "scene",
          name: "博物馆大厅",
          description: "雨夜中的展厅",
          audience: ROOM_AUDIENCE,
          logicalSize: { width: 10_000, height: 8_000 },
          archived: false,
          items: [],
          edges: [],
          extensions: {},
        },
      },
    });
    const views: RoomEventViewV2[] = [board, npcMessage, audio].map((value) => ({
      view: "full" as const,
      event: value,
    }));

    const markdown = exportEventsV2ToMarkdown(views, fixedOptions());
    expect(markdown.indexOf("000001")).toBeLessThan(markdown.indexOf("000002"));
    expect(markdown.indexOf("000002")).toBeLessThan(markdown.indexOf("000003"));
    expect(markdown).toContain("NPC 互动消息");
    expect(markdown).toContain("馆长压低声音");
    expect(markdown).toContain("开始播放音频");
    expect(markdown).toContain("房主基准音量：45%");
    expect(markdown).toContain("创建画板");
    expect(markdown).toContain("博物馆大厅");

    const html = exportEventsV2ToHtml(views, fixedOptions());
    expect(html).toContain("NPC 互动消息");
    expect(html).toContain("audio/ogg");
    expect(html).toContain("board-museum");
  });

  it("exports a human NPC-panel message with its real seat name", () => {
    const humanMessage = event(1, {
      type: "npc.session.message",
      audience: ROOM_AUDIENCE,
      payload: {
        sessionId: "session-curator",
        messageId: uuid(102),
        role: "human",
        speakerSeatId: ALICE.seatId,
        spokenText: "我想问问昨晚闭馆后的事。",
      },
    }, ALICE);
    const views: RoomEventViewV2[] = [{ view: "full", event: humanMessage }];

    const markdown = exportEventsV2ToMarkdown(views, fixedOptions());
    expect(markdown).toContain("发言身份：Alice");
    expect(markdown).not.toContain("发言身份：调查员");
  });

  it("keeps an NPC panel's terminal timestamp in the exported record", () => {
    const endedAt = "2026-08-29T12:05:00.000Z";
    const closed = event(1, {
      type: "npc.session.upserted",
      audience: ROOM_AUDIENCE,
      payload: {
        session: {
          schemaVersion: 1,
          sessionId: "session-ended",
          revision: 2,
          npcEntityId: "npc-curator",
          title: "与馆长交谈",
          description: "这段交谈已经结束",
          status: "closed",
          audience: ROOM_AUDIENCE,
          provider: "codex",
          model: "",
          autoReply: false,
          mode: "shadow",
          pinnedContext: [],
          startedAt: "2026-08-29T12:00:00.000Z",
          endedAt,
          extensions: {},
        },
      },
    });

    const markdown = exportEventsV2ToMarkdown([{ view: "full", event: closed }], fixedOptions());
    expect(markdown).toContain("结束时间：");
    expect(markdown).toContain("2026\\-08\\-29T12:05:00\\.000Z");
    expect(markdown).toContain("自动回复：已关闭");
  });

  it("describes an authoritative current-scene change in human language", () => {
    const focused = event(1, {
      type: "scene.focused",
      audience: ROOM_AUDIENCE,
      payload: { sceneEntityId: "scene-museum-foyer" },
    });
    const views: RoomEventViewV2[] = [{ view: "full", event: focused }];

    const markdown = exportEventsV2ToMarkdown(views, fixedOptions());
    expect(markdown).toContain("推进当前场景");
    expect(markdown).toContain("KP 将跑团焦点切换到了新的场景");
    expect(markdown).toContain("scene\\-museum\\-foyer");

    const html = exportEventsV2ToHtml(views, fixedOptions());
    expect(html).toContain("推进当前场景");
    expect(html).toContain("KP 将跑团焦点切换到了新的场景");
    expect(html).toContain("scene-museum-foyer");
  });

  it("exports personal clue removal as a focus change rather than a shared-clue edit", () => {
    const focused = event(1, {
      type: "clue.claimed",
      audience: ROOM_AUDIENCE,
      payload: {
        artifactId: "clue-reversed-score",
        characterId: "character-alice",
        characterName: "Alice",
      },
    }, ALICE);
    const unfocused = event(2, {
      type: "clue.unclaimed",
      audience: ROOM_AUDIENCE,
      payload: {
        artifactId: "clue-reversed-score",
        characterId: "character-alice",
        characterName: "Alice",
      },
    }, ALICE);
    const views: RoomEventViewV2[] = [focused, unfocused].map((value) => ({
      view: "full" as const,
      event: value,
    }));

    const markdown = exportEventsV2ToMarkdown(views, fixedOptions());
    expect(markdown).toContain("关注线索");
    expect(markdown).toContain("取消关注线索");
    expect(markdown).toContain("不再将这条公开线索标记为个人重点");
    expect(markdown).not.toContain("归档");

    const html = exportEventsV2ToHtml(views, fixedOptions());
    expect(html).toContain("取消关注线索");
    expect(html).toContain("clue-reversed-score");
  });

  it("exports a no-roll check ruling as a human-readable terminal result", () => {
    const closed = event(1, {
      type: "check.closed",
      audience: ROOM_AUDIENCE,
      payload: {
        requestId: "check-library-use",
        outcome: "no-roll",
        note: "档案按年份排列，你无需检定就找到了登记册。",
      },
    });
    const views: RoomEventViewV2[] = [{ view: "full", event: closed }];

    const markdown = exportEventsV2ToMarkdown(views, fixedOptions());
    expect(markdown).toContain("KP 裁定无需掷骰");
    expect(markdown).toContain("档案按年份排列");
    expect(markdown).toContain("处理结果：无需掷骰");

    const html = exportEventsV2ToHtml(views, fixedOptions());
    expect(html).toContain("KP 裁定无需掷骰");
    expect(html).toContain("check-library-use");
  });

  it("exports the Keeper's request-linked description of a rolled outcome", () => {
    const described = event(1, {
      type: "check.outcome.described",
      audience: ROOM_AUDIENCE,
      payload: {
        requestId: "check-listen-wall",
        text: "墙后传来有规律的敲击声，像是在重复一串数字。",
      },
    });
    const views: RoomEventViewV2[] = [{ view: "full", event: described }];

    const markdown = exportEventsV2ToMarkdown(views, fixedOptions());
    expect(markdown).toContain("KP 描述检定结果");
    expect(markdown).toContain("墙后传来有规律的敲击声");
    expect(markdown).toContain("申请 ID：check\\-listen\\-wall");

    const html = exportEventsV2ToHtml(views, fixedOptions());
    expect(html).toContain("KP 描述检定结果");
    expect(html).toContain("check-listen-wall");
  });

  it("keeps the new approach and declared risk in an exported pushed roll", () => {
    const pushed = event(1, {
      type: "check.requested",
      audience: ROOM_AUDIENCE,
      payload: {
        requestId: "check-door-push",
        characterId: "character-alice",
        characterName: "Alice",
        skillName: "STR",
        suggestedSkillName: "STR",
        proposedTarget: 50,
        goal: "打开封死的地窖门",
        approach: "改用铁锹作杠杆撬门。",
        reason: "改用铁锹作杠杆撬门。",
        pushOfRequestId: "check-door",
      },
    }, ALICE);
    const authorized = event(2, {
      type: "check.authorized",
      audience: ROOM_AUDIENCE,
      payload: {
        requestId: "check-door-push",
        skillName: "STR",
        target: 50,
        requiredDifficulty: "regular",
        bonusDice: 0,
        penaltyDice: 0,
        note: "可以强推，但先听清风险。",
        failureConsequence: "巨响会惊醒地窖里的东西。",
      },
    });
    const views: RoomEventViewV2[] = [pushed, authorized].map((value) => ({ view: "full", event: value }));

    const markdown = exportEventsV2ToMarkdown(views, fixedOptions());
    expect(markdown).toContain("申请强推");
    expect(markdown).toContain("目标：打开封死的地窖门");
    expect(markdown).toContain("做法：改用铁锹作杠杆撬门");
    expect(markdown).toContain("KP 采用技能：STR");
    expect(markdown).toContain("KP 允许强推");
    expect(markdown).toContain("强推失败代价：巨响会惊醒地窖里的东西");

    const html = exportEventsV2ToHtml(views, fixedOptions());
    expect(html).toContain("申请强推");
    expect(html).toContain("巨响会惊醒地窖里的东西");
  });
});

function event(
  sequence: number,
  body: Pick<RoomEventV2, "type" | "audience" | "payload">,
  sender: SeatV2 = HOST,
): RoomEventV2 {
  return roomEventV2Schema.parse({
    protocolVersion: 2,
    roomId: ROOM_ID,
    eventId: uuid(sequence),
    sequence,
    sender,
    occurredAt: `2026-08-29T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...body,
  });
}

function fixedOptions() {
  return {
    roomName: "见世之蝶",
    generatedAt: "2026-08-29T12:30:00.000Z",
  } as const;
}

function uuid(value: number): string {
  return `60000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}
