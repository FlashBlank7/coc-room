// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../store/app-store";
import { SettingsView } from "./SettingsView";

const { runNetworkDiagnostic } = vi.hoisted(() => ({ runNetworkDiagnostic: vi.fn() }));

vi.mock("../lib/network-diagnostic", () => ({
  runNetworkDiagnostic,
}));

vi.mock("../lib/module-parser", () => ({
  hasDeepseekKey: vi.fn().mockResolvedValue(false),
  saveDeepseekKey: vi.fn(),
  deleteDeepseekKey: vi.fn(),
}));

describe("SettingsView network diagnostics", () => {
  beforeEach(() => {
    runNetworkDiagnostic.mockReset().mockResolvedValue({
      mode: "relay",
      hostPath: "relay",
      playerPath: "relay",
      durationMs: 123,
      payloadBytes: 100_000,
    });
    useAppStore.getState().setRelayUrl("http://127.0.0.1:8787");
  });

  afterEach(() => {
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
});
