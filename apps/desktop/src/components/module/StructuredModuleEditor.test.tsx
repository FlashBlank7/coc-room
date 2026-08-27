// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { modulePackageSchema, type ModulePackageV1 } from "@coc-room/protocol";
import { StructuredModuleEditor } from "./StructuredModuleEditor";

describe("StructuredModuleEditor", () => {
  afterEach(cleanup);
  it("edits common fields, adds/removes entities, and preserves untouched data", () => {
    let current = createPackage();
    render(<Harness initial={current} onChange={(next) => { current = next; }} />);

    fireEvent.change(screen.getByLabelText("模组简介"), { target: { value: "更新后的简介" } });
    expect(current.metadata.summary).toBe("更新后的简介");
    expect(current.extensions).toEqual({ "org.example.advanced": { keep: true } });
    expect(current.locations[0]?.sourceRefs).toEqual([{ sourceId: "source-1", start: 1, end: 5 }]);

    fireEvent.click(screen.getByRole("button", { name: "编辑地点（1）" }));
    fireEvent.click(screen.getByRole("button", { name: "添加地点" }));
    expect(current.locations).toHaveLength(2);
    expect(current.locations[0]?.id).toBe("location-1");
    expect(modulePackageSchema.safeParse(current).success).toBe(true);

    fireEvent.click(screen.getByLabelText("删除地点 location-1"));
    expect(current.locations.map((item) => item.id)).toEqual(["location-new"]);
    expect(current.scenes[0]?.locationIds).toEqual([]);
    expect(current.relations).toEqual([]);
    expect(modulePackageSchema.safeParse(current).success).toBe(true);
  });

  it("adds a chapter without introducing fields outside the schema", () => {
    let current = createPackage();
    render(<Harness initial={current} onChange={(next) => { current = next; }} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑章节（0）" }));
    fireEvent.click(screen.getByRole("button", { name: "添加章节 / 手动分组" }));
    expect(current.chapters[0]).toEqual({ id: "chapter-new", title: "新章节", order: 0, sceneIds: [], notes: "" });
    fireEvent.click(screen.getByLabelText("章节 chapter-new 包含场景 scene-1"));
    expect(current.chapters[0]?.sceneIds).toEqual(["scene-1"]);
    expect(modulePackageSchema.safeParse(current).success).toBe(true);
  });

  it("keeps transient language and chapter-order input schema-valid", () => {
    let current = createPackage();
    render(<Harness initial={current} onChange={(next) => { current = next; }} />);

    const language = screen.getByLabelText("模组语言");
    fireEvent.change(language, { target: { value: "z" } });
    expect(language.getAttribute("aria-invalid")).toBe("true");
    expect(current.metadata.language).toBe("zh-CN");
    expect(modulePackageSchema.safeParse(current).success).toBe(true);
    fireEvent.blur(language);
    expect((language as HTMLInputElement).value).toBe("zh-CN");

    fireEvent.click(screen.getByRole("button", { name: "编辑章节（0）" }));
    fireEvent.click(screen.getByRole("button", { name: "添加章节 / 手动分组" }));
    fireEvent.change(screen.getByLabelText("章节 chapter-new 顺序"), { target: { value: "1.5" } });
    expect(current.chapters[0]?.order).toBe(1);
    expect(modulePackageSchema.safeParse(current).success).toBe(true);
  });
});

function Harness({ initial, onChange }: { initial: ModulePackageV1; onChange: (next: ModulePackageV1) => void }) {
  const [value, setValue] = useState(initial);
  return <StructuredModuleEditor modulePackage={value} onChange={(next) => { setValue(next); onChange(next); }} />;
}

function createPackage(): ModulePackageV1 {
  return {
    schemaVersion: 1,
    moduleId: "structured-editor-test",
    revision: 1,
    metadata: {
      title: "编辑测试",
      authors: ["作者"],
      language: "zh-CN",
      summary: "原始简介",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    },
    overview: "",
    sourceDocuments: [{ id: "source-1", name: "source.md", mediaType: "text/markdown" }],
    chapters: [],
    scenes: [{ id: "scene-1", name: "场景", description: "", sourceRefs: [], synopsis: "", locationIds: ["location-1"], npcIds: [], clueIds: [], handoutIds: [], suggestedCheckIds: [], keeperNotes: "" }],
    locations: [{ id: "location-1", name: "地点", description: "", aliases: [], sourceRefs: [{ sourceId: "source-1", start: 1, end: 5 }] }],
    npcs: [],
    clues: [],
    handouts: [],
    suggestedChecks: [],
    keeperNotes: [],
    relations: [{ id: "relation-1", fromEntityId: "scene-1", toEntityId: "location-1", kind: "at", description: "", sourceRefs: [] }],
    extensions: { "org.example.advanced": { keep: true } },
  };
}
