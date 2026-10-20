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
    summary: z.string().max(50_000),
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
  description: z.string().max(100_000),
  sourceRefs: z.array(sourceReferenceSchema).max(100),
});

export const moduleChapterSchema = z
  .object({
    id: entityIdSchema,
    title: z.string().min(1).max(240),
    order: z.number().int().nonnegative(),
    sceneIds: z.array(entityIdSchema).max(500),
    notes: z.string().max(100_000),
  })
  .strict();

export const moduleSceneSchema = moduleEntityBase
  .extend({
    // A scene summary is keeper-only. Never use it as fallback public copy.
    playerDescription: z.string().max(8_000).optional(),
    synopsis: z.string().max(100_000),
    locationIds: z.array(entityIdSchema).max(100),
    npcIds: z.array(entityIdSchema).max(200),
    clueIds: z.array(entityIdSchema).max(200),
    handoutIds: z.array(entityIdSchema).max(200),
    suggestedCheckIds: z.array(entityIdSchema).max(100),
    keeperNotes: z.string().max(100_000),
  })
  .strict();

export const moduleLocationSchema = moduleEntityBase
  .extend({
    playerDescription: z.string().max(100_000).optional(),
    aliases: z.array(z.string().min(1).max(160)).max(50),
  })
  .strict();

