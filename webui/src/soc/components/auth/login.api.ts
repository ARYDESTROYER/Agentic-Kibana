/**
 * Co-located login/OOBE data + types (Round 4, Wave 5).
 *
 * Kept OUT of the shared `lib/api.ts` / `lib/types.ts` (parallel-build hygiene, same
 * rationale as `branding.api.ts` / `Models.api.ts`). Two concerns live here:
 *
 *  1. LOGIN WHITE-LABEL types — the additive, bounded PLAIN-TEXT `login_*` branding
 *     fields the backend `BrandingConfig` gained in Round-4 (`login_headline`,
 *     `login_body`, `login_chips`, `login_layout`, `login_illustration`). The shared
 *     `lib/types.ts` `Branding` interface only models `login_subtitle`; we read the new
 *     fields through a STRUCTURAL SUPERSET so we don't contend on that file. (The
 *     integrator may fold these into `lib/types.ts` later — see the report note.)
 *
 *  2. OOBE account-setup client — `POST /api/setup/account` (Round-4 Wave-4), the
 *     first-run "create the first super_admin" writer that REPLACES `init-admin`. It is
 *     PUBLIC/pre-auth (guarded by first-run state server-side) and self-locks after the
 *     first success.
 *
 * SECURITY (#6/#9): every `login_*` value is operator-set appearance COPY (bounded
 * plain text) or an ENUM key (layout/illustration) — never HTML/SVG/URL. The UI renders
 * copy as plain React text nodes and maps the enum keys to CODE-defined layouts /
 * illustrations. The setup response carries booleans + the username only; the password
 * is never echoed.
 */
import { api } from '@/lib/api';
import type { Branding } from '@/lib/types';
import type { LoginIllustration, LoginLayout } from './loginParts';

/**
 * The Round-4 login white-label superset of the wire branding doc. All fields are
 * additive + optional (older docs / a legacy backend simply omit them → the UI falls
 * back to its built-in copy + the 'split' layout + the aurora illustration).
 */
export interface LoginBranding extends Branding {
  /** Big hero headline (plain text, ≤120 chars server-side). Blank → built-in. */
  login_headline?: string;
  /** Hero body copy (plain text, ≤600 chars server-side). Blank → built-in. */
  login_body?: string;
  /** Short feature chips (plain text, ≤6 × ≤60 chars server-side). Empty → built-in. */
  login_chips?: string[];
  /** Curated layout key: split | centered | full. */
  login_layout?: LoginLayout | string;
  /** Curated illustration key from the code-defined set ('' = default aurora). */
  login_illustration?: LoginIllustration | string;
}

/**
 * The additive login white-label defaults, spread into the theme `DEFAULT_BRANDING`
 * so a fresh install / legacy backend renders the built-in copy + 'split' layout.
 */
export const LOGIN_BRANDING_DEFAULTS: Required<
  Pick<
    LoginBranding,
    'login_headline' | 'login_body' | 'login_chips' | 'login_layout' | 'login_illustration'
  >
> = {
  login_headline: '',
  login_body: '',
  login_chips: [],
  login_layout: 'split',
  login_illustration: '',
};

/** The POST /api/setup/account response (booleans + username only — #9). */
export interface SetupAccountResult {
  ok: boolean;
  username: string;
  role: string;
  /** The UI MAY offer MFA enrollment next (prompted-optional; never forced). */
  mfa_prompt: boolean;
}

/**
 * OOBE: create the FIRST super_admin. Callable ONLY while the platform is
 * un-bootstrapped (auth on + setup incomplete + no admin yet); it self-locks after
 * the first success. The password must clear the server-side strong-password policy
 * (min 12 chars, ≠ username, not a common password). `display_name` is optional.
 */
export function setupAccount(
  username: string,
  password: string,
  displayName?: string,
): Promise<SetupAccountResult> {
  const body: Record<string, unknown> = { username, password };
  const dn = (displayName || '').trim();
  if (dn) body.display_name = dn;
  return api.post<SetupAccountResult>('setup/account', body);
}
