import { z } from "zod";

import { diceRollResultSchema } from "../dice.js";
import { coc7CharacterSchema } from "./character.js";
import {
  entityIdSchema,
  extensionsSchema,
  isoDateTimeSchema,
  peerIdSchema,
  roomIdSchema,
} from "./common.js";

const eventIdV2Schema = z.string().uuid();
const commandIdV2Schema = z.string().uuid();
const revisionSchema = z.number().int().positive();

/**
 * Hosts are implicit members of every audience. `seats` therefore describes
 * the non-host seats that may receive a payload, while `room` means every
 * authenticated seat in the room.
 */
export const audienceV2Schema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("room") }).strict(),
    z.object({ kind: z.literal("host") }).strict(),
    z
      .object({
        kind: z.literal("seats"),
        seatIds: z.array(entityIdSchema).min(1).max(8),
      })
      .strict(),
  ])
  .superRefine((audience, context) => {
    if (audience.kind === "seats" && new Set(audience.seatIds).size !== audience.seatIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["seatIds"],
        message: "audience seat IDs must be unique",
      });
    }
  });

export const seatV2Schema = z
  .object({
    seatId: entityIdSchema,
    role: z.enum(["host", "player"]),
    displayName: z.string().trim().min(1).max(80),
    peerId: peerIdSchema.optional(),
    extensions: extensionsSchema,
  })
  .strict();

/** A seat-scoped invitation; unlike V1, one token identifies one stable seat. */
export const roomInvitationPayloadV2Schema = z
  .object({
    protocolVersion: z.literal(2),
    roomId: roomIdSchema,
    /** Human label used to identify this investigation in the invitee's local history. */
    roomName: z.string().trim().min(1).max(120).optional(),
    seatId: entityIdSchema,
    role: z.literal("player"),
    relayToken: z.string().min(20).max(128),
    seatSecret: z.string().min(32).max(256),
    credentialVersion: z.number().int().positive().default(1),
    hostSeatId: entityIdSchema,
    hostPeerId: peerIdSchema,
    relayUrl: z.string().url(),
    expiresAt: isoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((invitation, context) => {
    if (invitation.seatId === invitation.hostSeatId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["seatId"],
        message: "a player invitation cannot target the host seat",
      });
    }
  });

/** Alias retained for callers that use the shorter invitation name. */
export const invitationPayloadV2Schema = roomInvitationPayloadV2Schema;
export const roomInvitePayloadV2Schema = roomInvitationPayloadV2Schema;

export const assetDescriptorV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    assetId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    mediaType: z
      .string()
      .min(3)
      .max(127)
      .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
    byteLength: z.number().int().positive().max(256 * 1024 * 1024),
    width: z.number().int().positive().max(16_384).optional(),
    height: z.number().int().positive().max(16_384).optional(),
    durationMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1_000).optional(),
  })
  .strict()
  .superRefine((asset, context) => {
    if ((asset.width === undefined) !== (asset.height === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: asset.width === undefined ? ["width"] : ["height"],
        message: "asset width and height must be provided together",
      });
    }
  });

export const roomArtifactV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    artifactId: entityIdSchema,
    revision: revisionSchema,
    kind: z.enum([
      "clue",
      "handout",
      "note",
      "image",
      "file",
      "location-background",
      "npc-portrait",
      "handout-image",
      "map-background",
      "ambience-audio",
      "document",
      "other",
    ]),
    title: z.string().min(1).max(240),
    description: z.string().max(4_000),
    body: z.string().max(50_000).default(""),
    attachments: z.array(assetDescriptorV1Schema).max(32).default([]),
    /** Compatibility shortcut for single-asset visual artifacts. */
    asset: assetDescriptorV1Schema.optional(),
    sourceEntityId: entityIdSchema.optional(),
    audience: audienceV2Schema,
    locked: z.boolean().default(false),
    archived: z.boolean().default(false),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    const descriptors = [...artifact.attachments, ...(artifact.asset ? [artifact.asset] : [])];
    if (new Set(descriptors.map(({ assetId }) => assetId)).size !== descriptors.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attachments"],
        message: "artifact asset IDs must be unique",
      });
    }
    if (!artifact.body && descriptors.length === 0 && ["clue", "handout", "note", "image", "file"].includes(artifact.kind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: "a room artifact requires text or an attachment",
      });
    }
  });

