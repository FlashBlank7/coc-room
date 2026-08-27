// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ModulePackageV1 } from "@coc-room/protocol";
import { useAppStore } from "../store/app-store";
import { ModulesView } from "./ModulesView";

afterEach(() => {
  cleanup();
  useAppStore.setState({ modules: [] });
});

describe("ModulesView browser import", () => {
  it("imports a cocmod JSON file into the preview repository", async () => {
    const modulePackage = createModulePackage();
    const { container } = render(<ModulesView />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("browser module input was not rendered");

    const content = JSON.stringify(modulePackage);
    const file = new File([content], "preview.cocmod.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => content });
    fireEvent.change(input, { target: { files: [file] } });

    expect((await screen.findAllByText(modulePackage.metadata.title)).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("tab", { name: "资料浏览" }).getAttribute("aria-selected")).toBe("true");
    expect(useAppStore.getState().modules).toHaveLength(1);
    expect(useAppStore.getState().modules[0]?.moduleId).toBe(modulePackage.moduleId);
  });
});

function createModulePackage(): ModulePackageV1 {
  const timestamp = "2026-08-27T00:00:00.000Z";
  return {
    schemaVersion: 1,
    moduleId: "module_preview_import_01",
    revision: 1,
    metadata: {
      title: "导入测试模组",
      authors: [],
      language: "zh-CN",
      summary: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    overview: "",
    sourceDocuments: [],
    chapters: [],
    scenes: [],
    locations: [],
    npcs: [],
    clues: [],
    handouts: [],
    suggestedChecks: [],
    keeperNotes: [],
    relations: [],
    extensions: {},
  };
}
