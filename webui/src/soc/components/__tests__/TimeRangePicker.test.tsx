/**
 * TimeRangePicker — spec (Dash-B). Pins the load-bearing behavior:
 *   - the in-house ES date-math parser resolves relative ranges (now/now-Nu/rounding);
 *   - a range round-trips through the URL query codec (serialize → parse);
 *   - the component renders the current label and offers the auto-refresh options;
 *   - useAutoRefresh honours `off` and pauses on a hidden tab.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, renderHook, within } from '@testing-library/react';

import {
  TimeRangePicker,
  parseDateMath,
  resolveRange,
  serializeRange,
  parseRange,
  labelForRange,
  useAutoRefresh,
  PRESETS,
  DEFAULT_RANGE,
  REFRESH_OPTIONS,
  REFRESH_MS,
  type TimeRange,
} from '../TimeRangePicker';

// A fixed "now" so the date-math assertions are deterministic:
// 2026-07-01T12:00:00.000Z
const NOW = Date.UTC(2026, 6, 1, 12, 0, 0, 0);
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('parseDateMath (ES date-math subset)', () => {
  it('resolves the `now` anchor', () => {
    expect(parseDateMath('now', NOW)).toBe(NOW);
  });

  it('resolves relative minus offsets across units', () => {
    expect(parseDateMath('now-15m', NOW)).toBe(NOW - 15 * 60_000);
    expect(parseDateMath('now-1h', NOW)).toBe(NOW - HOUR);
    expect(parseDateMath('now-24h', NOW)).toBe(NOW - 24 * HOUR);
    expect(parseDateMath('now-7d', NOW)).toBe(NOW - 7 * DAY);
    expect(parseDateMath('now-1w', NOW)).toBe(NOW - 7 * DAY);
  });

  it('resolves a plus offset', () => {
    expect(parseDateMath('now+30m', NOW)).toBe(NOW + 30 * 60_000);
  });

  it('applies a trailing rounding op', () => {
    // now-1d rounded to the start of the day (local): should be <= now-1d and a day boundary.
    const start = parseDateMath('now/d', NOW)!;
    const d = new Date(start);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(start).toBeLessThanOrEqual(NOW);
  });

  it('parses an epoch-ms and an ISO absolute anchor', () => {
    expect(parseDateMath(String(NOW), NOW)).toBe(NOW);
    expect(parseDateMath('2026-07-01T12:00:00.000Z', NOW)).toBe(NOW);
  });

  it('returns null on garbage', () => {
    expect(parseDateMath('', NOW)).toBeNull();
    expect(parseDateMath('nowish', NOW)).toBeNull();
    expect(parseDateMath('now-5x', NOW)).toBeNull();
    expect(parseDateMath('not a date', NOW)).toBeNull();
  });
});

describe('resolveRange', () => {
  it('resolves both bounds of a preset', () => {
    const { fromMs, toMs } = resolveRange({ from: 'now-24h', to: 'now', label: 'x' }, NOW);
    expect(fromMs).toBe(NOW - 24 * HOUR);
    expect(toMs).toBe(NOW);
  });

  it('never yields NaN for an unparseable side (falls back)', () => {
    const { fromMs, toMs } = resolveRange({ from: 'garbage', to: 'alsogarbage', label: 'x' }, NOW);
    expect(Number.isNaN(fromMs)).toBe(false);
    expect(Number.isNaN(toMs)).toBe(false);
  });
});

describe('URL codec (serialize/parse round-trip)', () => {
  it('round-trips every preset through query params', () => {
    for (const p of PRESETS) {
      const params = serializeRange(p);
      const back = parseRange(params);
      expect(back.from).toBe(p.from);
      expect(back.to).toBe(p.to);
      expect(back.label).toBe(p.label);
    }
  });

  it('serializes into a provided URLSearchParams without clobbering siblings', () => {
    const params = new URLSearchParams('s=overview');
    serializeRange({ from: 'now-1h', to: 'now', label: 'Last 1 hour' }, params);
    expect(params.get('s')).toBe('overview');
    expect(params.get('from')).toBe('now-1h');
    expect(params.get('to')).toBe('now');
  });

  it('parses from a raw query string (leading ? tolerated)', () => {
    const r = parseRange('?from=now-7d&to=now');
    expect(r.from).toBe('now-7d');
    expect(r.to).toBe('now');
    expect(r.label).toBe('Last 7 days');
  });

  it('falls back to DEFAULT_RANGE when a bound is missing', () => {
    expect(parseRange('from=now-1h')).toEqual(DEFAULT_RANGE);
    expect(parseRange('')).toEqual(DEFAULT_RANGE);
  });

  it('labels a non-preset (custom) range distinctly', () => {
    expect(labelForRange('now-3h', 'now')).toContain('now-3h');
  });
});

describe('useAutoRefresh', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never fires when off', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    renderHook(() => useAutoRefresh('off', tick));
    vi.advanceTimersByTime(REFRESH_MS['5m'] * 2);
    expect(tick).not.toHaveBeenCalled();
  });

  it('fires on the chosen cadence when visible', () => {
    vi.useFakeTimers();
    // visible tab
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const tick = vi.fn();
    renderHook(() => useAutoRefresh('30s', tick));
    vi.advanceTimersByTime(REFRESH_MS['30s']);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REFRESH_MS['30s']);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('does not start when the tab is hidden', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const tick = vi.fn();
    renderHook(() => useAutoRefresh('30s', tick));
    vi.advanceTimersByTime(REFRESH_MS['30s'] * 3);
    expect(tick).not.toHaveBeenCalled();
  });
});

describe('<TimeRangePicker/> render', () => {
  it('shows the current range label on the trigger', () => {
    const range: TimeRange = PRESETS[2]; // Last 24 hours
    render(<TimeRangePicker value={range} onChange={() => {}} />);
    expect(
      screen.getByRole('button', { name: /Time range: Last 24 hours/i }),
    ).toBeInTheDocument();
  });

  it('emits the picked preset from the popover', () => {
    const onChange = vi.fn();
    render(<TimeRangePicker value={PRESETS[2]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Time range:/i }));
    // Presets render as a labelled GROUP of plain buttons (NOT a listbox/option
    // composite — see the a11y fix), with the active range marked via aria-current.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    const group = screen.getByRole('group', { name: /Relative time ranges/i });
    expect(within(group).getByRole('button', { name: /Last 24 hours/i })).toHaveAttribute(
      'aria-current',
      'true',
    );
    const opt = within(group).getByRole('button', { name: /Last 7 days/i });
    fireEvent.click(opt);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({ from: 'now-7d', to: 'now' });
  });

  it('exposes the auto-refresh selector with an accessible name when wired', () => {
    render(
      <TimeRangePicker
        value={PRESETS[2]}
        onChange={() => {}}
        refresh="off"
        onRefreshChange={() => {}}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Auto-refresh interval: Off' });
    expect(trigger).toBeInTheDocument();
    // Narrow viewports get the compact icon-pair control; the full cadence label
    // returns at `sm` without changing the accessible name.
    expect(trigger).toHaveClass('w-14', 'sm:w-36');
    // default option set exists
    expect(REFRESH_OPTIONS.map((o) => o.value)).toContain('off');
  });
});