/**
 * A location, NPC, clue, character, or other room-visible concept. NPCs are
 * intentionally independent of locations and boards; placement is a board
 * item concern, so the same NPC may appear on multiple boards.
 */
export const roomEntityV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    entityId: entityIdSchema,
    revision: revisionSchema,
    kind: z.enum(["location", "npc", "character", "clue", "handout", "scene", "custom"]),
    name: z.string().min(1).max(240),
    description: z.string().max(20_000),
    artifactIds: z.array(entityIdSchema).max(100),
    audience: audienceV2Schema,
    data: z.record(z.unknown()),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((entity, context) => {
    if (new Set(entity.artifactIds).size !== entity.artifactIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifactIds"],
        message: "entity artifact IDs must be unique",
      });
    }
  });

export const boardPointV1Schema = z
  .object({
    x: z.number().int().min(0).max(10_000),
    y: z.number().int().min(0).max(10_000),
  })
  .strict();

export const boardSizeV1Schema = z
  .object({
    width: z.number().int().positive().max(10_000),
    height: z.number().int().positive().max(10_000),
  })
  .strict();

export const boardItemReferenceV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), entityId: entityIdSchema }).strict(),
  z.object({ kind: z.literal("artifact"), artifactId: entityIdSchema }).strict(),
  z.object({ kind: z.literal("npc-session"), sessionId: entityIdSchema }).strict(),
  z.object({ kind: z.literal("text"), text: z.string().max(20_000) }).strict(),
]);

export const boardItemV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    itemId: entityIdSchema,
    reference: boardItemReferenceV1Schema,
    label: z.string().max(240),
    position: boardPointV1Schema,
    size: boardSizeV1Schema.optional(),
    rotationDegrees: z.number().min(-360).max(360).default(0),
    scale: z.number().min(0.05).max(20).default(1),
    zIndex: z.number().int().min(-10_000).max(10_000).default(0),
    locked: z.boolean().default(false),
    audience: audienceV2Schema,
    extensions: extensionsSchema,
  })
  .strict();

export const boardEdgeV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    edgeId: entityIdSchema,
    fromItemId: entityIdSchema,
    toItemId: entityIdSchema,
    kind: z.string().min(1).max(120),
    label: z.string().max(500),
    audience: audienceV2Schema,
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((edge, context) => {
    if (edge.fromItemId === edge.toItemId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toItemId"],
        message: "a board edge must connect two different items",
      });
    }
  });

export const fogRevealRegionV1Schema = z
  .object({
    regionId: entityIdSchema,
    points: z.array(boardPointV1Schema).min(3).max(1_024),
  })
  .strict();

export const fogMaskV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    maskId: entityIdSchema,
    revision: revisionSchema,
    mode: z.literal("cover-all"),
    audience: audienceV2Schema,
    revealedRegions: z.array(fogRevealRegionV1Schema).max(10_000),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((mask, context) => {
    if (new Set(mask.revealedRegions.map(({ regionId }) => regionId)).size !== mask.revealedRegions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revealedRegions"],
        message: "fog reveal region IDs must be unique",
      });
    }
  });

