/**
 * Rules-FE adapter spec (Round-5 G6 · R2/R3).
 *
 * The adapter is the ONLY place the UI `RuleForm` is reshaped into the existing wire
 * keys (`RuleDefinition`/`CorrelationRule`/`RuleMatch`, `AutomationRule`,
 * `BaselineConfig`). Proving the mapping is deterministic + lossless-on-round-trip is
 * how we keep `case_manager.decide()` byte-identical (#3): the editor only ever emits
 * these exact wire shapes.
 */
import { describe, it, expect } from 'vitest';

import {
  anomalyToBaseline,
  baselineToAnomaly,
  caseAutomationToWire,
  detectionMatchToWire,
  modeForN,
  wireToCaseAutomation,
  wireToDetectionMatch,
} from '../adapter';
import { newRuleForm } from '../constants';
import type { RuleForm } from '../types';

describe('modeForN (correlation mode derivation)', () => {
  it('n=1 → every, n>1 → threshold, explicit never preserved', () => {
    expect(modeForN(1)).toBe('every');
    expect(modeForN(5)).toBe('threshold');
    expect(modeForN(9, 'never')).toBe('never');
  });
});

describe('detectionMatchToWire — form → RuleDefinition', () => {
  const base = () => {
    const f = newRuleForm('detection_match') as Extract<RuleForm, { tier: 'detection_match' }>;
    f.about.name = 'ssh-bruteforce';
    f.about.description = 'many failed logins';
    f.predicates = [{ field: 'rule.id', op: 'equals', value: '5710' }];
    f.threshold = { groupBy: 'ip', n: 5, windowSeconds: 120, mode: 'threshold' };
    return f;
  };

  it('maps the FIRST predicate to the single wire `match` + threshold to `correlation`', () => {
    const wire = detectionMatchToWire(base());
    expect(wire).not.toBeNull();
    expect(wire!.name).toBe('ssh-bruteforce');
    expect(wire!.match).toEqual({ field: 'rule.id', op: 'equals', value: '5710' });
    expect(wire!.correlation).toEqual({
      mode: 'threshold',
      n: 5,
      window_seconds: 120,
      group_by: 'ip',
    });
    expect(wire!.enabled).toBe(true);
    expect(wire!.priority).toBe(100);
  });

  it('an `exists` op emits a null value on the wire', () => {
    const f = base();
    f.predicates = [{ field: 'rule.tags', op: 'exists', value: 'ignored' }];
    const wire = detectionMatchToWire(f);
    expect(wire!.match).toEqual({ field: 'rule.tags', op: 'exists', value: null });
  });

  it('n=1 derives correlation mode `every` (a simple match rule)', () => {
    const f = base();
    f.threshold = { groupBy: 'user', n: 1, windowSeconds: 60, mode: 'every' };
    const wire = detectionMatchToWire(f);
    expect(wire!.correlation!.mode).toBe('every');
    expect(wire!.correlation!.n).toBe(1);
  });

  it('refuses to emit an unnamed or predicate-less rule (returns null)', () => {
    const f = base();
    f.about.name = '   ';
    expect(detectionMatchToWire(f)).toBeNull();

    const g = base();
    g.predicates = [{ field: '', op: 'equals', value: 'x' }];
    expect(detectionMatchToWire(g)).toBeNull();
  });

  it('round-trips wire → form → wire losslessly for the fields the wire carries', () => {
    const wire = detectionMatchToWire(base())!;
    const form = wireToDetectionMatch(wire);
    const again = detectionMatchToWire(form)!;
    expect(again.name).toBe(wire.name);
    expect(again.match).toEqual(wire.match);
    expect(again.correlation).toEqual(wire.correlation);
    expect(again.enabled).toBe(wire.enabled);
    expect(again.priority).toBe(wire.priority);
  });
});

describe('caseAutomationToWire — form → AutomationRule', () => {
  it('maps conditions/action/payload + About id/priority/enabled', () => {
    const f = newRuleForm('case_automation') as Extract<RuleForm, { tier: 'case_automation' }>;
    f.about.enabled = true;
    f.about.priority = 50;
    f.automation = {
      conditions: { verdict: 'true_positive', min_risk: 70 },
      action: 'tag',
      payload: { tags: ['watchlist'] },
    };
    const wire = caseAutomationToWire(f, 'rule-abc');
    expect(wire).toEqual({
      id: 'rule-abc',
      enabled: true,
      priority: 50,
      conditions: { verdict: 'true_positive', min_risk: 70 },
      action: 'tag',
      payload: { tags: ['watchlist'] },
    });
  });

  it('round-trips wire → form → wire (id preserved via the caller)', () => {
    const original = {
      id: 'rule-1',
      enabled: false,
      priority: 100,
      conditions: { status: 'escalated' },
      action: 'notify' as const,
      payload: { channel_id: 'slack' },
    };
    const form = wireToCaseAutomation(original);
    const again = caseAutomationToWire(form, original.id);
    expect(again).toEqual(original);
  });
});

describe('anomaly <-> baseline', () => {
  it('writes only the owned baseline fields and preserves the rest (deep-merge friendly)', () => {
    const f = newRuleForm('detection_anomaly') as Extract<RuleForm, { tier: 'detection_anomaly' }>;
    f.about.enabled = true;
    f.anomaly = { groupBy: 'ip', sensitivity: 4.2, warmupMultiplier: 2, seasonality: 'hour_of_day' };
    const next = anomalyToBaseline(f, { half_life_days: 7, tdigest_compression: 100 });
    expect(next.enabled).toBe(true);
    expect(next.modified_z_threshold).toBe(4.2);
    expect(next.warmup_multiplier).toBe(2);
    expect(next.seasonality).toBe('hour_of_day');
    // untouched sibling fields survive
    expect(next.half_life_days).toBe(7);
    expect(next.tdigest_compression).toBe(100);
  });

  it('seeds a form from an existing baseline block', () => {
    const form = baselineToAnomaly({
      enabled: true,
      modified_z_threshold: 3.0,
      warmup_multiplier: 4,
      seasonality: 'day_of_week',
    });
    expect(form.tier).toBe('detection_anomaly');
    expect(form.about.enabled).toBe(true);
    expect(form.anomaly.sensitivity).toBe(3.0);
    expect(form.anomaly.warmupMultiplier).toBe(4);
    expect(form.anomaly.seasonality).toBe('day_of_week');
  });
});
