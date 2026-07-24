import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";

interface Props {
  children: ReactNode;
  /** Optional label so nested boundaries can identify where the crash happened. */
  scope?: string;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/runtime errors in the subtree and shows a graceful fallback
 * instead of a blank white screen. The demo runs fully on-device, so a reset
 * usually recovers.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[FluoroView${this.props.scope ? " · " + this.props.scope : ""}]`, error, info.componentStack);
  }

  handleReset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="grid min-h-[50vh] place-items-center px-4 py-16" role="alert">
        <div className="max-w-md rounded-2xl glass-strong p-8 text-center shadow-panel">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-rose-400/15 ring-1 ring-rose-400/30">
            <TriangleAlert className="h-7 w-7 text-rose-300" />
          </div>
          <h2 className="text-lg font-bold text-white">Something went wrong</h2>
          <p className="mt-2 text-sm leading-relaxed text-white/60">
            An unexpected error occurred{this.props.scope ? ` in ${this.props.scope}` : ""}. Your data is on-device, so
            resetting the view will usually recover.
          </p>
          {this.state.error?.message && (
            <pre className="mt-3 max-h-28 overflow-auto rounded-lg bg-ink-950/60 p-3 text-left font-mono text-[11px] text-white/45 ring-1 ring-white/5">
              {this.state.error.message}
            </pre>
          )}
          <div className="mt-5 flex justify-center gap-2">
            <button onClick={this.handleReset} className="btn-primary inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm">
              <RefreshCw className="h-4 w-4" /> Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="rounded-xl border border-white/15 bg-white/[0.03] px-4 py-2 text-sm font-semibold text-white/75 transition hover:bg-white/[0.07]"
            >
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