export const boardV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    boardId: entityIdSchema,
    revision: revisionSchema,
    kind: z.enum(["scene", "map", "evidence"]),
    name: z.string().min(1).max(240),
    description: z.string().max(4_000),
    audience: audienceV2Schema,
    logicalSize: boardSizeV1Schema.default({ width: 10_000, height: 10_000 }),
    backgroundArtifactId: entityIdSchema.optional(),
    archived: z.boolean().default(false),
    items: z.array(boardItemV1Schema).max(5_000),
    edges: z.array(boardEdgeV1Schema).max(10_000),
    fogMask: fogMaskV1Schema.optional(),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((board, context) => {
    const itemIds = new Set<string>();
    const items = new Map<string, z.infer<typeof boardItemV1Schema>>();
    board.items.forEach((item, index) => {
      if (itemIds.has(item.itemId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "itemId"],
          message: `duplicate board item ID: ${item.itemId}`,
        });
      }
      itemIds.add(item.itemId);
      items.set(item.itemId, item);
      if (!isSameAudienceV2(item.audience, board.audience)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "audience"],
          message: "board items embedded in a snapshot must use the board audience",
        });
      }
    });

    const edgeIds = new Set<string>();
    board.edges.forEach((edge, index) => {
      if (edgeIds.has(edge.edgeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index, "edgeId"],
          message: `duplicate board edge ID: ${edge.edgeId}`,
        });
      }
      edgeIds.add(edge.edgeId);
      const from = items.get(edge.fromItemId);
      const to = items.get(edge.toItemId);
      if (from === undefined || to === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index],
          message: "board edge endpoints must reference existing items",
        });
      } else if (
        !isSameAudienceV2(edge.audience, board.audience) ||
        !isSameAudienceV2(edge.audience, from.audience) ||
        !isSameAudienceV2(edge.audience, to.audience)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index, "audience"],
          message: "board edges embedded in a snapshot must use the board and endpoint audience",
        });
      }
    });

    if (board.fogMask !== undefined && !isSameAudienceV2(board.fogMask.audience, board.audience)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fogMask", "audience"],
        message: "a fog mask embedded in a snapshot must use the board audience",
      });
    }
  });

export const npcInteractionSessionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: entityIdSchema,
    revision: revisionSchema,
    npcEntityId: entityIdSchema,
    title: z.string().min(1).max(240),
    description: z.string().max(4_000),
    status: z.enum(["active", "paused", "closed"]),
    audience: audienceV2Schema,
    provider: z.enum(["deepseek", "codex"]).default("codex"),
    model: z.string().max(200).default(""),
    autoReply: z.boolean().default(false),
    mode: z.enum(["shadow", "autonomous"]).default("shadow"),
    pinnedContext: z
      .array(z.object({
        pinId: entityIdSchema,
        title: z.string().min(1).max(240),
        body: z.string().max(100_000),
      }).strict())
      .max(64)
      .default([]),
    startedAt: isoDateTimeSchema,
    endedAt: isoDateTimeSchema.optional(),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((session, context) => {
    if (session.status === "closed" && session.endedAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endedAt"],
        message: "a closed NPC interaction session requires endedAt",
      });
    }
    if (session.status !== "closed" && session.endedAt !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endedAt"],
        message: "only a closed NPC interaction session may have endedAt",
      });
    }
    if (session.status === "closed" && session.autoReply) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["autoReply"],
        message: "a closed NPC interaction session cannot keep auto reply enabled",
      });
    }
  });

export const audienceTargetV2Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), eventId: eventIdV2Schema }).strict(),
  z.object({ kind: z.literal("entity"), entityId: entityIdSchema }).strict(),
  z.object({ kind: z.literal("artifact"), artifactId: entityIdSchema }).strict(),
  z.object({ kind: z.literal("board"), boardId: entityIdSchema }).strict(),
  z
    .object({ kind: z.literal("board-item"), boardId: entityIdSchema, itemId: entityIdSchema })
    .strict(),
  z
    .object({ kind: z.literal("board-edge"), boardId: entityIdSchema, edgeId: entityIdSchema })
    .strict(),
  z.object({ kind: z.literal("fog-mask"), boardId: entityIdSchema, maskId: entityIdSchema }).strict(),
  z.object({ kind: z.literal("npc-session"), sessionId: entityIdSchema }).strict(),
]);

