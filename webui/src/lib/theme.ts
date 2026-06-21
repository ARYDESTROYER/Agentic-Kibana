/**
 * Shared visual language for the Agentic SOC console.
 *
 * The semantic colour palette is reproduced from the former Kibana plugin's
 * `ui.tsx` (kept identical so the standalone console reads the same), expressed
 * as plain hex tokens applied via inline style — no `@kbn/*` theme imports, which
 * do not exist in the standalone build. EUI's own light/dark theme CSS provides
 * the chrome; these tokens encode risk / verdict / status semantics on top.
 */

/** Semantic colour tokens (one accent per meaning). */
export const COLORS = {
  primary: '#1c66e0',
  success: '#00a38c',
  warning: '#e9a200',
  danger: '#c4341c',
  accent: '#8a55c9',
  subdued: '#69707d',
  surface: '#f7f9fc',
} as const;

/** Translucent tint of a hex colour, used for icon chips / soft fills. */
export function tint(hex: string, alpha = 0.12): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Named EUI badge colour for a verdict. */
export function verdictColor(
  verdict?: string,
): 'danger' | 'success' | 'warning' | 'default' {
  const v = (verdict || '').toUpperCase();
  if (v.includes('TRUE')) return 'danger';
  if (v.includes('FALSE')) return 'success';
  if (v.includes('INCONCLUSIVE') || v.includes('UNKNOWN') || v.includes('NEEDS_HUMAN')) {
    return 'warning';
  }
  return 'default';
}

/** Hex accent for a verdict (for left borders / icon chips). */
export function verdictHex(verdict?: string): string {
  switch (verdictColor(verdict)) {
    case 'danger':
      return COLORS.danger;
    case 'success':
      return COLORS.success;
    case 'warning':
      return COLORS.warning;
    default:
      return COLORS.subdued;
  }
}

/** Hex accent for a case lifecycle status. */
export function statusHex(status?: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'closed') return COLORS.success;
  if (s === 'needs_human') return COLORS.warning;
  if (s === 'open') return COLORS.primary;
  return COLORS.subdued;
}

/** Risk colour scale over the normalised 0..100 risk score. */
export function riskHex(score?: number): string {
  if (typeof score !== 'number' || Number.isNaN(score)) return COLORS.subdued;
  if (score < 30) return COLORS.success;
  if (score < 60) return COLORS.warning;
  if (score < 80) return '#e2725b';
  return COLORS.danger;
}

/** Risk band {label,color} for a 0..100 score — used by gauges/badges. */
export function riskBand(score?: number): { label: string; color: string } {
  if (typeof score !== 'number' || Number.isNaN(score)) {
    return { label: 'Unknown', color: COLORS.subdued };
  }
  if (score < 30) return { label: 'Low', color: COLORS.success };
  if (score < 60) return { label: 'Medium', color: COLORS.warning };
  if (score < 80) return { label: 'High', color: '#e2725b' };
  return { label: 'Critical', color: COLORS.danger };
}

/** Stable categorical palette for charts (donuts, bar lists, legends). */
export const CHART_COLORS = [
  '#1c66e0', '#8a55c9', '#00a38c', '#e9a200',
  '#c4341c', '#2aa0a4', '#d6336c', '#7048e8',
] as const;

/** Pick a chart colour by index (wraps). */
export function chartColor(i: number): string {
  return CHART_COLORS[i % CHART_COLORS.length];
}

/** Accent + icon for each connector category (the wizard groups by these). */
export const CATEGORY_META: Record<string, { label: string; icon: string; accent: string }> = {
  siem: { label: 'SIEM / Log stores', icon: 'logstashQueue', accent: COLORS.primary },
  edr_xdr: { label: 'EDR / XDR', icon: 'securityApp', accent: COLORS.danger },
  transport: { label: 'Transports / Receivers', icon: 'cluster', accent: COLORS.accent },
  queue: { label: 'Queues / Brokers', icon: 'pipelineApp', accent: COLORS.warning },
  object_store: { label: 'Object stores', icon: 'storage', accent: COLORS.success },
  file: { label: 'Files', icon: 'document', accent: COLORS.subdued },
};

export function categoryMeta(category?: string): { label: string; icon: string; accent: string } {
  return (
    CATEGORY_META[category || ''] || {
      label: category || 'Other',
      icon: 'package',
      accent: COLORS.subdued,
    }
  );
}
