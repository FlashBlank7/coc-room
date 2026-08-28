// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getRepository } from "../data/repository";
import { useAppStore } from "../store/app-store";
import { SettingsView } from "./SettingsView";

const { getCodexStatus, runNetworkDiagnostic } = vi.hoisted(() => ({
  getCodexStatus: vi.fn(),
  runNetworkDiagnostic: vi.fn(),
}));

vi.mock("../lib/network-diagnostic", () => ({
  runNetworkDiagnostic,
}));

vi.mock("../lib/module-parser", () => ({
  hasDeepseekKey: vi.fn().mockResolvedValue(false),
  saveDeepseekKey: vi.fn(),
  deleteDeepseekKey: vi.fn(),
  getCodexStatus,
}));

describe("SettingsView network diagnostics", () => {
  beforeEach(async () => {
    runNetworkDiagnostic.mockReset().mockResolvedValue({
      mode: "relay",
      hostPath: "relay",
      playerPath: "relay",
      durationMs: 123,
      payloadBytes: 100_000,
    });
    getCodexStatus.mockReset().mockResolvedValue({
      installed: true,
      compatible: true,
      authenticated: true,
      version: "codex-cli test",
    });
    useAppStore.getState().setRelayUrl("http://127.0.0.1:8787");
    useAppStore.getState().setParserProvider("codex");
    useAppStore.getState().setCodexModel("");
    useAppStore.getState().setDeepseekModel("deepseek-v4-flash");
    await (await getRepository()).setSetting("moduleParserProvider", "codex");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("runs the forced relay check and reports its measured payload", async () => {
    render(<SettingsView />);

    fireEvent.click(screen.getByRole("button", { name: "强制检测中继" }));

    await waitFor(() => expect(runNetworkDiagnostic).toHaveBeenCalledWith(
      "http://127.0.0.1:8787",
      "relay",
    ));
    expect(await screen.findByText(/WebSocket 中继自检通过/)).toHaveTextContent("100,000 字节");
  });

  it("checks the local Codex installation without requesting an API key", async () => {
    render(<SettingsView />);

    fireEvent.click(screen.getByRole("button", { name: "检测 Codex" }));

    await waitFor(() => expect(getCodexStatus).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Codex 已就绪/)).toHaveTextContent("codex-cli test");
    expect(screen.queryByLabelText("DeepSeek API Key")).toBeNull();
  });

  it("uses a provider draft until settings are saved", async () => {
    render(<SettingsView />);

    fireEvent.change(screen.getByLabelText("模组解析服务"), {
      target: { value: "deepseek" },
    });
    expect(screen.getByPlaceholderText("sk-…")).toBeInTheDocument();
    expect(useAppStore.getState().parserProvider).toBe("codex");

    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => expect(useAppStore.getState().parserProvider).toBe("deepseek"));
    expect(await (await getRepository()).getSetting("moduleParserProvider")).toBe("deepseek");
  });
});
