/**
 * Cost — buildComposition (Round-6 cost-composition fixes).
 *
 *   - Bug #8: the donut and the ledger swatches must agree on color-as-identity — a
 *     raw KEY maps to a stable color derived from COST order, independent of how the
 *     ledger table is re-sorted. Rows past the top-N fold into the single grey "Other".
 *   - Bug #7: the `drivers` dimension shows only a SUBSET of spend, so a residual
 *     "Other cost" slice makes the ring + legend read share-of-TOTAL (the segment sum
 *     equals the grand total that the donut center displays).
 */
import { describe, it, expect } from 'vitest';

import { buildComposition } from '../Cost';
import { categorical } from '@/soc/components/palette';

type Row = { key: string; cost: number; tokens: number; calls: number };
const row = (key: string, cost: number): Row => ({ key, cost, tokens: 0, calls: 0 });

describe('buildComposition', () => {
  it('colors each key by COST order, stable regardless of input order (bug #8)', () => {
    const rows = [row('b', 5), row('a', 10), row('c', 1)];
    const shuffled = [row('c', 1), row('b', 5), row('a', 10)];
    const one = buildComposition(rows, 'model', true, 16);
    const two = buildComposition(shuffled, 'model', true, 16);

    // Highest-cost key gets categorical(0) in BOTH orderings.
    expect(one.colorByKey.get('a')).toBe(categorical(0));
    expect(two.colorByKey.get('a')).toBe(categorical(0));
    expect(one.colorByKey.get('b')).toBe(categorical(1));
    expect(one.colorByKey.get('c')).toBe(categorical(2));
  });

  it('folds the tail past the top-N into ONE grey "Other" slice (bug #8)', () => {
    const rows = [8, 7, 6, 5, 4, 3, 2, 1].map((c) => row(`m${c}`, c));
    const { segments, colorByKey } = buildComposition(rows, 'model', true, 36);

    // 5 distinct head slices + 1 "Other (n)" roll-up.
    expect(segments).toHaveLength(6);
    const other = segments[5];
    expect(other.label).toBe('Other (3)');
    expect(other.value).toBe(3 + 2 + 1);
    // Every folded key shares the single grey "Other" color.
    const otherColor = categorical(6);
    expect(colorByKey.get('m3')).toBe(otherColor);
    expect(colorByKey.get('m2')).toBe(otherColor);
    expect(colorByKey.get('m1')).toBe(otherColor);
    // The top key keeps its distinct color.
    expect(colorByKey.get('m8')).toBe(categorical(0));
  });

  it('appends an "Other cost" residual for the drivers subset so the ring reads share-of-total (bug #7)', () => {
    const drivers = [row('d1', 3), row('d2', 2), row('d3', 1)]; // sum = 6
    const totalCost = 10;
    const { segments } = buildComposition(drivers, 'drivers', true, totalCost);

    const residual = segments.find((s) => s.label === 'Other cost');
    expect(residual).toBeDefined();
    expect(residual!.value).toBeCloseTo(4); // 10 − 6

    // Segment values now sum to the grand total shown in the donut center.
    const sum = segments.reduce((s, x) => s + x.value, 0);
    expect(sum).toBeCloseTo(totalCost);
  });

  it('omits the residual when drivers already account for all spend', () => {
    const drivers = [row('d1', 6), row('d2', 4)]; // sum = 10 = total
    const { segments } = buildComposition(drivers, 'drivers', true, 10);
    expect(segments.find((s) => s.label === 'Other cost')).toBeUndefined();
    expect(segments).toHaveLength(2);
  });

  it('humanizes non-verbatim keys and keeps verbatim keys raw', () => {
    const rows = [row('needs_human', 5)];
    expect(buildComposition(rows, 'role', false, 5).segments[0].label).toBe('Needs human');
    expect(buildComposition(rows, 'model', true, 5).segments[0].label).toBe('needs_human');
  });
});
