import { Component, type ReactNode } from "react";

interface ViewErrorBoundaryProps {
  /** Changing this key clears the failure so navigation can recover the app. */
  readonly resetKey: string;
  readonly children: ReactNode;
}

interface ViewErrorBoundaryState {
  readonly error?: Error;
}

/**
 * A crashed view must show what broke instead of a blank page: testers can
 * only report what they can see, and the rest of the app (room connection,
 * saved data) is still alive behind the failed render.
 */
export class ViewErrorBoundary extends Component<ViewErrorBoundaryProps, ViewErrorBoundaryState> {
  state: ViewErrorBoundaryState = {};

  static getDerivedStateFromError(error: unknown): ViewErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidUpdate(previous: ViewErrorBoundaryProps) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: undefined });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="mx-auto mt-10 max-w-2xl rounded-xl border border-red-900/70 bg-red-950/20 p-6">
        <h2 className="font-serif text-xl text-red-200">这个页面在渲染时出错了</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">房间连接和已保存的数据不受影响。请把下面的错误信息发给开发者，然后点「重试」或切换到其它页面。</p>
        <p className="mt-3 select-all break-words rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-5 text-red-300">{error.message}</p>
        {error.stack && <details className="mt-2 text-xs text-zinc-500">
          <summary className="cursor-pointer hover:text-zinc-300">技术细节</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-3 text-[10px] leading-4">{error.stack}</pre>
        </details>}
        <button
          type="button"
          className="mt-4 inline-flex h-10 items-center rounded-md bg-red-900/60 px-4 text-sm font-semibold text-red-100 hover:bg-red-900"
          onClick={() => this.setState({ error: undefined })}
        >重试</button>
      </div>
    );
  }
}
