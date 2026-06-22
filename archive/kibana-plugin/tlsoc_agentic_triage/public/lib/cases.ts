/**
 * Shared case-list logic: risk banding, sorting, and filtering. Pure functions
 * (no React/EUI) so the grid surfaces (Investigate, Automated Scans) share one
 * source of truth for how cases are bucketed, ordered, and filtered.
 */
import type { Case } from '../../common';
import { COLORS } from '../components/ui';

/* ------------------------------------------------------------- risk bands --- */

export type RiskBand = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

/** Bucket a 0..100 risk score into a severity band (mirrors `riskHex` cutoffs). */
export function riskBand(score?: number): RiskBand {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'unknown';
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

export const RISK_BANDS: RiskBand[] = ['critical', 'high', 'medium', 'low'];

export function riskBandLabel(band: RiskBand): string {
  switch (band) {
    case 'critical':
      return 'Critical';
    case 'high':
      return 'High';
    case 'medium':
      return 'Medium';
    case 'low':
      return 'Low';
    default:
      return 'Unknown';
  }
}

export function riskBandHex(band: RiskBand): string {
  switch (band) {
    case 'critical':
      return COLORS.danger;
    case 'high':
      return '#e2725b';
    case 'medium':
      return COLORS.warning;
    case 'low':
      return COLORS.success;
    default:
      return COLORS.subdued;
  }
}

/* ----------------------------------------------------------------- verdict -- */

export type VerdictKey = 'true_positive' | 'false_positive' | 'inconclusive' | 'unverdicted';

/** Normalise a free-form verdict string into one of our filterable keys. */
export function verdictKey(verdict?: string): VerdictKey {
  const v = (verdict || '').toUpperCase();
  if (!v) return 'unverdicted';
  if (v.includes('TRUE')) return 'true_positive';
  if (v.includes('FALSE')) return 'false_positive';
  return 'inconclusive';
}

export function verdictKeyLabel(key: VerdictKey): string {
  switch (key) {
    case 'true_positive':
      return 'True positive';
    case 'false_positive':
      return 'False positive';
    case 'inconclusive':
      return 'Inconclusive';
    default:
      return 'Unverdicted';
  }
}

/* ------------------------------------------------------------------- sort --- */

export type SortKey = 'risk_desc' | 'risk_asc' | 'newest' | 'oldest';

export const SORT_OPTIONS: Array<{ value: SortKey; text: string }> = [
  { value: 'risk_desc', text: 'Risk: high → low' },
  { value: 'risk_asc', text: 'Risk: low → high' },
  { value: 'newest', text: 'Newest first' },
  { value: 'oldest', text: 'Oldest first' },
];

function ts(c: Case): number {
  const v = Date.parse(c.created_at || c.updated_at || '');
  return Number.isNaN(v) ? 0 : v;
}

/** Return a NEW sorted array of cases by the given key. */
export function sortCases(cases: Case[], key: SortKey): Case[] {
  const out = [...cases];
  switch (key) {
    case 'risk_desc':
      out.sort((a, b) => (b.risk_score ?? -1) - (a.risk_score ?? -1));
      break;
    case 'risk_asc':
      out.sort((a, b) => (a.risk_score ?? Infinity) - (b.risk_score ?? Infinity));
      break;
    case 'newest':
      out.sort((a, b) => ts(b) - ts(a));
      break;
    case 'oldest':
      out.sort((a, b) => ts(a) - ts(b));
      break;
  }
  return out;
}

/* ----------------------------------------------------------------- filter --- */

/**
 * Active filters. Each list is an OR-set; an EMPTY list means "no constraint on
 * this dimension". A case must satisfy every non-empty dimension to be shown.
 */
export interface CaseFilters {
  statuses: string[];
  riskBands: RiskBand[];
  verdicts: VerdictKey[];
}

export const EMPTY_FILTERS: CaseFilters = { statuses: [], riskBands: [], verdicts: [] };

export function filtersActiveCount(f: CaseFilters): number {
  return f.statuses.length + f.riskBands.length + f.verdicts.length;
}

export function caseMatches(c: Case, f: CaseFilters): boolean {
  if (f.statuses.length && !f.statuses.includes((c.status || '').toLowerCase())) {
    return false;
  }
  if (f.riskBands.length && !f.riskBands.includes(riskBand(c.risk_score))) {
    return false;
  }
  if (f.verdicts.length && !f.verdicts.includes(verdictKey(c.verdict))) {
    return false;
  }
  return true;
}

/** Apply filters then sort, in one call. */
export function applyControls(cases: Case[], f: CaseFilters, sort: SortKey): Case[] {
  return sortCases(
    cases.filter((c) => caseMatches(c, f)),
    sort
  );
}
