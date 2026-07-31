/** Read-only upstream source discovery and its operator-configurable GitHub refs. */
import * as React from 'react';
import {
  ExternalLink,
  GitBranch,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type {
  Preferences,
  ReleaseUpdateConfig,
  UpstreamReleaseCandidate,
  UpstreamReleasesResponse,
} from '@/lib/types';
import { cn } from '@/lib/cn';
import { LoadingState } from '@/design-system';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { SettingsCard, SettingsGrid, type SettingsTOCItem } from '@/soc/components/SettingsGrid';

import { NumPref, SectionShell, SwitchPref, TextPref, errMsg } from './primitives';

const DEFAULT_RELEASE_UPDATES: ReleaseUpdateConfig = {
  enabled: true,
  repository_url: 'https://github.com/ARYDESTROYER/Agentic-Kibana',
  stable_branch: 'main',
  testing_branch: 'Testing',
  check_interval_minutes: 360,
};

const RELEASE_TOC: SettingsTOCItem[] = [
  { anchor: 'release-source', label: 'Source & channels', icon: GitBranch },
  { anchor: 'release-observed', label: 'Observed revisions', icon: RefreshCw },
];

function normalizedConfig(value?: Partial<ReleaseUpdateConfig> | null): ReleaseUpdateConfig {
  return { ...DEFAULT_RELEASE_UPDATES, ...(value ?? {}) };
}

function sameConfig(left: ReleaseUpdateConfig, right: ReleaseUpdateConfig): boolean {
  return (
    left.enabled === right.enabled &&
    left.repository_url === right.repository_url &&
    left.stable_branch === right.stable_branch &&
    left.testing_branch === right.testing_branch &&
    left.check_interval_minutes === right.check_interval_minutes
  );
}

function checkedLabel(value: string | null): string {
  if (!value) return 'Not checked yet';
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return timestamp.toLocaleString();
}

function ChannelObservation({ candidate }: { candidate: UpstreamReleaseCandidate }) {
  const available = candidate.state === 'available';
  const disabled = candidate.state === 'disabled';
  return (
    <section className="border-t border-border/70 py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">
              {candidate.channel === 'stable' ? 'Stable' : 'Testing'}
            </h4>
            <Badge
              variant={available && !candidate.stale ? 'success' : disabled ? 'outline' : 'warning'}
            >
              {candidate.stale
                ? 'Last verified'
                : available
                  ? 'Observed'
                  : disabled
                    ? 'Disabled'
                    : 'Unavailable'}
            </Badge>
          </div>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {candidate.branch}
          </p>
        </div>
        {candidate.source_url || candidate.commit_url ? (
          <div className="flex flex-wrap items-center justify-end gap-1">
            {candidate.source_url ? (
              <Button asChild variant="ghost" size="sm">
                <a href={candidate.source_url} target="_blank" rel="noreferrer">
                  Open branch
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </Button>
            ) : null}
            {candidate.commit_url ? (
              <Button asChild variant="ghost" size="sm">
                <a href={candidate.commit_url} target="_blank" rel="noreferrer">
                  Review commit
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {available ? (
        <>
          {candidate.stale && candidate.error_message ? (
            <p className="mt-3 text-xs leading-relaxed text-warning-text">
              {candidate.error_message}
            </p>
          ) : null}
          <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Version</dt>
              <dd className="mt-0.5 font-mono font-medium text-foreground">
                {candidate.version ?? 'Unknown'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Commit</dt>
              <dd className="mt-0.5 font-mono font-medium text-foreground">
                {candidate.commit_sha?.slice(0, 12) ?? 'Unknown'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Checked</dt>
              <dd className="mt-0.5 text-foreground">{checkedLabel(candidate.checked_at)}</dd>
            </div>
          </dl>
        </>
      ) : candidate.error_message ? (
        <p className="mt-3 text-xs leading-relaxed text-warning-text">
          {candidate.error_message}
        </p>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          Source discovery is disabled. The running application continues unchanged.
        </p>
      )}
    </section>
  );
}

export interface ReleaseUpdatesSectionProps {
  prefs: Preferences;
  persistedPrefs: Preferences;
  update: (patch: Partial<Preferences>) => void;
  readOnly?: boolean;
}

export function ReleaseUpdatesSection({
  prefs,
  persistedPrefs,
  update,
  readOnly = false,
}: ReleaseUpdatesSectionProps) {
  const draft = normalizedConfig(prefs.release_updates);
  const persisted = normalizedConfig(persistedPrefs.release_updates);
  const draftDiffers = !sameConfig(draft, persisted);
  const persistedKey = JSON.stringify(persisted);
  const [status, setStatus] = React.useState<UpstreamReleasesResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const loadSequenceRef = React.useRef(0);

  const load = React.useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.upstreamReleases({ cache: 'no-store' });
      if (sequence === loadSequenceRef.current) setStatus(next);
    } catch (cause) {
      if (sequence === loadSequenceRef.current) {
        setError(errMsg(cause, 'Could not load upstream release status.'));
      }
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    return () => {
      // Ignore an observation started for the previous saved source or an
      // unmounted Settings page if it resolves after its replacement.
      loadSequenceRef.current += 1;
    };
  }, [load, persistedKey]);

  const change = (patch: Partial<ReleaseUpdateConfig>) => {
    update({ release_updates: { ...draft, ...patch } });
  };

  const checkNow = async () => {
    if (draftDiffers || checking) return;
    setChecking(true);
    setError(null);
    try {
      const next = await api.checkUpstreamReleases();
      setStatus(next);
      toast.success('Upstream branches checked.');
    } catch (cause) {
      const message = errMsg(cause, 'Could not check upstream branches.');
      setError(message);
      toast.error(message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <SectionShell
      title="Updates & release channels"
      sub="Observe the public Stable and Testing source branches without giving the Console deployment authority."
      toc={RELEASE_TOC}
    >
      <SettingsGrid>
        <SettingsCard
          anchor="release-source"
          title="Source & channels"
          icon={GitBranch}
          description="The backend checks one canonical public GitHub repository. Repository and branch values are validated before they can be saved."
          wide="full"
        >
          <SwitchPref
            label="Check for source updates"
            help="Enabled by default. Checks are cached and never clone, pull, execute, deploy, restart, or migrate anything."
            checked={draft.enabled}
            disabled={readOnly}
            onChange={(enabled) => change({ enabled })}
          />
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <TextPref
              label="Public repository"
              help="Canonical https://github.com/owner/repository URL. Private hosts and arbitrary URLs are rejected."
              value={draft.repository_url}
              disabled={readOnly || !draft.enabled}
              onChange={(repository_url) => change({ repository_url })}
              className="lg:col-span-2"
            />
            <TextPref
              label="Stable branch"
              help="The supported release branch, normally main."
              value={draft.stable_branch}
              disabled={readOnly || !draft.enabled}
              onChange={(stable_branch) => change({ stable_branch })}
            />
            <TextPref
              label="Testing branch"
              help="The integration and acceptance branch."
              value={draft.testing_branch}
              disabled={readOnly || !draft.enabled}
              onChange={(testing_branch) => change({ testing_branch })}
            />
            <NumPref
              label="Check interval (minutes)"
              help="Default 360 minutes. Cached checks keep public API use low."
              value={draft.check_interval_minutes}
              min={15}
              max={10_080}
              step={15}
              disabled={readOnly || !draft.enabled}
              onChange={(check_interval_minutes) => change({ check_interval_minutes })}
            />
          </div>
        </SettingsCard>

        <SettingsCard
          anchor="release-observed"
          title="Observed revisions"
          icon={RefreshCw}
          description="The latest readable VERSION and commit on each saved branch. A source revision is not an installed update."
          wide="full"
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={checking || loading || draftDiffers}
              onClick={() => void checkNow()}
            >
              <RefreshCw className={cn('h-4 w-4', checking && 'animate-spin')} aria-hidden />
              {checking ? 'Checking…' : 'Check now'}
            </Button>
          }
          footer={
            draftDiffers
              ? 'Save or discard the source changes before checking; discovery always uses the server-saved configuration.'
              : status
                ? `Automatic checks are cached for ${Math.round(status.cache.max_age_seconds / 60)} minutes.`
                : undefined
          }
        >
          {loading ? (
            <LoadingState
              label="Checking release source"
              description="Reading the backend's cached branch observations."
              layout="panel"
              shape="rows"
            />
          ) : error ? (
            <Alert variant="destructive">
              <AlertTitle>Release source unavailable</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{error}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : status ? (
            <div>
              <ChannelObservation candidate={status.channels.stable} />
              <ChannelObservation candidate={status.channels.testing} />
            </div>
          ) : null}
        </SettingsCard>
      </SettingsGrid>

      <Alert className="mt-8">
        <ShieldCheck className="h-4 w-4" aria-hidden />
        <AlertTitle>Discovery is not deployment</AlertTitle>
        <AlertDescription>
          Branch metadata can only announce that newer source exists. The top-bar Update
          action remains unavailable until a different same-origin Console manifest exactly
          matches a healthy backend build, and every activation still requires confirmation.
        </AlertDescription>
      </Alert>
    </SectionShell>
  );
}
