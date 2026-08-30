import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { Monitor, RotateCcw, X } from "lucide-react";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error?: Error;
}

/** Keeps a render failure actionable instead of leaving a blank development page. */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {};

  static getDerivedStateFromError(candidate: unknown): AppErrorBoundaryState {
    return { error: candidate instanceof Error ? candidate : new Error(String(candidate)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("CoC Room render failed", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <main className="grid h-screen place-items-center bg-[#101317] p-6 text-ink">
        <section role="alert" className="w-full max-w-xl rounded-xl border border-red-900/70 bg-zinc-950 p-6 shadow-2xl">
          <p className="text-xs uppercase tracking-[.18em] text-red-400">界面错误</p>
          <h1 className="mt-2 font-serif text-xl">这个页面没有正常渲染</h1>
          <p className="mt-3 text-sm leading-6 text-zinc-400">
            开发服务器仍在运行。修复代码后 Vite 会自动热更新；也可以重新加载页面恢复初始状态。
          </p>
          <pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-3 text-xs text-red-300">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            className="mt-5 inline-flex h-10 items-center gap-2 rounded-md bg-brass px-4 text-sm font-semibold text-zinc-950 hover:bg-amber-300"
            onClick={() => window.location.reload()}
          >
            <RotateCcw className="h-4 w-4" />重新加载
          </button>
        </section>
      </main>
    );
  }
}

/** Makes the browser/native capability boundary visible during UI work. */
export function RuntimeModeNotice() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || isTauriRuntime()) return null;
  const duoRole = developmentDuoRole();

  return (
    <aside
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-sky-800/70 bg-sky-950/95 p-3 pr-10 text-xs text-sky-100 shadow-xl backdrop-blur"
    >
      <Monitor aria-hidden="true" className="mr-2 inline h-4 w-4 text-sky-300" />
      <strong>{duoRole === "keeper" ? "KP 联调页" : duoRole === "player" ? "玩家联调页" : "网页开发模式"}</strong>
      <p className="mt-1 leading-5 text-sky-200/80">
        {duoRole === "player"
          ? "这个窗口使用独立的网页数据。热更新已启用；本页不连接这台电脑的本地 AI 桥，房间内角色草稿会交给 KP 处理。"
          : <>{duoRole && "这个窗口使用独立的网页数据。"}热更新已启用。网页数据保存在 IndexedDB；Codex、DeepSeek、DOCX 与 PDF 可经同源本地安全桥运行，无需重编译桌面端。</>}
      </p>
      <button
        type="button"
        aria-label="关闭网页开发模式提示"
        className="absolute right-2 top-2 rounded p-1 text-sky-300 hover:bg-sky-900 hover:text-white"
        onClick={() => setDismissed(true)}
      >
        <X className="h-4 w-4" />
      </button>
    </aside>
  );
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

function developmentDuoRole(): "keeper" | "player" | undefined {
  if (typeof window === "undefined") return undefined;
  const role = new URLSearchParams(window.location.search).get("duoRole");
  return role === "keeper" || role === "player" ? role : undefined;
}