export const roomEventV2BaseSchema = z.object({
  protocolVersion: z.literal(2),
  roomId: roomIdSchema,
  eventId: eventIdV2Schema,
  sequence: z.number().int().positive(),
  sender: seatV2Schema,
  occurredAt: isoDateTimeSchema,
  audience: audienceV2Schema,
  causedByCommandId: commandIdV2Schema.optional(),
});

export const chatMessageEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("chat.message"),
    payload: z.object({
      message: z.string().min(1).max(20_000),
      format: z.enum(["plain", "markdown"]),
      // "Speak as": the host voices an NPC directly in the shared story
      // stream, the way a keeper does at a real table. Host-only (enforced by
      // the reducer); entityId links the line to the NPC card when it exists.
      persona: z.object({
        name: z.string().min(1).max(160),
        entityId: z.string().min(1).max(120).optional(),
      }).strict().optional(),
    }).strict(),
  })
  .strict();

export const systemNoticeEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("system.notice"),
    payload: z.object({
      message: z.string().min(1).max(20_000),
      level: z.enum(["info", "warning", "error"]),
    }).strict(),
  })
  .strict();

export const diceResultEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("dice.result"),
    payload: z.object({
      result: diceRollResultSchema,
      reason: z.string().max(500),
      checkRequestId: entityIdSchema.optional(),
    }).strict(),
  })
  .strict();

export const characterUpdatedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("character.updated"),
    payload: z.object({ character: coc7CharacterSchema }).strict(),
  })
  .strict();

export const checkRequestedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("check.requested"),
    payload: z.object({
      requestId: entityIdSchema,
      characterId: entityIdSchema,
      characterName: z.string().min(1).max(160),
      /** Legacy skill label retained for replay and older clients. New clients
       * may additionally distinguish the player's suggestion from the skill
       * the Keeper ultimately authorizes. */
      skillName: z.string().min(1).max(160),
      proposedTarget: z.number().int().min(1).max(100).optional(),
      goal: z.string().min(1).max(1_000).optional(),
      approach: z.string().min(1).max(1_000).optional(),
      suggestedSkillName: z.string().min(1).max(160).optional(),
      reason: z.string().min(1).max(1_000),
      /** The first failed check this request is pushing. A pushed request may
       * never point at another pushed request. */
      pushOfRequestId: entityIdSchema.optional(),
    }).strict(),
  })
  .strict();

export const checkAuthorizedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("check.authorized"),
    payload: z.object({
      requestId: entityIdSchema,
      /** Keeper-authoritative skill. Older events omit it and replay with the
       * legacy skill recorded on check.requested. */
      skillName: z.string().min(1).max(160).optional(),
      target: z.number().int().min(1).max(100),
      requiredDifficulty: z.enum(["regular", "hard", "extreme"]),
      bonusDice: z.number().int().min(0).max(2),
      penaltyDice: z.number().int().min(0).max(2),
      note: z.string().max(4_000),
      /** Required when authorizing a pushed roll so the investigator can make
       * an informed choice before taking the one allowed reroll. */
      failureConsequence: z.string().min(1).max(4_000).optional(),
    }).strict().superRefine((payload, context) => {
      if (payload.bonusDice > 0 && payload.penaltyDice > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["penaltyDice"],
          message: "bonusDice and penaltyDice cannot both be positive",
        });
      }
    }),
  })
  .strict();

export const checkClosedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("check.closed"),
    payload: z.object({
      requestId: entityIdSchema,
      outcome: z.enum(["no-roll", "declined", "cancelled"]),
      note: z.string().min(1).max(4_000),
    }).strict(),
  })
  .strict();

export const checkOutcomeDescribedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("check.outcome.described"),
    payload: z.object({
      requestId: entityIdSchema,
      text: z.string().min(1).max(4_000),
    }).strict(),
  })
  .strict();

