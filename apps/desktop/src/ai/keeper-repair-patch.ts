import { z } from "zod";
import { keeperGuideSchema, keeperGuideNoteSchema, keeperPreparationSchema, scenePublicEntitySchema, type KeeperGuideV1, type ModulePackageV1 } from "@coc-room/protocol";
import { validateGuideEvidence } from "./keeper-guide-context";
import { hasCompleteScenePublications } from "../lib/scene-publications";

const actionSchema = keeperPreparationSchema.shape.scenes.element.shape.actions.element.extend({ checkId: z.string().nullish() })
  .transform(({ checkId, ...action }) => ({ ...action, ...(checkId ? { checkId } : {}) }));
export const keeperRepairPatchSchema = z.object({ edits: z.array(z.object({
  op: z.enum(["replace", "add", "remove"]), path: z.string().min(1).max(500),
  value: z.union([z.string(), keeperGuideNoteSchema, actionSchema, keeperPreparationSchema.shape.publicClues.unwrap().element, scenePublicEntitySchema, z.null()]),
}).strict()).min(1).max(60) }).strict();

export class KeeperPatchError extends Error {}
const index = "(?:0|[1-9]\\d*)";
const note = `(?:truth|hook|playerBriefing|(?:essentials|timeline|endings)/${index}|cast/${index}/notes/${index}|scenes/${index}/(?:purpose|(?:exits|pitfalls)/${index}|actions/${index}/response|publicEntities/${index}/when)|publicClues/${index}/when)`;
const collection = `(?:(?:essentials|timeline|endings)|cast/${index}/notes|scenes/${index}/(?:exits|pitfalls|actions|publicEntities)|publicClues)`;
const itemPath = new RegExp(`^/${collection}/${index}$`, "u");
const addPath = new RegExp(`^/${collection}/-$`, "u");
const replacePath = new RegExp(`^/(?:${note}(?:/(?:title|text))?|${collection}/${index}|scenes/${index}/(?:openingDraft|actions/${index}/intent|publicEntities/${index}/(?:name|text))|publicClues/${index}/text)$`, "u");

/** Apply only named leaves/items atomically. An LLM cannot re-emit or drop the rest of the book. */
export function applyKeeperRepairPatch(guide: KeeperGuideV1, raw: unknown, modulePackage: ModulePackageV1, sourceText?: string): KeeperGuideV1 {
  const patch = keeperRepairPatchSchema.parse(raw);
  const preparation = structuredClone(guide.preparation!);
  try {
    for (const edit of patch.edits) {
      const allowed = edit.op === "add" ? addPath : edit.op === "remove" ? itemPath : replacePath;
      if (!allowed.test(edit.path)) throw new Error(`补丁路径不属于可修订正文：${edit.path}`);
      const tokens = edit.path.slice(1).split("/");
      const key = tokens.pop()!;
      let parent: unknown = preparation;
      for (const token of tokens) {
        if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, token)) throw new Error(`补丁引用不存在的位置：${edit.path}`);
        parent = (parent as Record<string, unknown>)[token];
      }
      if (edit.op === "add") {
        if (!Array.isArray(parent)) throw new Error("只能向正文数组追加");
        parent.push(structuredClone(edit.value));
      } else {
        if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key)) throw new Error(`补丁引用不存在的位置：${edit.path}`);
        const before = (parent as Record<string, unknown>)[key];
        if (edit.op === "remove") {
          if (!Array.isArray(parent) || edit.value !== null) throw new Error("删除补丁无效");
          parent.splice(Number(key), 1);
        } else {
          // Whole public versions/actions may be replaced, but their references stay fixed.
          if (before && typeof before === "object" && !Array.isArray(before)) {
            for (const id of ["entityId", "clueId", "checkId", "kind"] as const) {
              if ((id !== "kind" || "entityId" in before) && id in before
                && (!edit.value || typeof edit.value !== "object" || (edit.value as Record<string, unknown>)[id] !== (before as Record<string, unknown>)[id])) throw new Error("补丁不能更换已有对象的引用");
            }
          }
          (parent as Record<string, unknown>)[key] = structuredClone(edit.value);
        }
      }
    }
    const result = validateGuideEvidence(keeperGuideSchema.parse({ ...guide, preparation, truth: preparation.truth.text, hook: preparation.hook.text }), modulePackage, sourceText);
    for (const before of guide.preparation!.scenes) {
      const after = result.preparation!.scenes.find((scene) => scene.sceneId === before.sceneId)!;
      if (hasCompleteScenePublications(modulePackage, before.sceneId, before.publicEntities)
        && !hasCompleteScenePublications(modulePackage, after.sceneId, after.publicEntities)) throw new Error("补丁不能删除必要的登场版本");
    }
    return result;
  } catch (cause) {
    throw new KeeperPatchError(cause instanceof Error ? cause.message : "局部修订无效，原稿已保留");
  }
}
