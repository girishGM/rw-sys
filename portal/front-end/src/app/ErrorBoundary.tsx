/**
 * T-020 — the root error boundary (04-FRONTEND.md §2 implementation note 7). Catches any
 * render error anywhere below it and shows a plain recovery page — the app must never
 * white-screen (TC-15). **Never renders the raw error message or a stack trace**, in any
 * build: only `componentDidCatch`'s `console.error` (visible to a developer with devtools
 * open, never to the rendered page) carries that detail.
 *
 * A class component because React 18 has no hook-based equivalent of
 * `getDerivedStateFromError` / `componentDidCatch`.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error caught by ErrorBoundary:', error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.assign('/');
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
          <div className="max-w-sm rounded-card border border-slate-200 bg-white p-8 text-center shadow-sm">
            <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
            <p className="mt-2 text-sm text-slate-500">
              An unexpected error occurred. Try reloading the page.
            </p>
            <button
              type="button"
              onClick={this.handleReload}
              className="mt-6 rounded-control bg-primary px-4 py-2 text-sm font-medium text-white"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
