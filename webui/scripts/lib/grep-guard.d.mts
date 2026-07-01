/**
 * Types for the baselined grep guards (lib/grep-guard.mjs). See DESIGN_STANDARD §12.3/§12.4.
 * Hand-written so the Vitest CI wiring (design-gates.test.ts) type-checks cleanly.
 */
export interface GrepViolation {
  /** 'arbitrary-text-size' | 'raw-hex-color'. */
  pattern: string;
  /** Repo-relative posix path of the offending .tsx file. */
  file: string;
  /** Allowed occurrences from the committed baseline. */
  baseline: number;
  /** Current occurrences (> baseline for a violation). */
  current: number;
}

export interface GrepGuardResult {
  ok: boolean;
  violations: GrepViolation[];
  /** Per-pattern per-file current counts. */
  current: Record<string, Record<string, number>>;
}

export const SRC_DIR: string;
export const BASELINE_PATH: string;
export const PATTERNS: Record<string, RegExp>;

export function collectTsx(dir?: string): string[];
export function countAll(): Record<string, Record<string, number>>;
export function loadBaseline(): Record<string, Record<string, number>>;
export function checkGrepGuards(): GrepGuardResult;
