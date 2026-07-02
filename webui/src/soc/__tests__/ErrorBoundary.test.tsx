/**
 * Round-6 sweep — the app-level ErrorBoundary must (1) reuse the shared LoadError
 * primitive so the crash surface carries a semantic icon + #9-safe plain-text message
 * (not color-only signaling), and (2) offer a REAL recovery path. A plain re-render
 * cannot recover a failed `React.lazy` chunk load (React caches the rejected import),
 * so the fallback surfaces a "Reload page" button that re-fetches the chunk, alongside
 * the cheap "Try again" re-render.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ErrorBoundary } from '../ErrorBoundary';

/** A child that throws on demand so we can drive the boundary into its fallback. */
function Boom({ throws, message }: { throws: boolean; message?: string }) {
  if (throws) throw new Error(message ?? 'kaboom');
  return <div>child ok</div>;
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Boom throws={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('child ok')).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
  });

  it('shows the shared LoadError panel (icon + coerced message) on a caught error', () => {
    // React logs the boundary-caught error to console.error; silence the noise.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom throws message="disk on fire" />
      </ErrorBoundary>,
    );
    // Title from LoadError.
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    // The error message is coerced to plain text via errorMessage() (#9).
    expect(screen.getByText('disk on fire')).toBeInTheDocument();
    // A leading semantic icon exists (LoadError's AlertTriangle) — not color-only.
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('svg')).not.toBeNull();
  });

  it('offers a "Reload page" recovery path that reloads the window (chunk-load fix)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    });
    try {
      render(
        <ErrorBoundary>
          <Boom throws />
        </ErrorBoundary>,
      );
      const reloadBtn = screen.getByRole('button', { name: /reload page/i });
      fireEvent.click(reloadBtn);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: original,
      });
    }
  });

  it('"Try again" re-renders children (recovers a now-cleared transient error)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error('transient');
      return <div>recovered</div>;
    }
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    // The underlying cause has cleared; "Try again" resets state and re-renders.
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
  });

  it('clears a caught error when resetKey changes (route change)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary resetKey="a">
        <Boom throws />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    // A route change (new resetKey) with a non-throwing child clears the fallback.
    rerender(
      <ErrorBoundary resetKey="b">
        <Boom throws={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('child ok')).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
  });
});
