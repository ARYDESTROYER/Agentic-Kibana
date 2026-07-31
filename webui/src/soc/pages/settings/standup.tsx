/**
 * Standup settings section (Round-5 Sett-A decomposition).
 *
 * Lifted verbatim from the former `Settings.tsx` `StandupSection`. The daily
 * aggregate-summary window and cadence.
 */

import { NumPref, SectionTitle, SwitchPref, type SecProps } from './primitives';

export function StandupSection({ prefs, update }: SecProps) {
  const s = prefs.standup || {};
  const set = (patch: Partial<typeof s>) => update({ standup: { ...s, ...patch } });
  return (
    <div className="space-y-6">
      <SectionTitle
        title="Standup"
        sub="Control the rolling window and refresh cadence used for the aggregate shift summary."
      />
      <SwitchPref
        label="Standup enabled"
        help="Build the deterministic, aggregate-only shift summary on the configured cadence."
        checked={s.enabled ?? true}
        onChange={(v) => set({ enabled: v })}
      />
      <div className="grid gap-4 border-t border-border/70 pt-4 sm:grid-cols-2">
        <NumPref label="Window (hours)" value={s.window_hours} onChange={(v) => set({ window_hours: v })} />
        <NumPref label="Interval (seconds)" value={s.interval_seconds} onChange={(v) => set({ interval_seconds: v })} />
      </div>
    </div>
  );
}