export const clueClaimedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("clue.claimed"),
    payload: z.object({
      artifactId: entityIdSchema,
      characterId: entityIdSchema,
      characterName: z.string().min(1).max(160),
    }).strict(),
  })
  .strict();

/** Removes one investigator's personal focus marker from a clue. This is a
 * first-class room event so replay can distinguish an intentional unclaim
 * from editing, archiving, or otherwise changing the shared clue itself. */
export const clueUnclaimedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("clue.unclaimed"),
    payload: z.object({
      artifactId: entityIdSchema,
      characterId: entityIdSchema,
      characterName: z.string().min(1).max(160),
    }).strict(),
  })
  .strict();

export const moduleSwitchedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("module.switched"),
    payload: z.object({
      moduleId: entityIdSchema,
      revision: revisionSchema,
      title: z.string().min(1).max(240),
    }).strict(),
  })
  .strict();

export const roomSettingsUpdatedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("room.settings.updated"),
    payload: z.object({
      defaultVisibility: z.enum(["public", "secret"]),
    }).strict(),
  })
  .strict();

export const entityUpsertedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("entity.upserted"),
    payload: z.object({ entity: roomEntityV2Schema }).strict(),
  })
  .strict();

/**
 * The host's authoritative narrative focus. The referenced scene remains an
 * independent room entity; the reducer verifies both its kind and audience.
 */
export const sceneFocusedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("scene.focused"),
    payload: z.object({ sceneEntityId: entityIdSchema }).strict(),
  })
  .strict();

export const artifactUpsertedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("artifact.upserted"),
    payload: z.object({ artifact: roomArtifactV2Schema }).strict(),
  })
  .strict();

export const boardCreatedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("board.created"),
    payload: z.object({ board: boardV1Schema }).strict(),
  })
  .strict();

export const boardUpdatedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("board.updated"),
    payload: z.object({ board: boardV1Schema }).strict(),
  })
  .strict();

export const boardActivatedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("board.activated"),
    payload: z.object({ boardId: entityIdSchema }).strict(),
  })
  .strict();

export const boardItemUpsertedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("board.item.upserted"),
    payload: z
      .object({
        boardId: entityIdSchema,
        boardRevision: revisionSchema,
        item: boardItemV1Schema,
      })
      .strict(),
  })
  .strict();

export const boardItemRemovedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("board.item.removed"),
    payload: z
      .object({
        boardId: entityIdSchema,
        boardRevision: revisionSchema,
        itemId: entityIdSchema,
      })
      .strict(),
  })
  .strict();

export const boardEdgeUpsertedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("board.edge.upserted"),
    payload: z
      .object({
        boardId: entityIdSchema,
        boardRevision: revisionSchema,
        edge: boardEdgeV1Schema,
      })
      .strict(),
  })
  .strict();

export const boardEdgeRemovedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("board.edge.removed"),
    payload: z
      .object({
        boardId: entityIdSchema,
        boardRevision: revisionSchema,
        edgeId: entityIdSchema,
      })
      .strict(),
  })
  .strict();

export const boardFogRevealedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("board.fog.revealed"),
    payload: z
      .object({
        boardId: entityIdSchema,
        boardRevision: revisionSchema,
        maskId: entityIdSchema,
        maskRevision: revisionSchema,
        region: fogRevealRegionV1Schema,
      })
      .strict(),
  })
  .strict();

export const audienceExpandedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("audience.expanded"),
    payload: z
      .object({
        target: audienceTargetV2Schema,
        audience: audienceV2Schema,
      })
      .strict(),
  })
  .strict();

export const npcSessionUpsertedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("npc.session.upserted"),
    payload: z.object({ session: npcInteractionSessionV1Schema }).strict(),
  })
  .strict();

