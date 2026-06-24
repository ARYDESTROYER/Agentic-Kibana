/**
 * Top-level (and per-region) React error boundary.
 *
 * A render throw anywhere below this boundary is caught and degraded to the
 * shared `ErrorCallout` instead of unmounting the whole tree (a white screen).
 * This is the safety net for bugs like the EuiAvatar `color` validation throw
 * that previously crashed the entire app.
 *
 * `resetKey` lets a caller wire the boundary to a navigation key (e.g. the
 * active tab + case id). When the key changes the error state is cleared, so
 * navigating away from a failing view recovers automatically.
 */
import React from 'react';
import { ErrorCallout } from './ui';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Fallback callout title. */
  title?: string;
  /** When this changes, the boundary clears its captured error and re-renders. */
  resetKey?: string | number;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Surface the failure in the console for diagnosis; the UI shows the callout.
    // eslint-disable-next-line no-console
    console.error('ErrorBoundary caught a render error:', error, info);
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // Recover when the caller-provided reset key changes (e.g. tab/case switch).
    if (this.state.error !== null && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override render(): React.ReactNode {
    if (this.state.error !== null) {
      return (
        <ErrorCallout
          error={this.state.error}
          title={this.props.title ?? 'Something went wrong rendering this view'}
        />
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
