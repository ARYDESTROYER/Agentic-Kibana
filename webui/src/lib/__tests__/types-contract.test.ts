/**
 * Type-contract regression guards for `src/lib/types.ts` (Round-6 sweep —
 * units `lib.types.ts-7` + `contract-dashboards`).
 *
 * These lock three fixes that are otherwise easy to silently regress because they
 * are TYPE-LEVEL (types are erased at runtime). The compile-time `const` bindings
 * below ARE the real assertions — `tsc --noEmit` (and vitest's transpile) fails if
 * the contract narrows again; the runtime `expect`s exist so `vitest run` executes
 * the spec and the #9 source-comment guard is genuinely checked:
 *
 *   1. `Entity.type` covers all SIX backend `EntityType` kinds (ip/user/host +
 *      file_hash/domain/rule) — a case grouped on a rule/domain/hash cluster used
 *      to be typed as impossible.
 *   2. `DashboardLayout` types `columns` + the per-breakpoint `layouts` map that
 *      the backend model + sanitizer already round-trip.
 *   3. The #9 rendering-guidance comments point at LIVE primitives, not the removed
 *      `@elastic/eui` ones (`EuiCode`/`EuiCodeBlock`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Entity, EntityTypeFull, DashboardLayout, DashboardWidget } from '../types';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES_TS = resolve(HERE, '../types.ts');

describe('Entity.type covers every backend EntityType kind (lib.types.ts-7)', () => {
  it('accepts all six kinds (domain/file_hash/rule used to fail to compile)', () => {
    const kinds: EntityTypeFull[] = ['ip', 'user', 'host', 'file_hash', 'domain', 'rule'];
    // Compile-time proof: each kind is assignable to Entity.type.
    const entities: Entity[] = kinds.map((type) => ({ type, value: 'x' }));
    expect(entities.map((e) => e.type)).toEqual(kinds);
  });

  it('is exactly the EntityTypeFull union (exhaustive switch, no `never` arm hit)', () => {
    // If the union narrowed or widened, this exhaustive switch would fail to
    // compile — the `never` assignment guards it at the type level.
    const label = (t: Entity['type']): string => {
      switch (t) {
        case 'ip':
          return 'IP';
        case 'user':
          return 'User';
        case 'host':
          return 'Host';
        case 'file_hash':
          return 'File hash';
        case 'domain':
          return 'Domain';
        case 'rule':
          return 'Rule';
        default: {
          const _exhaustive: never = t;
          return _exhaustive;
        }
      }
    };
    expect(label('rule')).toBe('Rule');
    // Entity['type'] and EntityTypeFull are mutually assignable.
    const fromCase: Entity['type'] = 'domain';
    const asFull: EntityTypeFull = fromCase;
    expect(asFull).toBe('domain');
  });
});

describe('DashboardLayout mirrors the backend columns + layouts (contract-dashboards)', () => {
  it('types `columns` and the per-breakpoint `layouts` map', () => {
    const widget: DashboardWidget = { type: 'kpi' };
    const layout: DashboardLayout = {
      id: 'dash-1',
      name: 'My board',
      columns: 12,
      widgets: [widget],
      layouts: { lg: [widget], md: [] },
    };
    expect(layout.columns).toBe(12);
    expect(Object.keys(layout.layouts ?? {})).toEqual(['lg', 'md']);
    // `layouts` values are widget lists (same shape as `widgets`).
    const lg: DashboardWidget[] = layout.layouts?.lg ?? [];
    expect(lg[0]?.type).toBe('kpi');
  });
});

describe('#9 rendering guidance points at live primitives, not removed EUI', () => {
  it('no longer references any removed @elastic/eui primitive', () => {
    const src = readFileSync(TYPES_TS, 'utf8');
    expect(src).not.toMatch(/Eui[A-Z]/); // EuiCode, EuiCodeBlock, ...
    expect(src).not.toMatch(/@elastic\/eui/);
    // ...and names the current UNTRUSTED-safe primitives instead.
    expect(src).toMatch(/InlineCode|CodeBlock/);
  });
});
