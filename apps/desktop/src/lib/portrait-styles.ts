import styleData from "./portrait-styles.json";

/**
 * Selectable art styles for character portrait generation. The data lives in
 * portrait-styles.json so scripts/generate-portrait-style-previews.mjs renders
 * the bundled previews (public/portrait-styles/<id>.webp) from the exact same
 * concept sets; every preview depicts the same 1920s investigator so only the
 * style differs. Each style's `concepts` (概念集) distills web research on the
 * real technique and composes the `stylePrompt` sent as the image job's style.
 */
export interface PortraitStyle {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly concepts: readonly string[];
  readonly stylePrompt: string;
}

export const PORTRAIT_STYLES: readonly PortraitStyle[] = styleData;

export const DEFAULT_PORTRAIT_STYLE_ID = PORTRAIT_STYLES[0]!.id;

export function portraitStylePreviewSrc(id: string): string {
  return `/portrait-styles/${id}.webp`;
}

export function resolvePortraitStyle(id: string | undefined): PortraitStyle {
  return PORTRAIT_STYLES.find((style) => style.id === id) ?? PORTRAIT_STYLES[0]!;
}
