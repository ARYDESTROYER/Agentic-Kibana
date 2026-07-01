/**
 * Types for the CVD gate (gate-cvd.mjs). See DESIGN_STANDARD §1.4/§12.5.
 * Hand-written so the Vitest CI wiring (design-gates.test.ts) type-checks cleanly.
 */
export interface CvdProblem {
  /** 'light' | 'dark'. */
  theme: string;
  /** 'structure' | 'normal' | 'protan' | 'deutan' | 'tritan'. */
  sim: string;
  /** First `--chart-*` token in the pair (or the unresolved token for 'structure'). */
  a: string;
  /** Second `--chart-*` token in the pair (or '—' for 'structure'). */
  b: string;
  /** Measured CIELAB ΔE (rounded), or null for 'structure'. */
  de: number | null;
}

export interface CvdResult {
  ok: boolean;
  problems: CvdProblem[];
  /** Advisory grayscale collapses (not failures — see gate doc comment). */
  advisories: CvdProblem[];
  /** Count of chart tokens that resolved across both themes (16 when all present). */
  resolved: number;
}

export function checkCvd(): CvdResult;
