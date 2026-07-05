/**
 * ProvenanceTag — the ONE provenance primitive (Round-7 #9b) spec.
 *
 * Asserts each provenance kind renders BOTH an icon shape (non-color redundancy,
 * WCAG 1.4.1) AND a text label (not hue-only), that the icon-only variant exposes an
 * accessible name, and that the `severityProvenance` / `FIELD_PROVENANCE` helpers map
 * the backend vocabulary correctly.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import {
  ProvenanceTag,
  severityProvenance,
  FIELD_PROVENANCE,
  type Provenance,
} from '../ProvenanceTag';

const KINDS: { kind: Provenance; label: string }[] = [
  { kind: 'source', label: 'SIEM' },
  { kind: 'ai', label: 'AI' },
  { kind: 'code', label: 'Code' },
];

describe('ProvenanceTag — default (icon + label) variant', () => {
  for (const { kind, label } of KINDS) {
    it(`renders an icon AND the "${label}" label for kind="${kind}"`, () => {
      const { container } = render(<ProvenanceTag kind={kind} />);
      // Icon shape present (lucide renders an <svg>) — the non-color channel.
      expect(container.querySelector('svg')).toBeTruthy();
      // Text label present — meaning is never hue-only.
      expect(container.textContent).toContain(label);
      // The kind is exposed for robust targeting.
      expect(container.querySelector(`[data-provenance="${kind}"]`)).toBeTruthy();
    });
  }
});

describe('ProvenanceTag — icon-only variant (header cells)', () => {
  for (const { kind, label } of KINDS) {
    it(`renders an accessible icon with no visible short label for kind="${kind}"`, () => {
      const { container, getByRole } = render(
        <ProvenanceTag kind={kind} variant="icon" />,
      );
      // The icon carries the meaning: exposed as an image with an accessible name.
      const img = getByRole('img');
      expect(img.getAttribute('aria-label')).toMatch(/provenance/i);
      expect(container.querySelector('svg')).toBeTruthy();
      // The short pill label is NOT rendered in the icon-only variant.
      expect(container.textContent).not.toContain(label);
    });
  }
});

describe('severityProvenance', () => {
  it('maps "source_asserted" → "source"', () => {
    expect(severityProvenance('source_asserted')).toBe('source');
  });

  it('maps "derived" → "code"', () => {
    expect(severityProvenance('derived')).toBe('code');
  });

  it('maps undefined / unknown → "code"', () => {
    expect(severityProvenance(undefined)).toBe('code');
    expect(severityProvenance('')).toBe('code');
    expect(severityProvenance('something_else')).toBe('code');
  });
});

describe('FIELD_PROVENANCE map', () => {
  it('tags the deterministic fields as "code" and the LLM fields as "ai"', () => {
    expect(FIELD_PROVENANCE.risk_score).toBe('code');
    expect(FIELD_PROVENANCE.priority_level).toBe('code');
    expect(FIELD_PROVENANCE.verdict).toBe('ai');
    expect(FIELD_PROVENANCE.confidence).toBe('ai');
    // Severity is per-cell (severityProvenance), so it is intentionally NOT here.
    expect(FIELD_PROVENANCE.severity_band).toBeUndefined();
  });
});
