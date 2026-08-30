import type { ModulePackageV1 } from "@coc-room/protocol";

export interface PreparationReviewItem {
  readonly label: string;
  readonly ready: boolean;
  readonly message: string;
}

export function buildPreparationReview(modulePackage: ModulePackageV1): PreparationReviewItem[] {
  const missingLocationIntroductions = modulePackage.locations.filter((location) => !location.playerDescription?.trim()).length;
  const missingNpcIntroductions = modulePackage.npcs.filter((npc) => !npc.playerDescription?.trim()).length;
  const missingClueHandouts = modulePackage.clues.filter((clue) => !clue.revealText.trim()).length
    + modulePackage.handouts.filter((handout) => !handout.content.trim()).length;
  const hasOpening = modulePackage.scenes.length > 0;
  const hasPeopleOrPlaces = modulePackage.locations.length > 0 || modulePackage.npcs.length > 0;
  const hasInvestigativeMaterial = modulePackage.clues.length > 0 || modulePackage.handouts.length > 0;

  return [
    {
      label: "开场从哪里开始",
      ready: hasOpening,
      message: hasOpening
        ? `已经整理出 ${modulePackage.scenes.length} 个场景。请确认第一个场景适合作为开场。`
        : "还没有场景。请补一个开场，写清调查员在哪里、看见什么、为什么会开始调查。",
    },
    {
      label: "会遇见谁、去往哪里",
      ready: hasPeopleOrPlaces && missingLocationIntroductions + missingNpcIntroductions === 0,
      message: !hasPeopleOrPlaces
        ? "还没有地点或人物。如果原文中存在，请在“检查并修正”里补上。"
        : missingLocationIntroductions + missingNpcIntroductions === 0
        ? `${modulePackage.locations.length} 个地点、${modulePackage.npcs.length} 个人物都准备了玩家可见介绍。`
        : `有 ${missingLocationIntroductions + missingNpcIntroductions} 项还没有玩家可见介绍；跑团中无法一键公开，但仍可保存后手动主持。`,
    },
    {
      label: "调查能发现什么",
      ready: hasInvestigativeMaterial && missingClueHandouts === 0,
      message: !hasInvestigativeMaterial
        ? "还没有线索或手记。请确认调查不会因为缺少关键信息而停住。"
        : missingClueHandouts === 0
        ? `${modulePackage.clues.length} 条线索、${modulePackage.handouts.length} 份手记都已有可向玩家展示的正文。`
        : `有 ${missingClueHandouts} 条线索或手记尚无玩家版正文；请判断它们是否需要在游戏中公开。`,
    },
  ];
}
