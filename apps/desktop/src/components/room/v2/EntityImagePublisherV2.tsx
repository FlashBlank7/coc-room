import type { AssetDescriptorV1, RoomEntityV2 } from "@coc-room/protocol";

import type { ImportedAssetV1 } from "../../../lib/asset-store";
import { BoardBackgroundPublisherV2 } from "./BoardBackgroundPublisherV2";

export interface EntityImagePublisherV2Props {
  readonly entity: Pick<RoomEntityV2, "name">;
  readonly hasPublishedImage: boolean;
  readonly disabled?: boolean;
  readonly onPublish: (asset: AssetDescriptorV1) => Promise<void>;
  readonly onError?: (message?: string) => void;
  readonly availableAssets?: readonly {
    readonly asset: AssetDescriptorV1;
    readonly label: string;
  }[];
  /** Test seams shared with the board background review flow. */
  readonly selectAsset?: () => Promise<ImportedAssetV1 | undefined>;
  readonly resolvePreview?: (asset: AssetDescriptorV1) => Promise<string>;
}

/** Entity-specific copy over the board background's managed local review flow. */
export function EntityImagePublisherV2({
  entity,
  hasPublishedImage,
  disabled,
  onPublish,
  onError,
  availableAssets,
  selectAsset,
  resolvePreview,
}: EntityImagePublisherV2Props) {
  return <BoardBackgroundPublisherV2
    boardName={entity.name}
    hasPublishedBackground={hasPublishedImage}
    disabled={disabled}
    onPublish={onPublish}
    onError={onError}
    availableAssets={availableAssets}
    selectAsset={selectAsset}
    resolvePreview={resolvePreview}
    publicationKind="entity-image"
  />;
}
