import { z } from "zod";

import { diceRollResultSchema } from "../dice.js";
import { coc7CharacterSchema } from "./character.js";
import { entityIdSchema, isoDateTimeSchema, peerIdSchema, roomIdSchema } from "./common.js";

export const participantSchema = z
  .object({
    peerId: peerIdSchema,
    displayName: z.string().min(1).max(80),
    role: z.enum(["host", "player"]),
  })
  .strict();

const eventIdSchema = z.string().uuid();
const commandIdSchema = z.string().uuid();

/** A deliberately minimal location snapshot that is safe to send to players. */
export const playerVisibleLocationSchema = z
  .object({
    id: entityIdSchema,
    name: z.string().min(1).max(240),
    description: z.string().max(20_000),
  })
  .strict();

/** A deliberately minimal NPC snapshot that cannot carry keeper-only fields. */
export const playerVisibleNpcSchema = z
  .object({
    id: entityIdSchema,
    name: z.string().min(1).max(240),
    description: z.string().max(20_000),
  })
  .strict();

const eventBase = z.object({
  protocolVersion: z.literal(1),
  roomId: roomIdSchema,
  eventId: eventIdSchema,
  sequence: z.number().int().positive(),
  sender: participantSchema,
  occurredAt: isoDateTimeSchema,
  causedByCommandId: commandIdSchema.optional(),
});

export const chatMessageEventSchema = eventBase
  .extend({
    type: z.literal("chat.message"),
    payload: z
      .object({
        message: z.string().min(1).max(20_000),
        format: z.enum(["plain", "markdown"]),
      })
      .strict(),
  })
  .strict();

export const systemNoticeEventSchema = eventBase
  .extend({
    type: z.literal("system.notice"),
    payload: z
      .object({
        message: z.string().min(1).max(20_000),
        level: z.enum(["info", "warning", "error"]),
      })
      .strict(),
  })
  .strict();

export const diceResultEventSchema = eventBase
  .extend({
    type: z.literal("dice.result"),
    payload: z
      .object({
        result: diceRollResultSchema,
        reason: z.string().max(500),
      })
      .strict(),
  })
  .strict();

export const characterUpdatedEventSchema = eventBase
  .extend({
    type: z.literal("character.updated"),
    payload: z
      .object({
        character: coc7CharacterSchema,
      })
      .strict(),
  })
  .strict();

export const moduleSwitchedEventSchema = eventBase
  .extend({
    type: z.literal("module.switched"),
    payload: z
      .object({
        moduleId: entityIdSchema,
        revision: z.number().int().positive(),
        title: z.string().min(1).max(240),
      })
      .strict(),
  })
  .strict();

