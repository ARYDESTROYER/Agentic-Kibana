/**
 * TraceTimeline — error-state coverage (Round-6 finding: adopt the shared LoadError).
 *
 * Pins that the timeline's failure state uses the shared `LoadError` primitive (the ONE
 * reusable load-failure panel) rather than a hand-rolled Alert+Button, and that the
 * error message is coerced through `errorMessage()` so a non-Error rejection still
 * surfaces its real message instead of a generic fallback.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { TraceTimeline } from '../TraceTimeline';
import { ApiError } from '@/lib/api';

describe('TraceTimeline — error state (shared LoadError)', () => {
  it('renders the shared LoadError title + message and wires Retry', () => {
    const onRetry = vi.fn();
    render(<TraceTimeline data={null} error={new Error('backend exploded')} onRetry={onRetry} />);

    expect(screen.getByText('Could not load the timeline')).toBeInTheDocument();
    expect(screen.getByText('backend exploded')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('surfaces an ApiError detail via errorMessage() (not the generic fallback)', () => {
    // The old hand-rolled block used `error instanceof Error ? error.message : 'Something
    // went wrong.'`; an ApiError carrying the backend `detail` now surfaces it verbatim.
    render(<TraceTimeline data={null} error={new ApiError(500, 'timeline index unavailable')} />);
    expect(screen.getByText('timeline index unavailable')).toBeInTheDocument();
    // No Retry button when onRetry is omitted (LoadError contract).
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
