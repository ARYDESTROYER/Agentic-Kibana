/**
 * Navigation type contracts for the SOC shell router.
 *
 * `NavOpts` lived in `lib/types.ts` historically; it is a UI-only navigation
 * contract (not a backend data mirror), so Round-5 moves it here next to the
 * router/shell that owns it. `lib/types.ts` keeps a re-export shim so existing
 * `import type { NavOpts } from '@/lib/types'` sites keep working unchanged.
 */

/**
 * Navigation options threaded through `Navigate` (router.tsx / App.tsx) so
 * deep-links / drill-throughs can pre-seed a destination page's filters/tab.
 * All fields optional and additive; carried in-memory (never persisted).
 */
export type NavOpts = { caseId?: string; status?: string; window?: number; tab?: string };