export const npcSessionMessageEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("npc.session.message"),
    payload: z.object({
      sessionId: entityIdSchema,
      messageId: eventIdV2Schema,
      role: z.enum(["human", "npc", "system"]),
      speakerSeatId: entityIdSchema.optional(),
      spokenText: z.string().min(1).max(20_000),
      stageDirection: z.string().max(4_000).optional(),
      emotion: z.string().max(120).optional(),
    }).strict().superRefine((message, context) => {
      if (message.role === "human" && message.speakerSeatId === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["speakerSeatId"],
          message: "human NPC-panel messages require a speaker seat",
        });
      }
      if (message.role !== "human" && message.speakerSeatId !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["speakerSeatId"],
          message: "only human NPC-panel messages may identify a speaker seat",
        });
      }
    }),
  })
  .strict();

export const audioCuedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("audio.cued"),
    payload: z.object({
      cueId: entityIdSchema,
      asset: assetDescriptorV1Schema,
      loop: z.boolean(),
      volume: z.number().min(0).max(1),
      fadeInMs: z.number().int().nonnegative().max(60_000),
      startOffsetMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1_000),
    }).strict(),
  })
  .strict();

export const audioStoppedEventV2Schema = roomEventV2BaseSchema
  .extend({
    type: z.literal("audio.stopped"),
    payload: z.object({
      cueId: entityIdSchema,
      fadeOutMs: z.number().int().nonnegative().max(60_000),
    }).strict(),
  })
  .strict();

export const roomEventV2Schema = z.discriminatedUnion("type", [
  chatMessageEventV2Schema,
  systemNoticeEventV2Schema,
  diceResultEventV2Schema,
  characterUpdatedEventV2Schema,
  checkRequestedEventV2Schema,
  checkAuthorizedEventV2Schema,
  checkClosedEventV2Schema,
  checkOutcomeDescribedEventV2Schema,
  clueClaimedEventV2Schema,
  clueUnclaimedEventV2Schema,
  moduleSwitchedEventV2Schema,
  roomSettingsUpdatedEventV2Schema,
  entityUpsertedEventV2Schema,
  sceneFocusedEventV2Schema,
  artifactUpsertedEventV2Schema,
  boardCreatedEventV2Schema,
  boardUpdatedEventV2Schema,
  boardActivatedEventV2Schema,
  boardItemUpsertedEventV2Schema,
  boardItemRemovedEventV2Schema,
  boardEdgeUpsertedEventV2Schema,
  boardEdgeRemovedEventV2Schema,
  boardFogRevealedEventV2Schema,
  audienceExpandedEventV2Schema,
  npcSessionUpsertedEventV2Schema,
  npcSessionMessageEventV2Schema,
  audioCuedEventV2Schema,
  audioStoppedEventV2Schema,
]);

export const roomEventTypeV2Schema = z.enum([
  "chat.message",
  "system.notice",
  "dice.result",
  "character.updated",
  "check.requested",
  "check.authorized",
  "check.closed",
  "check.outcome.described",
  "clue.claimed",
  "clue.unclaimed",
  "module.switched",
  "room.settings.updated",
  "entity.upserted",
  "scene.focused",
  "artifact.upserted",
  "board.created",
  "board.updated",
  "board.activated",
  "board.item.upserted",
  "board.item.removed",
  "board.edge.upserted",
  "board.edge.removed",
  "board.fog.revealed",
  "audience.expanded",
  "npc.session.upserted",
  "npc.session.message",
  "audio.cued",
  "audio.stopped",
]);

/**
 * Commands deliberately carry a data-only event proposal. The host inserts
 * identity, sequence, event ID and time, then validates the resulting event
 * with roomEventV2Schema before it can reach persistence or peers.
 */
export const submitRoomEventCommandV2Schema = z
  .object({
    protocolVersion: z.literal(2),
    roomId: roomIdSchema,
    commandId: commandIdV2Schema,
    sender: seatV2Schema,
    sentAt: isoDateTimeSchema,
    type: z.literal("event.submit"),
    proposal: z.object({
      type: roomEventTypeV2Schema,
      audience: audienceV2Schema,
      payload: z.unknown(),
    }).strict(),
  })
  .strict();

