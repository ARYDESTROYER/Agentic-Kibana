/**
 * Round-6 Stage-1 type-contract regressions for `src/lib/types.ts` (handoffs 15/16/21).
 *
 * These lock additive wire-contract fields that are TYPE-LEVEL (erased at runtime): the
 * compile-time `const` bindings ARE the assertions (`tsc --noEmit` / vitest transpile
 * fails if a field is dropped). The runtime `expect`s exist so `vitest run` executes the
 * spec and the `configuredSsoById` helper (#21) is genuinely exercised.
 */
import { describe, it, expect } from 'vitest';
import { configuredSsoById } from '../types';
import type {
  AutomationRule,
  RuleDefinition,
  RuleSchedule,
  RuleSuppression,
  ConfiguredStatus,
} from '../types';

describe('#15 CaseAutomationRule display name (AutomationRule.name)', () => {
  it('carries an optional display name independent of id', () => {
    const rule: AutomationRule = {
      id: 'auto1',
      name: 'Tag brute force',
      action: 'tag',
    };
    expect(rule.name).toBe('Tag brute force');
    // Optional: a rule without a name still typechecks.
    const noName: AutomationRule = { id: 'auto2', action: 'notify' };
    expect(noName.name).toBeUndefined();
  });
});

describe('#16 RuleDefinition advisory metadata (mitre/schedule/suppression)', () => {
  it('carries mitre + schedule + suppression as optional wire fields', () => {
    const schedule: RuleSchedule = { interval_seconds: 300, lookback_seconds: 60 };
    const suppression: RuleSuppression = {
      by: ['source.ip'],
      scope: 'per_window',
      window_seconds: 600,
      missing_field: 'keep',
    };
    const rule: RuleDefinition = {
      name: 'r6_meta',
      match: { field: 'event.module', op: 'equals', value: 'y' },
      mitre: ['T1110', 'T1078'],
      schedule,
      suppression,
    };
    expect(rule.mitre).toEqual(['T1110', 'T1078']);
    expect(rule.schedule?.interval_seconds).toBe(300);
    expect(rule.suppression?.scope).toBe('per_window');
    // A rule without any of the new metadata still typechecks (byte-identical OOTB).
    const bare: RuleDefinition = {
      name: 'plain',
      match: { field: 'a', op: 'exists' },
    };
    expect(bare.mitre).toBeUndefined();
  });
});

describe('#21 configuredSsoById — per-provider SSO configured map', () => {
  it('reads the additive nested map out of `configured`', () => {
    const configured = {
      es_api_key: true,
      sso_client_secrets: true,
      sso_client_secrets_by_id: { google: true, azure: false },
    } as unknown as ConfiguredStatus;
    expect(configuredSsoById(configured)).toEqual({ google: true, azure: false });
    expect(configuredSsoById(configured).google).toBe(true);
    expect(configuredSsoById(configured).azure).toBe(false);
  });

  it('degrades to {} when the map is absent (older backend / compat)', () => {
    const legacy = { sso_client_secrets: false } as unknown as ConfiguredStatus;
    expect(configuredSsoById(legacy)).toEqual({});
    // An unknown provider id is simply undefined (falsy) — never throws.
    expect(configuredSsoById(legacy).whatever).toBeUndefined();
  });
});
