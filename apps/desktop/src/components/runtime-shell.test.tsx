// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary, RuntimeModeNotice } from "./runtime-shell";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.restoreAllMocks();
});

describe("web development shell", () => {
  it("labels browser mode, IndexedDB persistence, and the hot-reload local bridge", () => {
    render(<RuntimeModeNotice />);

    expect(screen.getByText("网页开发模式")).toBeInTheDocument();
    expect(screen.getByText(/IndexedDB/)).toBeInTheDocument();
    expect(screen.getByText(/Codex、DeepSeek、DOCX 与 PDF 可经同源本地安全桥运行/)).toBeInTheDocument();
  });

  it("does not show the browser notice inside Tauri", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    render(<RuntimeModeNotice />);

    expect(screen.queryByText("网页开发模式")).not.toBeInTheDocument();
  });

  it("makes the two-window development role visible without changing the product role", () => {
    window.history.replaceState({}, "", "/?duoRole=player");
    render(<RuntimeModeNotice />);

    expect(screen.getByText("玩家联调页")).toBeInTheDocument();
    expect(screen.getByText(/这个窗口使用独立的网页数据/)).toBeInTheDocument();
    expect(screen.getByText(/本页不连接这台电脑的本地 AI 桥/)).toBeInTheDocument();
    expect(screen.getByText(/房间内角色草稿会交给 KP 处理/)).toBeInTheDocument();
  });

  it("turns a render failure into a recoverable error screen", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    function BrokenView(): never {
      throw new Error("intentional web smoke failure");
    }

    render(<AppErrorBoundary><BrokenView /></AppErrorBoundary>);

    expect(screen.getByRole("alert")).toHaveTextContent("这个页面没有正常渲染");
    expect(screen.getByRole("alert")).toHaveTextContent("intentional web smoke failure");
    expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
  });
});