export const rollDiceCommandV2Schema = z
  .object({
    protocolVersion: z.literal(2),
    roomId: roomIdSchema,
    commandId: commandIdV2Schema,
    sender: seatV2Schema,
    sentAt: isoDateTimeSchema,
    type: z.literal("dice.roll"),
    audience: audienceV2Schema,
    payload: z.object({
      expression: z.string().min(1).max(64),
      reason: z.string().max(500),
      bonusDice: z.number().int().min(0).max(2),
      penaltyDice: z.number().int().min(0).max(2),
      target: z.number().int().min(1).max(100).optional(),
      requiredDifficulty: z.enum(["regular", "hard", "extreme"]).optional(),
      checkRequestId: entityIdSchema.optional(),
    }).strict().superRefine((payload, context) => {
      if (payload.bonusDice > 0 && payload.penaltyDice > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["penaltyDice"],
          message: "bonusDice and penaltyDice cannot both be positive",
        });
      }
      if (payload.requiredDifficulty !== undefined && payload.target === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredDifficulty"],
          message: "requiredDifficulty requires a target",
        });
      }
      if (payload.checkRequestId !== undefined && (payload.target === undefined || payload.requiredDifficulty === undefined)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["checkRequestId"],
          message: "checkRequestId requires target and requiredDifficulty",
        });
      }
    }),
  })
  .strict();

export const roomCommandV2Schema = z.discriminatedUnion("type", [
  submitRoomEventCommandV2Schema,
  rollDiceCommandV2Schema,
]);

export const fullRoomEventViewV2Schema = z
  .object({
    view: z.literal("full"),
    event: roomEventV2Schema,
  })
  .strict();

/**
 * A redacted view preserves ordering and sender attribution but deliberately
 * omits event type, audience membership, and payload.
 */
export const redactedRoomEventViewV2Schema = z
  .object({
    view: z.literal("redacted"),
    protocolVersion: z.literal(2),
    roomId: roomIdSchema,
    eventId: eventIdV2Schema,
    sequence: z.number().int().positive(),
    occurredAt: isoDateTimeSchema,
  })
  .strict();

export const roomEventViewV2Schema = z.discriminatedUnion("view", [
  fullRoomEventViewV2Schema,
  redactedRoomEventViewV2Schema,
]);

export type AudienceV2 = z.infer<typeof audienceV2Schema>;
export type SeatV2 = z.infer<typeof seatV2Schema>;
export type RoomInvitationPayloadV2 = z.infer<typeof roomInvitationPayloadV2Schema>;
export type InvitationPayloadV2 = RoomInvitationPayloadV2;
export type RoomInvitePayloadV2 = RoomInvitationPayloadV2;
export type AssetDescriptorV1 = z.infer<typeof assetDescriptorV1Schema>;
export type RoomArtifactV2 = z.infer<typeof roomArtifactV2Schema>;
export type RoomEntityV2 = z.infer<typeof roomEntityV2Schema>;
export type BoardPointV1 = z.infer<typeof boardPointV1Schema>;
export type BoardSizeV1 = z.infer<typeof boardSizeV1Schema>;
export type BoardItemReferenceV1 = z.infer<typeof boardItemReferenceV1Schema>;
export type BoardItemV1 = z.infer<typeof boardItemV1Schema>;
export type BoardEdgeV1 = z.infer<typeof boardEdgeV1Schema>;
export type FogRevealRegionV1 = z.infer<typeof fogRevealRegionV1Schema>;
export type FogMaskV1 = z.infer<typeof fogMaskV1Schema>;
export type BoardV1 = z.infer<typeof boardV1Schema>;
export type NpcInteractionSessionV1 = z.infer<typeof npcInteractionSessionV1Schema>;
export type AudienceTargetV2 = z.infer<typeof audienceTargetV2Schema>;
export type RoomEventV2 = z.infer<typeof roomEventV2Schema>;
export type RoomEventTypeV2 = RoomEventV2["type"];
export type RoomEventViewV2 = z.infer<typeof roomEventViewV2Schema>;
export type RoomEventViewKindV2 = RoomEventViewV2["view"];
export type FullRoomEventViewV2 = z.infer<typeof fullRoomEventViewV2Schema>;
export type RedactedRoomEventViewV2 = z.infer<typeof redactedRoomEventViewV2Schema>;
export type RoomCommandV2 = z.infer<typeof roomCommandV2Schema>;

