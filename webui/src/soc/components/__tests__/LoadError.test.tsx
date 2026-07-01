/**
 * LoadError — the shared load-failure panel.
 *
 *   1. renders the title + the coerced error message (via errorMessage/ApiError);
 *   2. shows a Retry button that calls onRetry when provided;
 *   3. omits Retry when no onRetry is given;
 *   4. renders the message as plain text (#9).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LoadError } from '../LoadError';
import { ApiError } from '@/lib/api';

describe('LoadError', () => {
  it('renders the title and the coerced ApiError message', () => {
    render(<LoadError title="Couldn't load cases" error={new ApiError(500, 'store down')} />);
    expect(screen.getByText("Couldn't load cases")).toBeInTheDocument();
    expect(screen.getByText('store down')).toBeInTheDocument();
  });

  it('calls onRetry from the Retry button', async () => {
    const onRetry = vi.fn();
    render(<LoadError title="Failed" error="boom" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('omits the Retry button when no onRetry is provided', () => {
    render(<LoadError title="Failed" error="boom" />);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('renders the message as plain text (no HTML injection)', () => {
    render(<LoadError title="Failed" error={'<b>x</b>'} />);
    const msg = screen.getByText('<b>x</b>');
    expect(msg.querySelector('b')).toBeNull();
  });
});
