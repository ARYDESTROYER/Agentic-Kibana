/**
 * Types for the token-existence gate (gate-tokens.mjs). See DESIGN_STANDARD §12.1.
 * Hand-written so the Vitest CI wiring (design-gates.test.ts) type-checks cleanly.
 */
export interface TokenExistenceProblem {
  /** The `--token` name that is missing from a theme block. */
  token: string;
  /** Where the required name came from ('ALLOWED_TOKENS' / 'palette.token()' / both). */
  source: string;
  /** Which theme block(s) the token is missing from (':root' and/or '.dark'). */
  missing: string[];
}

export interface TokenExistenceResult {
  ok: boolean;
  problems: TokenExistenceProblem[];
  /** Number of distinct required token names checked. */
  checked: number;
}

export function checkTokenExistence(): TokenExistenceResult;