type SequencedV2Fields = "protocolVersion" | "roomId" | "eventId" | "sequence" | "occurredAt";
export type RoomEventDraftV2 = RoomEventV2 extends infer Event
  ? Event extends RoomEventV2
    ? Omit<Event, SequencedV2Fields> & { readonly roomId?: string }
    : never
  : never;
export type RoomEventProposalV2 = RoomEventV2 extends infer Event
  ? Event extends RoomEventV2
    ? Pick<Event, "type" | "audience" | "payload">
    : never
  : never;

export type AudienceMemberV2 = Readonly<Pick<SeatV2, "seatId" | "role">>;

/** Returns true when the seat is entitled to receive the audience payload. */
export function isAudienceMemberV2(
  candidateAudience: AudienceV2,
  member: AudienceMemberV2,
): boolean {
  const audience = audienceV2Schema.parse(candidateAudience);
  if (member.role === "host") return true;
  if (audience.kind === "room") return true;
  return audience.kind === "seats" && audience.seatIds.includes(member.seatId);
}

/** Alias that reads naturally at call sites handling seats. */
export const isSeatInAudienceV2 = isAudienceMemberV2;

/**
 * Whether every non-host recipient of `candidateSubset` is also a recipient
 * of `candidateContainer`. Hosts are implicit in both values.
 */
export function isAudienceSubsetV2(
  candidateSubset: AudienceV2,
  candidateContainer: AudienceV2,
): boolean {
  const subset = audienceV2Schema.parse(candidateSubset);
  const container = audienceV2Schema.parse(candidateContainer);
  if (subset.kind === "host") return true;
  if (container.kind === "room") return true;
  if (subset.kind === "room" || container.kind === "host") return false;
  const containerSeats = new Set(container.seatIds);
  return subset.seatIds.every((seatId) => containerSeats.has(seatId));
}

/** Event-level redaction cannot safely hide nested board members individually. */
export function isSameAudienceV2(left: AudienceV2, right: AudienceV2): boolean {
  return isAudienceSubsetV2(left, right) && isAudienceSubsetV2(right, left);
}

export function isAudienceExpansionV2(current: AudienceV2, next: AudienceV2): boolean {
  return isAudienceSubsetV2(current, next);
}

/** Validates and returns a monotonic audience expansion. */
export function expandAudienceV2(current: AudienceV2, next: AudienceV2): AudienceV2 {
  const parsedCurrent = audienceV2Schema.parse(current);
  const parsedNext = audienceV2Schema.parse(next);
  if (!isAudienceExpansionV2(parsedCurrent, parsedNext)) {
    throw new Error("audience updates may only expand visibility");
  }
  return parsedNext;
}

/** Projects one authoritative event into a payload-bearing or redacted view. */
export function projectRoomEventV2(
  candidateEvent: RoomEventV2,
  member: AudienceMemberV2,
  effectiveAudience?: AudienceV2,
): RoomEventViewV2 {
  const event = roomEventV2Schema.parse(candidateEvent);
  const audience = effectiveAudience === undefined
    ? event.audience
    : expandAudienceV2(event.audience, effectiveAudience);
  if (isAudienceMemberV2(audience, member)) {
    return fullRoomEventViewV2Schema.parse({ view: "full", event });
  }
  return redactedRoomEventViewV2Schema.parse({
    view: "redacted",
    protocolVersion: 2,
    roomId: event.roomId,
    eventId: event.eventId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
  });
}

export const toRoomEventViewV2 = projectRoomEventV2;
