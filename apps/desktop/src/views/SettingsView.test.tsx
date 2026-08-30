// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    document.head.innerHTML = '<meta name="coc-room-local-ai-token" content="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">';
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
    document.head.innerHTML = "";
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    vi.clearAllMocks();
  });

  it("keeps low-frequency network and development controls out of the default task", () => {
    render(<SettingsView />);

    const connectionCheck = screen.getByText("联机遇到问题？运行连接检查").closest("details") as HTMLDetailsElement;
    const developmentReset = screen.getByText("开发调试：重置网页数据").closest("details") as HTMLDetailsElement;
    expect(connectionCheck.open).toBe(false);
    expect(developmentReset.open).toBe(false);

    fireEvent.click(screen.getByText("联机遇到问题？运行连接检查"));
    expect(connectionCheck.open).toBe(true);
  });

  it("reports the forced relay check in player-facing language and keeps measurements secondary", async () => {
    render(<SettingsView />);

    fireEvent.click(screen.getByText("联机遇到问题？运行连接检查"));
    fireEvent.click(screen.getByRole("button", { name: "检测备用连接" }));

    await waitFor(() => expect(runNetworkDiagnostic).toHaveBeenCalledWith(
      "http://127.0.0.1:8787",
      "relay",
    ));
    expect(await screen.findByRole("status")).toHaveTextContent("备用连接可用");
    expect(screen.queryByText(/100,000 字节/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("查看本次检查详情"));
    expect(screen.getByText(/98 KB/)).toHaveTextContent("不到 1 秒");
  });

  it("explains a failed direct check without requiring WebRTC knowledge", async () => {
    runNetworkDiagnostic.mockRejectedValueOnce(new Error("WebRTC DataChannel 未能建立: ICE timeout"));
    render(<SettingsView />);

    fireEvent.click(screen.getByText("联机遇到问题？运行连接检查"));
    fireEvent.click(screen.getByRole("button", { name: "检测直连" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("房间仍可使用备用连接");
    const detail = screen.getByText("查看本次检查详情").closest("details") as HTMLDetailsElement;
    expect(detail.open).toBe(false);
    fireEvent.click(screen.getByText("查看本次检查详情"));
    expect(detail.open).toBe(true);
    expect(alert).toHaveTextContent("WebRTC DataChannel 未能建立");
  });

  it("checks the local Codex installation without requesting an API key", async () => {
    render(<SettingsView />);

    fireEvent.click(screen.getByRole("button", { name: "检测 Codex" }));

    await waitFor(() => expect(getCodexStatus).toHaveBeenCalledOnce());
    expect(await screen.findByRole("status")).toHaveTextContent("文字整理与草稿功能已就绪");
    expect(screen.getByRole("status")).toHaveTextContent("codex-cli test");
    expect(screen.queryByLabelText("DeepSeek API Key")).toBeNull();
  });

  it("does not pretend the bridge-less player page can inspect host AI credentials", async () => {
    document.head.innerHTML = "";
    render(<SettingsView />);

    expect(screen.getByRole("status", { name: "本地 AI 在当前网页不可用" })).toHaveTextContent("玩家页的预期安全边界");
    expect(screen.getByRole("button", { name: "检测 Codex" })).toBeDisabled();
    expect(screen.getByText(/不会伪装成“Codex 未安装”/)).toBeInTheDocument();
    expect(getCodexStatus).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("AI 文字服务"), { target: { value: "deepseek" } });
    expect(screen.getByText(/不会探测、读取或显示这台电脑的凭据状态/)).toBeInTheDocument();
    expect(screen.queryByText("尚未检测到本机凭据")).not.toBeInTheDocument();
  });

  it("shows an unavailable Codex action next to the check instead of below the settings page", async () => {
    getCodexStatus.mockResolvedValueOnce({
      installed: true,
      compatible: true,
      authenticated: false,
      version: "codex-cli test",
    });
    render(<SettingsView />);

    const codexCard = screen.getByText("Codex 是否可以使用").parentElement!;
    expect(within(codexCard).getByText(/角色草稿和 NPC 文字辅助/)).toBeInTheDocument();
    fireEvent.click(within(codexCard).getByRole("button", { name: "检测 Codex" }));

    const feedback = await within(codexCard).findByRole("alert");
    expect(feedback).toHaveTextContent("Codex 已安装，但还没有登录");
    expect(feedback).toHaveTextContent("codex login");
  });

  it("uses a provider draft until settings are saved", async () => {
    render(<SettingsView />);

    fireEvent.change(screen.getByLabelText("AI 文字服务"), {
      target: { value: "deepseek" },
    });
    expect(screen.getByText("pnpm ai:key:set")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("sk-…")).not.toBeInTheDocument();
    expect(useAppStore.getState().parserProvider).toBe("codex");

    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => expect(useAppStore.getState().parserProvider).toBe("deepseek"));
    expect(await (await getRepository()).getSetting("moduleParserProvider")).toBe("deepseek");
  });

  it("does not change the active relay while an edited address is still unsaved", async () => {
    render(<SettingsView />);

    fireEvent.click(screen.getByText("房间连接设置（通常不用改）"));
    fireEvent.change(screen.getByLabelText("公网信令/中继节点"), {
      target: { value: "https://relay.example.test" },
    });
    expect(useAppStore.getState().relayUrl).toBe("http://127.0.0.1:8787");

    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => expect(useAppStore.getState().relayUrl).toBe("https://relay.example.test"));
  });

  it("keeps the native Credential Manager input in the Tauri runtime", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    useAppStore.getState().setParserProvider("deepseek");
    render(<SettingsView />);

    expect(screen.getByPlaceholderText("sk-…")).toBeInTheDocument();
    expect(screen.queryByText("pnpm ai:key:set")).not.toBeInTheDocument();
  });
});
