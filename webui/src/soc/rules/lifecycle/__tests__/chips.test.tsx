/**
 * Lifecycle chips spec (Round-5 G6 · R5) — the enabled/disabled/SHADOW state chip, the
 * per-rule health chip, and `deriveHealth`. Proves the shadow(preview) state renders
 * distinctly (never as a green "on"), and that health degrades sensibly.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { LifecycleStateChip, RuleHealthChip, deriveHealth } from '../chips';

describe('LifecycleStateChip', () => {
  it('renders the three lifecycle states with distinct plain-text labels', () => {
    const { rerender } = render(<LifecycleStateChip state="enabled" />);
    expect(screen.getByText('Enabled')).toBeInTheDocument();

    rerender(<LifecycleStateChip state="disabled" />);
    expect(screen.getByText('Disabled')).toBeInTheDocument();

    // SHADOW is the preview state — labelled explicitly, never just "Enabled".
    rerender(<LifecycleStateChip state="shadow" />);
    expect(screen.getByText(/shadow \(preview\)/i)).toBeInTheDocument();
    expect(screen.queryByText('Enabled')).not.toBeInTheDocument();
  });
});

describe('deriveHealth', () => {
  it('is unknown for a disabled rule (silence is expected)', () => {
    expect(deriveHealth({ state: 'disabled' }).status).toBe('unknown');
  });

  it('labels a disabled rule distinctly from the state chip — "Not evaluated", not "Disabled" (#45)', () => {
    // Even after a preview (matched counts present), a disabled rule stays "Not evaluated"
    // so the header does not render two identical grey "Disabled" chips side by side.
    const h = deriveHealth({ state: 'disabled', lastMatched: 12, lastScanned: 100 });
    expect(h.status).toBe('unknown');
    expect(h.label).toBe('Not evaluated');
    expect(h.label).not.toBe('Disabled');
  });

  it('warns an enabled rule with zero recent matches, ok when matching', () => {
    expect(deriveHealth({ state: 'enabled', lastScanned: 500, lastMatched: 0 }).status).toBe('warning');
    expect(deriveHealth({ state: 'enabled', lastScanned: 500, lastMatched: 12 }).status).toBe('ok');
    // shadow matches read as ok but labelled distinctly
    const shadow = deriveHealth({ state: 'shadow', lastScanned: 500, lastMatched: 3 });
    expect(shadow.status).toBe('ok');
    expect(shadow.label).toMatch(/shadow/i);
  });

  it('is failed when the last preview errored', () => {
    const h = deriveHealth({ state: 'enabled', lastErrored: true });
    expect(h.status).toBe('failed');
  });

  it('RuleHealthChip renders the derived label', () => {
    render(<RuleHealthChip health={deriveHealth({ state: 'enabled', lastScanned: 10, lastMatched: 2 })} />);
    expect(screen.getByText('Matching')).toBeInTheDocument();
  });
});
