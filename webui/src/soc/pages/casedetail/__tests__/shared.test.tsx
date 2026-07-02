/**
 * casedetail/shared — lifecycle action copy (Round-6 finding #21).
 *
 * The backend `escalate` verb sets CaseStatus.ESCALATED (distinct from NEEDS_HUMAN,
 * which is only reached via the deterministic decide()/verdict path). The confirm /
 * help copy must reflect ESCALATED so the dialog matches the resulting status badge.
 */
import { describe, it, expect } from 'vitest';

import { ALL_ACTIONS } from '../shared';

describe('casedetail/shared — escalate action copy', () => {
  it('escalate confirm/help copy says ESCALATED, not NEEDS_HUMAN (#21)', () => {
    const esc = ALL_ACTIONS.escalate;
    expect(esc.confirmBody).toMatch(/ESCALATED/);
    expect(esc.help).toMatch(/ESCALATED/);
    expect(esc.confirmBody).not.toMatch(/NEEDS_HUMAN/);
    expect(esc.help).not.toMatch(/NEEDS_HUMAN/);
    // The escalate verb still maps to the real backend verb (never invented, #3).
    expect(esc.wireAction ?? esc.key).toBe('escalate');
  });
});