export const contentRevealedEventSchema = eventBase
  .extend({
    type: z.literal("content.revealed"),
    payload: z
      .object({
        moduleId: entityIdSchema,
        revision: z.number().int().positive(),
        contentId: entityIdSchema,
        contentType: z.enum(["clue", "handout", "text"]),
        title: z.string().min(1).max(240),
        body: z.string().max(50_000),
        locationId: entityIdSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const locationPublishedEventSchema = eventBase
  .extend({
    type: z.literal("location.published"),
    payload: z
      .object({
        moduleId: entityIdSchema,
        revision: z.number().int().positive(),
        location: playerVisibleLocationSchema,
      })
      .strict(),
  })
  .strict();

export const locationEnteredEventSchema = eventBase
  .extend({
    type: z.literal("location.entered"),
    payload: z
      .object({
        moduleId: entityIdSchema,
        revision: z.number().int().positive(),
        locationId: entityIdSchema,
        locationName: z.string().min(1).max(240),
        characterId: entityIdSchema,
        characterName: z.string().min(1).max(240),
      })
      .strict(),
  })
  .strict();

export const npcPublishedEventSchema = eventBase
  .extend({
    type: z.literal("npc.published"),
    payload: z
      .object({
        moduleId: entityIdSchema,
        revision: z.number().int().positive(),
        locationId: entityIdSchema,
        locationName: z.string().min(1).max(240),
        npc: playerVisibleNpcSchema,
      })
      .strict(),
  })
  .strict();

export const roomEventSchema = z.discriminatedUnion("type", [
  chatMessageEventSchema,
  systemNoticeEventSchema,
  diceResultEventSchema,
  characterUpdatedEventSchema,
  moduleSwitchedEventSchema,
  contentRevealedEventSchema,
  locationPublishedEventSchema,
  locationEnteredEventSchema,
  npcPublishedEventSchema,
]);

const commandBase = z.object({
  protocolVersion: z.literal(1),
  roomId: roomIdSchema,
  commandId: commandIdSchema,
  sender: participantSchema,
  sentAt: isoDateTimeSchema,
});

export const sendChatCommandSchema = commandBase
  .extend({
    type: z.literal("chat.send"),
    payload: z
      .object({
        message: z.string().min(1).max(20_000),
        format: z.enum(["plain", "markdown"]),
      })
      .strict(),
  })
  .strict();

export const rollDiceCommandSchema = commandBase
  .extend({
    type: z.literal("dice.roll"),
    payload: z
      .object({
        expression: z.string().min(1).max(64),
        reason: z.string().max(500),
        bonusDice: z.number().int().min(0).max(2),
        penaltyDice: z.number().int().min(0).max(2),
        target: z.number().int().min(1).max(100).optional(),
        requiredDifficulty: z.enum(["regular", "hard", "extreme"]).optional(),
      })
      .strict()
      .superRefine((payload, context) => {
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
      }),
  })
  .strict();

export const updateCharacterCommandSchema = commandBase
  .extend({
    type: z.literal("character.update"),
    payload: z
      .object({
        character: coc7CharacterSchema,
      })
      .strict(),
  })
  .strict();

export const switchModuleCommandSchema = commandBase
  .extend({
    type: z.literal("module.switch"),
    payload: z
      .object({
        moduleId: entityIdSchema,
        revision: z.number().int().positive(),
        title: z.string().min(1).max(240),
      })
      .strict(),
  })
  .strict();

export const revealContentCommandSchema = commandBase
  .extend({
    type: z.literal("content.reveal"),
    payload: z
      .object({
        moduleId: entityIdSchema,
        revision: z.number().int().positive(),
        contentId: entityIdSchema,
        contentType: z.enum(["clue", "handout", "text"]),
        title: z.string().min(1).max(240),
        body: z.string().max(50_000),
        locationId: entityIdSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const publishLocationCommandSchema = commandBase
  .extend({
    type: z.literal("location.publish"),
    payload: z
      .object({
        moduleId: entityIdSchema,
        revision: z.number().int().positive(),
        location: playerVisibleLocationSchema,
      })
      .strict(),
  })
  .strict();

export const enterLocationCommandSchema = commandBase
  .extend({
    type: z.literal("location.enter"),
    payload: z
      .object({
        moduleId: entityIdSchema,
        revision: z.number().int().positive(),
        locationId: entityIdSchema,
        locationName: z.string().min(1).max(240),
        characterId: entityIdSchema,
        characterName: z.string().min(1).max(240),
      })
      .strict(),
  })
  .strict();

export const publishNpcCommandSchema = commandBase
  .extend({
    type: z.literal("npc.publish"),
    payload: z
      .object({
        moduleId: entityIdSchema,
        revision: z.number().int().positive(),
        locationId: entityIdSchema,
        locationName: z.string().min(1).max(240),
        npc: playerVisibleNpcSchema,
      })
      .strict(),
  })
  .strict();

export const roomCommandSchema = z.discriminatedUnion("type", [
  sendChatCommandSchema,
  rollDiceCommandSchema,
  updateCharacterCommandSchema,
  switchModuleCommandSchema,
  revealContentCommandSchema,
  publishLocationCommandSchema,
  enterLocationCommandSchema,
  publishNpcCommandSchema,
]);

export type ParticipantV1 = z.infer<typeof participantSchema>;
export type RoomEventV1 = z.infer<typeof roomEventSchema>;
export type RoomCommandV1 = z.infer<typeof roomCommandSchema>;
export type RoomEventTypeV1 = RoomEventV1["type"];
export type RoomCommandTypeV1 = RoomCommandV1["type"];
export type PlayerVisibleLocationV1 = z.infer<typeof playerVisibleLocationSchema>;
export type PlayerVisibleNpcV1 = z.infer<typeof playerVisibleNpcSchema>;
export type LocationPublishedPayloadV1 = z.infer<typeof locationPublishedEventSchema>["payload"];
export type LocationEnteredPayloadV1 = z.infer<typeof locationEnteredEventSchema>["payload"];
export type NpcPublishedPayloadV1 = z.infer<typeof npcPublishedEventSchema>["payload"];
export type ContentRevealedPayloadV1 = z.infer<typeof contentRevealedEventSchema>["payload"];

type SequencedFields = "protocolVersion" | "roomId" | "eventId" | "sequence" | "occurredAt";
export type RoomEventDraftV1 = RoomEventV1 extends infer Event
  ? Event extends RoomEventV1
    ? Omit<Event, SequencedFields> & { readonly roomId?: string }
    : never
  : never;