export const moduleNpcSchema = moduleEntityBase
  .extend({
    playerDescription: z.string().max(100_000).optional(),
    role: z.string().max(1_000),
    motivation: z.string().max(20_000),
    traits: z.array(z.string().min(1).max(500)).max(100),
    character: z
      .object({
        characteristics: z.record(z.number().int().min(0).max(999)),
        skills: z.record(z.number().int().min(0).max(999)),
        hitPoints: z.number().int().min(0).max(999).optional(),
        sanity: z.number().int().min(0).max(999).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const moduleClueSchema = moduleEntityBase
  .extend({
    revealText: z.string().max(100_000),
    isCore: z.boolean(),
  })
  .strict();

export const moduleHandoutSchema = moduleEntityBase
  .extend({
    title: z.string().min(1).max(240),
    content: z.string().max(200_000),
  })
  .strict();

export const moduleSuggestedCheckSchema = z
  .object({
    id: entityIdSchema,
    skill: z.string().min(1).max(160),
    difficulty: z.enum(["regular", "hard", "extreme"]),
    purpose: z.string().max(20_000),
    onSuccess: z.string().max(50_000),
    onFailure: z.string().max(50_000),
    sourceRefs: z.array(sourceReferenceSchema).max(100),
  })
  .strict();

export const moduleKeeperNoteSchema = z
  .object({
    id: entityIdSchema,
    title: z.string().min(1).max(240),
    content: z.string().max(200_000),
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
    description: z.string().max(20_000),
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

/**
 * The keeper's runbook: how to actually RUN the parsed module at a table.
 * Mirrors how published scenarios are organized — hidden truth, hook, a clue
 * trail with backup paths, a timeline of what happens if investigators stall,
 * ending conditions, and pacing advice. Generated after parsing (增量, no
 * re-parse) and keeper-only.
 */
export const keeperGuideNoteSchema = z.object({
  title: z.string().min(1).max(240),
  text: z.string().min(1).max(8_000),
  kind: z.enum(["source", "advice", "uncertain"]),
  sources: z.array(z.object({
    sourceId: entityIdSchema,
    excerpt: z.string().min(1).max(2_000),
  }).strict()).max(12),
}).strict();

/** Per-scene disclosure, never a global biography or a location's entire history. */
export const scenePublicEntitySchema = z.object({
  kind: z.enum(["npc", "location"]),
  entityId: entityIdSchema,
  name: z.string().max(240).optional(),
  text: z.string().max(8_000),
  when: keeperGuideNoteSchema,
}).strict();
export type ScenePublicEntityV1 = z.infer<typeof scenePublicEntitySchema>;

export const keeperPreparationSchema = z.object({
  truth: keeperGuideNoteSchema,
  hook: keeperGuideNoteSchema,
  essentials: z.array(keeperGuideNoteSchema).min(1).max(12),
  playerBriefing: keeperGuideNoteSchema,
  publicClues: z.array(z.object({
    clueId: entityIdSchema,
    text: z.string().min(1).max(8_000),
    when: keeperGuideNoteSchema,
  }).strict()).max(200).optional(),
  timeline: z.array(keeperGuideNoteSchema).max(50),
  endings: z.array(keeperGuideNoteSchema).max(20),
  cast: z.array(z.object({
    npcId: entityIdSchema,
    notes: z.array(keeperGuideNoteSchema).min(1).max(8),
  }).strict()).max(100),
  scenes: z.array(z.object({
    sceneId: entityIdSchema,
    purpose: keeperGuideNoteSchema,
    openingDraft: z.string().max(8_000),
    publicEntities: z.array(scenePublicEntitySchema).max(300).optional(),
    actions: z.array(z.object({
      intent: z.string().min(1).max(500),
      response: keeperGuideNoteSchema,
      checkId: entityIdSchema.optional(),
    }).strict()).max(12),
    exits: z.array(keeperGuideNoteSchema).max(12),
    pitfalls: z.array(keeperGuideNoteSchema).max(8),
  }).strict()).max(100),
}).strict();

export type KeeperGuideNoteV1 = z.infer<typeof keeperGuideNoteSchema>;
export type KeeperPreparationV1 = z.infer<typeof keeperPreparationSchema>;

export const keeperGuideStepSchema = z
  .object({
    sceneId: entityIdSchema.optional(),
    title: z.string().min(1).max(240),
    goal: z.string().max(4_000),
    leadIn: z.string().max(4_000),
    keyClues: z.array(z.object({
      clueId: entityIdSchema.optional(),
      summary: z.string().min(1).max(2_000),
      pointsTo: z.string().max(2_000),
    }).strict()).max(20),
    ifStuck: z.string().max(4_000),
  })
  .strict();

export const keeperEvidenceSchema = z.object({
  facts: z.array(z.object({
    id: entityIdSchema,
    category: z.enum(["truth", "route", "disclosure", "check", "timing", "contradiction"]),
    sceneIds: z.array(entityIdSchema).max(2_000),
    note: keeperGuideNoteSchema,
  }).strict()).min(1).max(300),
}).strict();

export const keeperPlanSchema = z.object({
  scenes: z.array(z.object({
    sceneId: entityIdSchema,
    factIds: z.array(entityIdSchema).max(300),
    purpose: z.string().min(1).max(2_000),
    alternativeRoutes: keeperGuideNoteSchema,
  }).strict()).max(2_000),
}).strict();

export const keeperReviewSchema = z.object({
  checks: z.array(z.object({
    factId: entityIdSchema,
    verdict: z.enum(["covered", "issue", "not-applicable"]),
    reason: z.string().min(1).max(2_000),
  }).strict()).max(300),
  findings: z.array(z.object({
    severity: z.enum(["error", "uncertain"]),
    sceneIds: z.array(entityIdSchema).max(2_000),
    field: z.string().min(1).max(500),
    note: keeperGuideNoteSchema,
  }).strict()).max(100),
}).strict();

export const keeperWorkflowSchema = z.object({
  version: z.literal(1),
  inputHash: z.string().length(64),
  contentHash: z.string().length(64),
  provider: z.enum(["codex", "deepseek"]),
  model: z.string().max(100),
  stage: z.enum(["extract", "plan", "draft", "review", "repair", "audit", "complete", "needs-review"]),
  restartFromBeginning: z.boolean().optional(),
  evidence: keeperEvidenceSchema.optional(),
  plan: keeperPlanSchema.optional(),
  pending: z.object({
    key: z.string().max(20_000),
    preparation: keeperPreparationSchema,
    repairs: z.number().int().min(0).max(1),
    review: keeperReviewSchema.optional(),
  }).strict().optional(),
  reviews: z.array(z.object({
    key: z.string().max(20_000),
    review: keeperReviewSchema,
  }).strict()).max(2_000),
  audit: keeperReviewSchema.optional(),
  finalRepair: z.object({
    remaining: z.array(z.object({
      key: z.string().max(20_000),
      sceneIds: z.array(entityIdSchema).max(2_000),
      castIds: z.array(entityIdSchema).max(5_000),
      scope: z.enum(["opening", "scene-batch", "scene-publications"]),
    }).strict()).max(2_000),
  }).strict().optional(),
}).strict();

export type KeeperEvidence = z.infer<typeof keeperEvidenceSchema>;
export type KeeperPlan = z.infer<typeof keeperPlanSchema>;
export type KeeperReview = z.infer<typeof keeperReviewSchema>;
export type KeeperWorkflow = z.infer<typeof keeperWorkflowSchema>;

export const keeperGuideSchema = z
  .object({
    schemaVersion: z.literal(1),
    truth: z.string().max(20_000),
    hook: z.string().max(10_000),
    clueTrail: z.array(keeperGuideStepSchema).max(100),
    timeline: z.array(z.object({
      when: z.string().min(1).max(240),
      event: z.string().min(1).max(4_000),
    }).strict()).max(50),
    endings: z.array(z.object({
      title: z.string().min(1).max(240),
      condition: z.string().max(4_000),
      outcome: z.string().max(4_000),
    }).strict()).max(20),
    pacing: z.string().max(10_000),
    preparation: keeperPreparationSchema.optional(),
    workflow: keeperWorkflowSchema.optional(),
  })
  .strict();

export type KeeperGuideV1 = z.infer<typeof keeperGuideSchema>;
export type KeeperGuideStepV1 = z.infer<typeof keeperGuideStepSchema>;

export const modulePackageSchema = z
  .object({
    schemaVersion: z.literal(1),
    moduleId: entityIdSchema,
    revision: z.number().int().positive(),
    metadata: moduleMetadataSchema,
    overview: z.string().max(200_000),
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
    keeperGuide: keeperGuideSchema.optional(),
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

    const preparation = modulePackage.keeperGuide?.preparation;
    if (preparation) {
      validateRefs(preparation.scenes.map((scene) => scene.sceneId), sceneIds, ["keeperGuide", "preparation", "scenes"]);
      validateRefs(preparation.cast.map((npc) => npc.npcId), npcIds, ["keeperGuide", "preparation", "cast"]);
      validateRefs((preparation.publicClues ?? []).map((clue) => clue.clueId), clueIds, ["keeperGuide", "preparation", "publicClues"]);
      preparation.scenes.forEach((scene, index) => validateRefs(scene.actions.flatMap((action) => action.checkId ? [action.checkId] : []), checkIds, ["keeperGuide", "preparation", "scenes", index, "actions"]));
      preparation.scenes.forEach((scene, index) => (scene.publicEntities ?? []).forEach((entry, entryIndex) => validateRefs([entry.entityId], entry.kind === "npc" ? npcIds : locationIds, ["keeperGuide", "preparation", "scenes", index, "publicEntities", entryIndex])));
    }

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
