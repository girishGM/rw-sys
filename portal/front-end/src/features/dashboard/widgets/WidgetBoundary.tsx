/**
 * T-023 — "wrap each [widget] in a small boundary" (implementation note 5). `useQuery`'s own
 * `isError` branch (see each `create*Widget` factory) is the *expected* failure path — a
 * request that failed. This class component is the second, narrower layer beneath it: a widget
 * that throws while *rendering* (a `config` shape a future widget did not defend against, for
 * instance) still degrades to the same error tile instead of white-screening every other tile
 * on the dashboard — exactly the risk 04-FRONTEND.md §3 calls out for an unknown `widget_key`,
 * one level further in.
 *
 * A class component because `getDerivedStateFromError`/`componentDidCatch` are still the only
 * way to catch a render error in React 18 — no hook equivalent exists.
 */
import { Component, type ReactNode } from 'react';
import { WidgetErrorTile } from './WidgetError';

interface WidgetBoundaryProps {
  readonly label: string;
  readonly children: ReactNode;
}

interface WidgetBoundaryState {
  readonly hasError: boolean;
}

export class WidgetBoundary extends Component<WidgetBoundaryProps, WidgetBoundaryState> {
  state: WidgetBoundaryState = { hasError: false };

  static getDerivedStateFromError(): WidgetBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    // Last-resort visibility for a failure this boundary otherwise fully swallows — never
    // rendered to the user, console only (same pattern as `app/ErrorBoundary.tsx`).
    console.error(`[dashboard widget] "${this.props.label}" crashed while rendering`, error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <WidgetErrorTile label={this.props.label} />;
    }
    return this.props.children;
  }
}
