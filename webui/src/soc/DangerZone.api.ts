/**
 * DangerZone.api — co-located client for the tiered platform-reset endpoint
 * (Round 4, Wave 5, request #7).
 *
 * Wraps the single backend route `POST /api/admin/reset {scope, confirm}` (see
 * `backend/app/api/routes_reset.py`). The route is DOUBLE-gated server-side —
 * `require_admin` (the `users:manage` grant) AND `require_fresh_auth` (a step-up /
 * sudo re-auth window). We call it through the low-level `api.post` verb, so the
 * shared api client transparently handles the step-up challenge: a 401 carrying
 * `{code:'reauth_required'}` opens the globally-registered `ReauthDialog`, and on a
 * successful re-auth the original request is retried EXACTLY ONCE (`api.ts`
 * `request(..._retried)`). If the operator cancels the re-auth, the original 401
 * surfaces as an `ApiError` (status 401) here, which the UI reports.
 *
 * SECURITY (#9): every string the server returns (`scope`, the `cleared[]` receipt)
 * is plain data the UI renders as escaped React text nodes — never markup. This
 * module only carries typed values; it does not render anything.
 *
 * INVARIANTS this client is careful NOT to violate: it never selects an ES key (#1),
 * never touches `decide()` (#3 — reset DESTROYS cases, it never transitions one), and
 * env-provided secrets are NEVER cleared by any scope (enforced server-side; §6.6).
 * Co-located per the Round-4 convention (NOT in `lib/api.ts`) to avoid contending on
 * the shared client during parallel builds.
 */
import { api } from '@/lib/api';

/**
 * The three reset tiers, most→least conservative. Byte-matches the backend
 * `ResetScope` enum values (`constants.py:ResetScope`).
 */
export type ResetScope = 'cases' | 'sources' | 'factory';

/**
 * The exact GitHub-style type-to-confirm phrase the operator must type per scope.
 * The backend `_CONFIRM_PHRASE` map (`routes_reset.py:51`) validates the submitted
 * `confirm` against this — a mismatch is a 400 BEFORE any store is touched, so an
 * over-broad scope can never wipe more than exactly what was typed. Mirrored here so
 * the dialog can arm/disarm the destructive button purely client-side too (belt +
 * braces; the server is authoritative).
 */
export const RESET_CONFIRM_PHRASE: Record<ResetScope, string> = {
  cases: 'RESET CASES',
  sources: 'RESET SOURCES',
  factory: 'FACTORY RESET',
};

/** Request body for `POST /api/admin/reset`. */
export interface ResetRequest {
  scope: ResetScope;
  confirm: string;
}

/**
 * The `POST /api/admin/reset` response. `cleared` is a plain-data receipt enumerating
 * exactly which stores/rings/prefs were touched (e.g. `"cases:42"`, `"kv:inbox"`,
 * `"cursors"`, `"sources"`, `"connector_secrets"`, `"preferences"`, `"branding"`,
 * `"setup_flag"`, `"audit"`). Loose-by-design: absence of a line simply means that
 * store was untouched at this tier.
 */
export interface ResetResult {
  ok: boolean;
  scope: ResetScope | string;
  cleared: string[];
}

/**
 * Perform a tiered platform reset. The `confirm` phrase MUST byte-match
 * `RESET_CONFIRM_PHRASE[scope]` or the server 400s before touching any store.
 *
 * Step-up re-auth is handled transparently by the shared api client (see the module
 * docstring) — callers do not need to pre-flight `/auth/reauth`; a fresh-auth 401
 * pops the existing `ReauthDialog` and retries once on success. On a cancelled
 * re-auth (or any other failure), an `ApiError` is thrown for the caller to surface.
 */
export function adminReset(scope: ResetScope, confirm: string): Promise<ResetResult> {
  return api.post<ResetResult>('admin/reset', { scope, confirm } satisfies ResetRequest);
}
