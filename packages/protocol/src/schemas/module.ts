import { z } from "zod";

import {
  entityIdSchema,
  extensionsSchema,
  isoDateTimeSchema,
  sourceReferenceSchema,
} from "./common.js";

export const moduleMetadataSchema = z
  .object({
    title: z.string().min(1).max(240),
    authors: z.array(z.string().min(1).max(160)).max(32),
    language: z.string().min(2).max(35),
    source: z.string().max(500).optional(),
    summary: z.string().max(8_000),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const moduleSourceDocumentSchema = z
  .object({
    id: entityIdSchema,
    name: z.string().min(1).max(240),
    mediaType: z.enum(["text/plain", "text/markdown"]),
    contentHash: z.string().min(8).max(128).optional(),
  })
  .strict();

const moduleEntityBase = z.object({
  id: entityIdSchema,
  name: z.string().min(1).max(240),
  description: z.string().max(20_000),
  sourceRefs: z.array(sourceReferenceSchema).max(100),
});

export const moduleChapterSchema = z
  .object({
    id: entityIdSchema,
    title: z.string().min(1).max(240),
    order: z.number().int().nonnegative(),
    sceneIds: z.array(entityIdSchema).max(500),
    notes: z.string().max(20_000),
  })
  .strict();

export const moduleSceneSchema = moduleEntityBase
  .extend({
    synopsis: z.string().max(20_000),
    locationIds: z.array(entityIdSchema).max(100),
    npcIds: z.array(entityIdSchema).max(200),
    clueIds: z.array(entityIdSchema).max(200),
    handoutIds: z.array(entityIdSchema).max(200),
    suggestedCheckIds: z.array(entityIdSchema).max(100),
    keeperNotes: z.string().max(20_000),
  })
  .strict();

export const moduleLocationSchema = moduleEntityBase
  .extend({
    aliases: z.array(z.string().min(1).max(160)).max(50),
  })
  .strict();

export const moduleNpcSchema = moduleEntityBase
  .extend({
    role: z.string().max(1_000),
    motivation: z.string().max(4_000),
    traits: z.array(z.string().min(1).max(500)).max(100),
    character: z
      .object({
        characteristics: z.record(z.number().int().min(0).max(100)),
        skills: z.record(z.number().int().min(0).max(100)),
        hitPoints: z.number().int().min(0).max(99).optional(),
        sanity: z.number().int().min(0).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const moduleClueSchema = moduleEntityBase
  .extend({
    revealText: z.string().max(20_000),
    isCore: z.boolean(),
  })
  .strict();

export const moduleHandoutSchema = moduleEntityBase
  .extend({
    title: z.string().min(1).max(240),
    content: z.string().max(50_000),
  })
  .strict();

export const moduleSuggestedCheckSchema = z
  .object({
    id: entityIdSchema,
    skill: z.string().min(1).max(160),
    difficulty: z.enum(["regular", "hard", "extreme"]),
    purpose: z.string().max(4_000),
    onSuccess: z.string().max(8_000),
    onFailure: z.string().max(8_000),
    sourceRefs: z.array(sourceReferenceSchema).max(100),
  })
  .strict();

export const moduleKeeperNoteSchema = z
  .object({
    id: entityIdSchema,
    title: z.string().min(1).max(240),
    content: z.string().max(50_000),
    relatedEntityIds: z.array(entityIdSchema).max(200),
    sourceRefs: z.array(sourceReferenceSchema).max(100),
  })
  .strict();

export const moduleEntityRelationSchema = z
  .object({
    id: entityIdSchema,
    fromEntityId: entityIdSchema,
    toEntityId: entityIdSchema,
    kind: z.string().min(1).max(120),
    description: z.string().max(4_000),
    sourceRefs: z.array(sourceReferenceSchema).max(100),
  })
  .strict();

function uniqueEntityIds(
  values: ReadonlyArray<{ id: string }>,
  path: string,
  context: z.RefinementCtx,
): Set<string> {
  const ids = new Set<string>();
  values.forEach((value, index) => {
    if (ids.has(value.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path, index, "id"],
        message: `duplicate entity id: ${value.id}`,
      });
    }
    ids.add(value.id);
  });
  return ids;
}

export const modulePackageSchema = z
  .object({
    schemaVersion: z.literal(1),
    moduleId: entityIdSchema,
    revision: z.number().int().positive(),
    metadata: moduleMetadataSchema,
    overview: z.string().max(50_000),
    sourceDocuments: z.array(moduleSourceDocumentSchema).max(100),
    chapters: z.array(moduleChapterSchema).max(500),
    scenes: z.array(moduleSceneSchema).max(2_000),
    locations: z.array(moduleLocationSchema).max(2_000),
    npcs: z.array(moduleNpcSchema).max(5_000),
    clues: z.array(moduleClueSchema).max(5_000),
    handouts: z.array(moduleHandoutSchema).max(5_000),
    suggestedChecks: z.array(moduleSuggestedCheckSchema).max(5_000),
    keeperNotes: z.array(moduleKeeperNoteSchema).max(5_000),
    relations: z.array(moduleEntityRelationSchema).max(20_000),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((modulePackage, context) => {
    const sourceIds = uniqueEntityIds(modulePackage.sourceDocuments, "sourceDocuments", context);
    const sceneIds = uniqueEntityIds(modulePackage.scenes, "scenes", context);
    const locationIds = uniqueEntityIds(modulePackage.locations, "locations", context);
    const npcIds = uniqueEntityIds(modulePackage.npcs, "npcs", context);
    const clueIds = uniqueEntityIds(modulePackage.clues, "clues", context);
    const handoutIds = uniqueEntityIds(modulePackage.handouts, "handouts", context);
    const checkIds = uniqueEntityIds(modulePackage.suggestedChecks, "suggestedChecks", context);
    const noteIds = uniqueEntityIds(modulePackage.keeperNotes, "keeperNotes", context);
    const chapterIds = uniqueEntityIds(modulePackage.chapters, "chapters", context);
    uniqueEntityIds(modulePackage.relations, "relations", context);

    const globalEntities = [
      ["chapters", modulePackage.chapters],
      ["scenes", modulePackage.scenes],
      ["locations", modulePackage.locations],
      ["npcs", modulePackage.npcs],
      ["clues", modulePackage.clues],
      ["handouts", modulePackage.handouts],
      ["suggestedChecks", modulePackage.suggestedChecks],
      ["keeperNotes", modulePackage.keeperNotes],
    ] as const;
    const entityKinds = new Map<string, string>();
    for (const [kind, entities] of globalEntities) {
      entities.forEach((entity, index) => {
        const existingKind = entityKinds.get(entity.id);
        if (existingKind !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [kind, index, "id"],
            message: `entity id ${entity.id} is already used by ${existingKind}`,
          });
        } else {
          entityKinds.set(entity.id, kind);
        }
      });
    }
    const allEntityIds = new Set(entityKinds.keys());

    const validateRefs = (
      refs: readonly string[],
      validIds: ReadonlySet<string>,
      path: Array<string | number>,
    ): void => {
      refs.forEach((ref, index) => {
        if (!validIds.has(ref)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, index],
            message: `unknown entity reference: ${ref}`,
          });
        }
      });
    };

    modulePackage.chapters.forEach((chapter, index) => {
      validateRefs(chapter.sceneIds, sceneIds, ["chapters", index, "sceneIds"]);
    });

    modulePackage.scenes.forEach((scene, index) => {
      validateRefs(scene.locationIds, locationIds, ["scenes", index, "locationIds"]);
      validateRefs(scene.npcIds, npcIds, ["scenes", index, "npcIds"]);
      validateRefs(scene.clueIds, clueIds, ["scenes", index, "clueIds"]);
      validateRefs(scene.handoutIds, handoutIds, ["scenes", index, "handoutIds"]);
      validateRefs(scene.suggestedCheckIds, checkIds, ["scenes", index, "suggestedCheckIds"]);
    });

    modulePackage.keeperNotes.forEach((note, index) => {
      validateRefs(note.relatedEntityIds, allEntityIds, ["keeperNotes", index, "relatedEntityIds"]);
    });

    modulePackage.relations.forEach((relation, index) => {
      validateRefs([relation.fromEntityId], allEntityIds, ["relations", index, "fromEntityId"]);
      validateRefs([relation.toEntityId], allEntityIds, ["relations", index, "toEntityId"]);
    });

    const entitiesWithSources = [
      ...modulePackage.scenes,
      ...modulePackage.locations,
      ...modulePackage.npcs,
      ...modulePackage.clues,
      ...modulePackage.handouts,
      ...modulePackage.suggestedChecks,
      ...modulePackage.keeperNotes,
      ...modulePackage.relations,
    ];
    entitiesWithSources.forEach((entity, entityIndex) => {
      entity.sourceRefs.forEach((reference, referenceIndex) => {
        if (!sourceIds.has(reference.sourceId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sourceRefs", entityIndex, referenceIndex, "sourceId"],
            message: `unknown source document: ${reference.sourceId}`,
          });
        }
      });
    });
  });

export type ModulePackageV1 = z.infer<typeof modulePackageSchema>;
export type ModuleSceneV1 = z.infer<typeof moduleSceneSchema>;
export type ModuleLocationV1 = z.infer<typeof moduleLocationSchema>;
export type ModuleNpcV1 = z.infer<typeof moduleNpcSchema>;
export type ModuleClueV1 = z.infer<typeof moduleClueSchema>;
export type ModuleHandoutV1 = z.infer<typeof moduleHandoutSchema>;
export type ModuleSuggestedCheckV1 = z.infer<typeof moduleSuggestedCheckSchema>;
