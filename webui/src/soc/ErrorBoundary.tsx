import * as React from 'react';
import { LoadError } from './components/LoadError';
import { Button } from '@/ui/button';

interface Props {
  /** When this value changes, a captured error is cleared (e.g. on route change). */
  resetKey?: unknown;
  children: React.ReactNode;
}

/** Minimal app-level error boundary (token-styled, no EUI). */
export class ErrorBoundary extends React.Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: unknown, info: unknown) {
    // eslint-disable-next-line no-console
    console.error('UI error boundary caught:', error, info);
  }

  override render() {
    if (this.state.error) {
      // Reuse the shared "this surface failed to load" panel (icon + #9 plain-text
      // message coercion) instead of re-rolling Alert markup, then offer TWO recovery
      // affordances with a clear hierarchy:
      //   • "Reload page" — the reliable path. The primary failure this boundary guards
      //     is a page-chunk load rejection from `React.lazy` (see registry.tsx), which
      //     React permanently caches: a plain re-render re-throws the cached error, so
      //     only a full reload re-fetches the chunk and actually recovers.
      //   • "Try again" — a cheap re-render for a transient render-time error (where the
      //     cause has since cleared); it CANNOT recover a rejected chunk load.
      return (
        <div className="space-y-3 p-6">
          <LoadError title="Something went wrong" error={this.state.error} />
          <div className="flex flex-wrap gap-2">
            <Button variant="default" onClick={() => window.location.reload()}>
              Reload page
            </Button>
            <Button variant="outline" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
