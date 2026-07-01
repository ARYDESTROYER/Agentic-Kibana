/**
 * Widget-type ALLOWLIST contract test (Round 5 audit C1/H1).
 *
 * C1 was a shipping regression: the server allowlist
 * (`backend/app/api/routes_dashboards.py` `WIDGET_TYPES`) and the client widget
 * registry (`webui/src/soc/dashboard/registry.ts` `WIDGET_TYPES`) were authored
 * independently and drifted — sharing only 3 of ~9/14 values — so EVERY Edit→Save 400'd
 * in `_clean_widget`. No test crossed the two allowlists, so it passed CI green (H1).
 *
 * This is that missing cross-check. Both sides now pin to ONE committed source of truth
 * (`widget-types.contract.json`). This test asserts the CLIENT registry equals that
 * canonical set; the backend companion
 * (`test_round5_dashboards_widget_type_contract.py`) asserts the SERVER frozenset equals
 * the SAME file. A one-sided widget addition therefore fails CI on whichever side
 * forgot to update — the two allowlists can never silently diverge again.
 */
import { describe, it, expect } from 'vitest';

import { WIDGET_TYPES, isKnownWidgetType } from '@/soc/dashboard/registry';
import contract from '@/soc/dashboard/widget-types.contract.json';

const canonical: string[] = (contract as { widget_types: string[] }).widget_types;

describe('dashboard widget-type allowlist contract (C1/H1)', () => {
  it('the client registry WIDGET_TYPES === the canonical contract set (order-independent)', () => {
    const client = new Set<string>(WIDGET_TYPES);
    const canon = new Set<string>(canonical);
    // Symmetric-difference must be empty: no client-only type, no canonical-only type.
    const clientOnly = [...client].filter((t) => !canon.has(t));
    const canonOnly = [...canon].filter((t) => !client.has(t));
    expect(clientOnly, 'widget types in registry.ts but NOT in the contract').toEqual([]);
    expect(canonOnly, 'widget types in the contract but NOT in registry.ts').toEqual([]);
    // Same cardinality (guards against a duplicate hiding a real divergence).
    expect(client.size).toBe(canon.size);
  });

  it('every canonical widget type is a currently-registered client widget', () => {
    for (const t of canonical) {
      expect(isKnownWidgetType(t), `${t} must resolve in the client registry`).toBe(true);
    }
  });

  it('the contract set is exactly the 9 shipped widgets (a change here is deliberate)', () => {
    // A tripwire so ADDING/REMOVING a widget forces a conscious update of BOTH the
    // registry and the server frozenset (and this expected list).
    expect([...canonical].sort()).toEqual(
      [
        'chart.autonomous_vs_human',
        'chart.verdict_mix',
        'gauge.active_risk',
        'kpi.cost_budget',
        'kpi.lifecycle_timing',
        'kpi.needs_human',
        'mitre.heatmap',
        'table.connector_health',
        'table.recent_cases',
      ].sort(),
    );
  });
});
