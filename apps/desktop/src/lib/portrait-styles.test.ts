import { describe, expect, it } from "vitest";
import {
  DEFAULT_PORTRAIT_STYLE_ID,
  PORTRAIT_STYLES,
  portraitStylePreviewSrc,
  resolvePortraitStyle,
} from "./portrait-styles";

describe("portrait styles", () => {
  it("ships a researched concept set and prompt for every style", () => {
    expect(PORTRAIT_STYLES.length).toBeGreaterThanOrEqual(6);
    for (const style of PORTRAIT_STYLES) {
      expect(style.id).toMatch(/^[a-z][a-z-]+$/);
      expect(style.label.length).toBeGreaterThan(0);
      expect(style.concepts.length).toBeGreaterThanOrEqual(5);
      // The prompt must be built from the concept set, not drift away from it:
      // spot-check that at least half the concepts leave a trace in the prompt.
      const traced = style.concepts.filter((concept) =>
        style.stylePrompt.includes(concept.replace(/（.*）|\s.*$/u, "").slice(0, 4)));
      expect(traced.length).toBeGreaterThanOrEqual(Math.floor(style.concepts.length / 2));
      expect(style.stylePrompt.length).toBeLessThanOrEqual(2_000);
    }
    const ids = new Set(PORTRAIT_STYLES.map(({ id }) => id));
    expect(ids.size).toBe(PORTRAIT_STYLES.length);
  });

  it("resolves unknown ids to the default style", () => {
    expect(resolvePortraitStyle(undefined).id).toBe(DEFAULT_PORTRAIT_STYLE_ID);
    expect(resolvePortraitStyle("no-such-style").id).toBe(DEFAULT_PORTRAIT_STYLE_ID);
    expect(resolvePortraitStyle("anime").id).toBe("anime");
  });

  it("points previews at the bundled public assets", () => {
    expect(portraitStylePreviewSrc("anime")).toBe("/portrait-styles/anime.webp");
  });
});
