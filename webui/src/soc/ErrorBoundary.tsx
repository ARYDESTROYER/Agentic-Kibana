import * as React from 'react';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
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
      return (
        <div className="p-6">
          <Alert variant="destructive">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>{this.state.error.message}</AlertDescription>
          </Alert>
          <div className="mt-3">
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
