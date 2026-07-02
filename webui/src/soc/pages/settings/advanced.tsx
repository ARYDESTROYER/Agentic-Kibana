/**
 * Advanced settings section (Round-5 Sett-A decomposition).
 *
 * Lifted verbatim from the former `Settings.tsx` `AdvancedSection`. Power-user
 * controls: per-case caps, the kill switch, the auto-forward allowlist, suppression-
 * rule retrieval, the rule catalog deep-link, and the console settings lock.
 *
 * Operator-entered rule values render as PLAIN TEXT (#9).
 */
import * as React from 'react';
import { FileText, Lock, Repeat, ShieldAlert, SlidersHorizontal, X, Zap } from 'lucide-react';

import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Badge } from '@/ui/badge';
import { SettingsGrid, SettingsCard, type SettingsTOCItem } from '@/soc/components/SettingsGrid';

import { SectionShell, NumPref, SwitchPref, type NavigateFn, type SecProps } from './primitives';

const ADVANCED_TOC: SettingsTOCItem[] = [
  { anchor: 'advanced-caps', label: 'Per-case caps', icon: SlidersHorizontal },
  { anchor: 'advanced-killswitch', label: 'Kill switch', icon: ShieldAlert },
  { anchor: 'advanced-scans', label: 'Automated scans', icon: Repeat },
  { anchor: 'advanced-allowlist', label: 'Allowlist', icon: Zap },
  { anchor: 'advanced-suppression', label: 'Suppression', icon: FileText },
  { anchor: 'advanced-lock', label: 'Settings lock', icon: Lock },
];

export function AdvancedSection({
  prefs,
  update,
  onNavigate,
}: SecProps & { onNavigate?: NavigateFn }) {
  const caps = prefs.caps || {};
  const setCaps = (patch: Partial<typeof caps>) => update({ caps: { ...caps, ...patch } });
  const rag = prefs.rag || {};
  const setRag = (patch: Partial<typeof rag>) => update({ rag: { ...rag, ...patch } });
  const [tagInput, setTagInput] = React.useState('');
  const allowlist = prefs.auto_forward_allowlist || [];
  const addTag = () => {
    const v = tagInput.trim();
    if (!v || allowlist.includes(v)) {
      setTagInput('');
      return;
    }
    update({ auto_forward_allowlist: [...allowlist, v] });
    setTagInput('');
  };
  return (
    <SectionShell
      title="Advanced"
      sub="Power-user controls: per-case caps, the kill switch, the auto-forward allowlist, suppression-rule retrieval, the rule catalog, and the settings lock."
      toc={ADVANCED_TOC}
    >
      <SettingsGrid>
        <SettingsCard
          anchor="advanced-caps"
          title="Per-case caps"
          icon={SlidersHorizontal}
          description="Hard limits per investigation. A case that hits a cap is routed to NEEDS_HUMAN rather than running unbounded."
          wide
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <NumPref label="Max tool calls / case" value={caps.max_tool_calls} onChange={(v) => setCaps({ max_tool_calls: v })} />
            <NumPref label="Max tokens / case" value={caps.max_tokens} onChange={(v) => setCaps({ max_tokens: v })} />
            <NumPref label="Timeout (seconds)" value={caps.timeout_seconds} onChange={(v) => setCaps({ timeout_seconds: v })} />
          </div>
        </SettingsCard>

        <SettingsCard
          anchor="advanced-killswitch"
          title="Kill switch"
          icon={ShieldAlert}
          description="An emergency stop. When on, the agent immediately halts ALL automated investigation; manual investigation still works."
        >
          <div
            className={cn(
              'rounded-md border px-4 py-3 transition-colors',
              caps.kill_switch ? 'border-critical/50 bg-critical/10' : 'border-border bg-surface',
            )}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className={cn('text-sm font-medium', caps.kill_switch ? 'text-critical' : 'text-foreground')}>
                  Kill switch (stop all investigations)
                </p>
                <p className="text-xs text-muted-foreground">
                  When on, the agent halts all automated investigation immediately.
                </p>
              </div>
              <Switch
                checked={Boolean(caps.kill_switch)}
                onCheckedChange={(v) => setCaps({ kill_switch: v })}
                aria-label="Kill switch"
              />
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          anchor="advanced-scans"
          title="Automated scans"
          icon={Repeat}
          description="Scheduled background scans that triage new cases automatically, separate from the auto-forward allowlist below."
        >
          <SwitchPref
            label="Background automated scans"
            help="Run scheduled background scans that triage new cases automatically."
            checked={Boolean(prefs.background_scan_enabled)}
            onChange={(v) => update({ background_scan_enabled: v })}
          />
        </SettingsCard>

        <SettingsCard
          anchor="advanced-allowlist"
          title="Auto-forward allowlist"
          icon={Zap}
          description="Rule values whose alerts auto-forward straight to investigation (bypassing the cheap router). Operator-entered values render as plain text."
          wide="full"
        >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="allowlist-input">Allowlisted rule values</Label>
              <Input
                id="allowlist-input"
                placeholder="Type a rule value and press Enter"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag();
                  }
                }}
              />
              {allowlist.length ? (
                <div className="flex flex-wrap gap-1.5 pt-1.5">
                  {allowlist.map((r) => (
                    <Badge key={r} variant="outline" className="gap-1 pr-1">
                      {/* UNTRUSTED-ish rule value — plain text only */}
                      <span className="truncate">{r}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${r}`}
                        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() =>
                          update({ auto_forward_allowlist: allowlist.filter((x) => x !== r) })
                        }
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          anchor="advanced-suppression"
          title="Suppression & rule catalog"
          icon={FileText}
          description="Inject approved suppression rules as TRUSTED retrieval context, and review/manage the detection rule catalog on the Playbooks & agents page."
          wide
        >
          <div className="space-y-4">
            <SwitchPref
              label="Inject suppression rules"
              help="Retrieve approved suppression rules (source: suppression) and inject them into investigations as a TRUSTED fenced block. Suppression rules only go live via the approval queue — never automatically."
              checked={rag.use_suppression_rules ?? true}
              onChange={(v) => setRag({ use_suppression_rules: v })}
            />
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3">
              <span className="text-sm text-muted-foreground">Detection rule catalog &amp; playbooks</span>
              {onNavigate ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate('intelligence', { tab: 'catalog' })}
                >
                  <FileText className="h-4 w-4" aria-hidden />
                  Open catalog
                </Button>
              ) : null}
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          anchor="advanced-lock"
          title="Settings lock"
          icon={Lock}
          description="When on, the console marks settings read-only. A safety guard against accidental edits in shared/production deployments. (Server-side read-only mode still wins.)"
        >
          <SwitchPref
            label="Read-only settings mode"
            help="Surface settings as read-only in the console. Save is disabled while this is on."
            checked={Boolean(prefs.read_only_settings_mode)}
            onChange={(v) => update({ read_only_settings_mode: v })}
          />
        </SettingsCard>
      </SettingsGrid>
    </SectionShell>
  );
}
