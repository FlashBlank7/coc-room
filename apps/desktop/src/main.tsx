import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { App } from "./App";
import { runNetworkDiagnostic, type NetworkDiagnosticMode } from "./lib/network-diagnostic";
import "./styles.css";

interface NetworkSmokeConfig {
  relayUrl: string;
  mode: NetworkDiagnosticMode;
}

const root = ReactDOM.createRoot(document.getElementById("root")!);

void bootstrap();

async function bootstrap(): Promise<void> {
  if (window.__TAURI_INTERNALS__) {
    try {
      const config = await invoke<NetworkSmokeConfig | null>("network_smoke_config");
      if (config) {
        root.render(<SmokeStatus message={`${config.mode === "direct" ? "WebRTC 直连" : "强制中继"}自检中…`} />);
        await runAutomatedNetworkSmoke(config);
        return;
      }
    } catch (error) {
      root.render(<SmokeStatus error message={error instanceof Error ? error.message : String(error)} />);
      return;
    }
  }

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

async function runAutomatedNetworkSmoke(config: NetworkSmokeConfig): Promise<void> {
  try {
    const result = await runNetworkDiagnostic(config.relayUrl, config.mode);
    root.render(<SmokeStatus message="网络链路自检通过" />);
    await invoke("finish_network_smoke", {
      report: {
        ok: true,
        mode: config.mode,
        message: "network diagnostic passed",
        details: result,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    root.render(<SmokeStatus error message={message} />);
    await invoke("finish_network_smoke", {
      report: {
        ok: false,
        mode: config.mode,
        message,
      },
    });
  }
}

function SmokeStatus({ message, error = false }: { message: string; error?: boolean }) {
  return (
    <main className="grid h-screen place-items-center bg-[#101317] p-8 text-ink">
      <div className="max-w-xl rounded-xl border border-zinc-800 bg-zinc-950 p-6 text-center">
        <p className={error ? "text-red-400" : "text-brass"}>{message}</p>
      </div>
    </main>
  );
}
