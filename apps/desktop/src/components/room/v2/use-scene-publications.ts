import { useEffect, useRef, useState } from "react";
import type { ModulePackageV1 } from "@coc-room/protocol";
import { generateKeeperGuide } from "../../../ai/keeper-guide";
import { getRepository } from "../../../data/repository";
import { useAppStore } from "../../../store/app-store";
import { requireCompleteScenePublications, scenePublicationGuideKey } from "../../../lib/scene-publications";

/** Add missing scene copy in place, without rewriting the imported module or any public history. */
export function useScenePublications(modulePackage: ModulePackageV1, setText: (key: string, text: string) => void) {
  const [runningSceneId, setRunningSceneId] = useState<string>();
  const [error, setError] = useState("");
  const abort = useRef<AbortController>();
  useEffect(() => () => { abort.current?.abort(); }, [modulePackage.moduleId, modulePackage.revision]);
  const generate = async (sceneId: string) => {
    if (abort.current) return;
    const scene = modulePackage.scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    const controller = new AbortController(); abort.current = controller;
    setRunningSceneId(sceneId); setError("");
    try {
      const settings = useAppStore.getState();
      const stored = await (await getRepository()).getModule(modulePackage.moduleId, modulePackage.revision);
      const guide = await generateKeeperGuide({
        modulePackage: { ...modulePackage, scenes: [scene] }, sourceText: stored?.sourceText,
        preparationScope: "scene-publications", preparationCastIds: [], signal: controller.signal,
        provider: settings.parserProvider, model: settings.parserProvider === "codex" ? settings.codexModel : settings.deepseekModel,
      });
      if (controller.signal.aborted) return;
      const entries = requireCompleteScenePublications(modulePackage, sceneId, guide.preparation?.scenes.find((item) => item.sceneId === sceneId)?.publicEntities);
      setText(scenePublicationGuideKey(sceneId), JSON.stringify(entries));
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (abort.current === controller) { abort.current = undefined; setRunningSceneId(undefined); }
    }
  };
  return { runningSceneId, error, generate, stop: () => abort.current?.abort() };
}
