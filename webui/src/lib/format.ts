/**
 * Shared, framework-free formatting helpers (copied verbatim from the former
 * Kibana plugin — they have no Kibana/EUI dependency, so they are reused here).
 *
 * These are intentionally pure (no React / no EUI) so they can be reused by every
 * component and unit-reasoned about. Keep them defensive: the backend may send
 * `undefined`, `null`, empty strings, or unparseable values, and a triage console
 * must degrade to a readable dash rather than throwing.
 */

/** A neutral placeholder used everywhere a value is missing. */
export const DASH = '—';

/**
 * Humanize an ISO timestamp into a short relative age (e.g. "3h ago").
 * Returns {@link DASH} for missing / unparseable input.
 */
export function humanizeAge(iso?: string | null): string {
  if (!iso) {
    return DASH;
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return DASH;
  }
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/**
 * Render an ISO timestamp as a compact, human-readable local datetime, e.g.
 * "Jun 17, 2026, 07:13". Falls back to the raw string (then {@link DASH}).
 */
export function formatTimestamp(iso?: string | null): string {
  if (!iso) {
    return DASH;
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return iso;
  }
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Format a monetary value. Small spends are shown with 4 decimals (the cost
 * ledger routinely deals in fractions of a cent); larger ones with 2.
 */
export function fmtMoney(v: number | undefined | null, currency?: string): string {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    return DASH;
  }
  const symbol = currency || '$';
  const decimals = Math.abs(v) >= 1 ? 2 : 4;
  return `${symbol}${v.toFixed(decimals)}`;
}

/** Format an integer-ish count with thousands separators ("12,345"). */
export function fmtNumber(v: number | undefined | null): string {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    return DASH;
  }
  try {
    return v.toLocaleString();
  } catch {
    return String(v);
  }
}

/** Format a tokens count compactly (e.g. 2085 -> "2,085", 12000 -> "12K"). */
export function fmtTokens(v: number | undefined | null): string {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    return DASH;
  }
  if (v >= 1000) {
    return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}K`;
  }
  return fmtNumber(v);
}

/**
 * Format a 0..1 confidence (or a 0..100 value) as a percentage string. Values
 * <= 1 are treated as a fraction; larger values are treated as already-percent.
 */
export function fmtPercent(v: number | undefined | null): string {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    return DASH;
  }
  const pct = v <= 1 ? v * 100 : v;
  return `${Math.round(pct)}%`;
}

/** Convert a 0..1 confidence (or 0..100) to a clamped 0..100 number. */
export function toPercentValue(v: number | undefined | null): number {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    return 0;
  }
  const pct = v <= 1 ? v * 100 : v;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** Title-case an enum-ish token: "needs_human" -> "Needs human". */
export function humanizeToken(token?: string | null): string {
  if (!token) {
    return DASH;
  }
  const spaced = token.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
