/**
 * Types for the WCAG contrast gate (gate-contrast.mjs). See DESIGN_STANDARD §6.3.
 * Hand-written so the Vitest CI wiring (design-gates.test.ts) type-checks cleanly.
 */
export interface ContrastResult {
  /** 'light' | 'dark'. */
  theme: string;
  /** Human-readable axis name (e.g. 'critical-text (text)'). */
  name: string;
  /** 'text' | 'on-fill' | 'nontext'. */
  kind: string;
  /** The WCAG bar this axis must clear (4.5 or 3.0). */
  bar: number;
  /** Measured ratio (rounded), or null when a token failed to resolve. */
  ratio: number | null;
  /** True when ratio ≥ bar. */
  pass: boolean;
}

export interface ContrastCheckResult {
  ok: boolean;
  results: ContrastResult[];
}

export function checkContrast(): ContrastCheckResult;
