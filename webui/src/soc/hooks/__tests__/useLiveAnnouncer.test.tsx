/**
 * useLiveAnnouncer — live-region announcer coverage.
 *
 *   1. LiveRegion mounts both a polite (role=status) and assertive (role=alert) node;
 *   2. announce() sets the polite text (after the re-trigger tick);
 *   3. announce(..,'assertive') targets the alert channel;
 *   4. text is rendered as a plain text node (#9) — never HTML.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

import { useLiveAnnouncer } from '../useLiveAnnouncer';

function Harness() {
  const { announce, LiveRegion } = useLiveAnnouncer();
  return (
    <div>
      <button type="button" onClick={() => announce('sorted by risk, descending')}>
        polite
      </button>
      <button type="button" onClick={() => announce('load failed', 'assertive')}>
        loud
      </button>
      <LiveRegion />
    </div>
  );
}

describe('useLiveAnnouncer', () => {
  it('mounts polite + assertive regions and announces on each channel', async () => {
    render(<Harness />);
    const status = screen.getByRole('status');
    const alert = screen.getByRole('alert');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(status).toHaveTextContent('');

    act(() => {
      screen.getByText('polite').click();
    });
    await waitFor(() => expect(status).toHaveTextContent('sorted by risk, descending'));
    // The assertive channel stays untouched by a polite announce.
    expect(alert).toHaveTextContent('');

    act(() => {
      screen.getByText('loud').click();
    });
    await waitFor(() => expect(alert).toHaveTextContent('load failed'));
  });

  it('renders the message as plain text (no HTML injection, #9)', async () => {
    function EvilHarness() {
      const { announce, LiveRegion } = useLiveAnnouncer();
      return (
        <div>
          <button type="button" onClick={() => announce('<img src=x onerror=1>')}>
            go
          </button>
          <LiveRegion />
        </div>
      );
    }
    render(<EvilHarness />);
    act(() => {
      screen.getByText('go').click();
    });
    const status = screen.getByRole('status');
    await waitFor(() => expect(status).toHaveTextContent('<img src=x onerror=1>'));
    // No element was injected — the payload is a text node only.
    expect(status.querySelector('img')).toBeNull();
  });
});
