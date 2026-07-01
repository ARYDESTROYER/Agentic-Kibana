/**
 * Campaigns — the cross-case CAMPAIGN surface (Round 4 / Wave 4).
 *
 * READ-ONLY views over the running campaign list the deterministic clustering pass
 * (`backend/app/engine/campaigns.py`) produces: a list of campaigns (member count,
 * shared entities, MITRE union, severity rollup, first/last seen), a detail slide-over
 * with the member cases + shared entities + MITRE, and a manual "Recorrelate" action
 * (admin) that re-runs the deterministic pass on demand.
 *
 * RBAC: the whole page is gated behind <ProtectedRoute resource="cases" action="read">.
 * "Recorrelate" is wrapped in <Can resource="cases" action="read"> AND requires admin
 * server-side; the server is authoritative (a 403 surfaces as a toast).
 *
 * ⛔ ADVISORY ONLY (#3/#4): a campaign is a reporting grouping. It NEVER force-merges
 * cases, recomputes a `cluster_signature`, or feeds the deterministic `decide()`. A
 * NEEDS_HUMAN case that joins a campaign stays NEEDS_HUMAN.
 *
 * SECURITY (#9): every campaign name / entity `value` / MITRE id is source-derived
 * PLAIN data, rendered as plain text / <InlineCode> — never HTML, never into a prompt.
 *
 * Also exports <CampaignChip> — a small "part of campaign X" chip CaseDetail mounts to
 * link a case to its campaign.
 */
import * as React from 'react';
import {
  Network,
  RefreshCw,
  Loader2,
  ArrowRight,
  Layers,
  ShieldAlert,
} from 'lucide-react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api';
import { humanizeToken, humanizeAge, fmtNumber } from '@/lib/format';
import type { Navigate } from '@/soc/router';

import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Separator } from '@/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/ui/sheet';

import { PageHeader } from '@/soc/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { EmptyState } from '@/soc/components/EmptyState';
import { InlineCode } from '@/soc/components/CodeBlock';
import { SeverityBadge } from '@/soc/components/badges';
import { ProtectedRoute, Can } from '@/soc/components/Can';
import {
  campaignsApi,
  CAMPAIGN_STATUS_LABELS,
  type Campaign,
} from './Campaigns.api';

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

/** Map a campaign status to a Badge variant. */
function statusVariant(status: string): 'success' | 'info' | 'secondary' {
  if (status === 'open') return 'success';
  if (status === 'monitoring') return 'info';
  return 'secondary';
}

export interface CampaignsProps {
  onNavigate?: Navigate;
}

export default function Campaigns({ onNavigate }: CampaignsProps) {
  return (
    <ProtectedRoute resource="cases" action="read">
      <CampaignsInner onNavigate={onNavigate} />
    </ProtectedRoute>
  );
}

export function CampaignsInner({ onNavigate }: CampaignsProps) {
  const [campaigns, setCampaigns] = React.useState<Campaign[]>([]);
  const [enabled, setEnabled] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [recorrelating, setRecorrelating] = React.useState(false);
  const [detail, setDetail] = React.useState<Campaign | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await campaignsApi.list();
      setCampaigns(res.campaigns ?? []);
      setEnabled(Boolean(res.enabled));
    } catch (e) {
      setError(errMsg(e, 'Could not load campaigns.'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const recorrelate = React.useCallback(async () => {
    setRecorrelating(true);
    try {
      const res = await campaignsApi.recorrelate();
      setCampaigns(res.campaigns ?? []);
      toast.success(
        `Re-correlated: ${fmtNumber(res.count)} campaign${res.count === 1 ? '' : 's'}.`,
      );
    } catch (e) {
      toast.error(errMsg(e, 'Could not re-correlate campaigns.'));
    } finally {
      setRecorrelating(false);
    }
  }, []);

  const columns = React.useMemo<DataTableColumn<Campaign>[]>(
    () => [
      {
        id: 'name',
        header: 'Campaign',
        lockVisible: true,
        cell: (c) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-foreground">{c.name || c.id}</span>
            <span className="text-xs text-muted-foreground">
              {humanizeToken(CAMPAIGN_STATUS_LABELS[c.status] ?? c.status)}
            </span>
          </div>
        ),
      },
      {
        id: 'cases',
        header: 'Cases',
        align: 'right',
        cell: (c) => <span className="tabular-nums">{fmtNumber(c.case_count)}</span>,
      },
      {
        id: 'severity',
        header: 'Severity',
        cell: (c) =>
          c.severity_rollup ? (
            <SeverityBadge severity={c.severity_rollup} />
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        id: 'entities',
        header: 'Shared entities',
        cell: (c) => (
          <div className="flex flex-wrap gap-1">
            {c.entities.slice(0, 3).map((e, i) => (
              <InlineCode key={`${e.entity_type}:${e.value}:${i}`}>{e.value}</InlineCode>
            ))}
            {c.entities.length > 3 ? (
              <span className="text-xs text-muted-foreground">
                +{c.entities.length - 3}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'mitre',
        header: 'MITRE',
        cell: (c) => (
          <div className="flex flex-wrap gap-1">
            {c.mitre.slice(0, 4).map((m) => (
              <Badge key={m} variant="outline">
                {m}
              </Badge>
            ))}
            {c.mitre.length > 4 ? (
              <span className="text-xs text-muted-foreground">+{c.mitre.length - 4}</span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'last_seen',
        header: 'Last seen',
        align: 'right',
        cell: (c) => (
          <span className="text-xs text-muted-foreground">
            {humanizeAge(c.last_seen)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Network}
        eyebrow="Triage"
        title="Campaigns"
        description="Related cases grouped by shared entities and overlapping MITRE techniques."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw
                className={loading ? 'mr-1.5 h-4 w-4 animate-spin' : 'mr-1.5 h-4 w-4'}
                aria-hidden
              />
              Refresh
            </Button>
            <Can resource="cases" action="read">
              <Button size="sm" onClick={() => void recorrelate()} disabled={recorrelating}>
                {recorrelating ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Layers className="mr-1.5 h-4 w-4" aria-hidden />
                )}
                Recorrelate
              </Button>
            </Can>
          </div>
        }
      />

      {!enabled ? (
        <Alert>
          <Network className="h-4 w-4" aria-hidden />
          <AlertTitle>Campaign clustering is off.</AlertTitle>
          <AlertDescription>
            Enable it in Settings to run the pass on a cadence, or use Recorrelate to
            build campaigns on demand. Campaigns are advisory — they group related cases
            for context and never change how a case is decided.
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <EmptyState
          variant="error"
          icon={ShieldAlert}
          title="Could not load campaigns"
          description={error}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={campaigns}
          getRowId={(c) => c.id}
          loading={loading}
          onRowClick={(c) => setDetail(c)}
          ariaLabel="Campaigns"
          empty={
            <EmptyState
              icon={Network}
              title="No campaigns yet"
              description="When related cases share an entity or MITRE technique, they are grouped into a campaign here. Use Recorrelate to build them from the current cases."
            />
          }
        />
      )}

      <CampaignDetailSheet
        campaign={detail}
        onClose={() => setDetail(null)}
        onNavigate={onNavigate}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Detail slide-over                                                          */
/* ------------------------------------------------------------------------- */

function CampaignDetailSheet({
  campaign,
  onClose,
  onNavigate,
}: {
  campaign: Campaign | null;
  onClose: () => void;
  onNavigate?: Navigate;
}) {
  return (
    <Sheet open={Boolean(campaign)} onOpenChange={(o) => (o ? undefined : onClose())}>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        {campaign ? (
          <div className="flex h-full flex-col">
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <Network className="h-5 w-5 text-primary" aria-hidden />
                {campaign.name || campaign.id}
              </SheetTitle>
              <SheetDescription>
                {fmtNumber(campaign.case_count)} case
                {campaign.case_count === 1 ? '' : 's'} ·{' '}
                {humanizeToken(CAMPAIGN_STATUS_LABELS[campaign.status] ?? campaign.status)}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Badge variant={statusVariant(campaign.status)}>
                {humanizeToken(CAMPAIGN_STATUS_LABELS[campaign.status] ?? campaign.status)}
              </Badge>
              {campaign.severity_rollup ? (
                <SeverityBadge severity={campaign.severity_rollup} />
              ) : null}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-muted-foreground">
              <div>
                <div className="font-medium text-foreground">First seen</div>
                {humanizeAge(campaign.first_seen)}
              </div>
              <div>
                <div className="font-medium text-foreground">Last seen</div>
                {humanizeAge(campaign.last_seen)}
              </div>
            </div>

            <Separator className="my-4" />

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
              {/* Shared entities */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Shared entities</h3>
                {campaign.entities.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {campaign.entities.map((e, i) => (
                      <span
                        key={`${e.entity_type}:${e.value}:${i}`}
                        className="inline-flex items-center gap-1"
                      >
                        <span className="text-xs text-muted-foreground">
                          {humanizeToken(e.entity_type)}:
                        </span>
                        <InlineCode>{e.value}</InlineCode>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">None.</p>
                )}
              </section>

              {/* MITRE */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">MITRE techniques</h3>
                {campaign.mitre.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {campaign.mitre.map((m) => (
                      <Badge key={m} variant="outline">
                        {m}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">None.</p>
                )}
              </section>

              {/* Member cases */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Member cases</h3>
                {campaign.case_ids.length ? (
                  <ul className="space-y-1.5">
                    {campaign.case_ids.map((cid) => (
                      <li
                        key={cid}
                        className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2"
                      >
                        <InlineCode>{cid}</InlineCode>
                        {onNavigate ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onNavigate('cases', { caseId: cid })}
                          >
                            Open
                            <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden />
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">None.</p>
                )}
              </section>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------------------------------------------------- */
/* CampaignChip — a small "part of campaign X" chip for CaseDetail             */
/* ------------------------------------------------------------------------- */

export interface CampaignChipProps {
  /** The campaign this case belongs to (from GET /api/cases/{id}/campaign). */
  campaign: Pick<Campaign, 'id' | 'name' | 'case_count'>;
  /** Navigate to the Campaigns surface when clicked. */
  onOpen?: () => void;
  className?: string;
}

/**
 * A compact "part of campaign X" chip CaseDetail mounts when a case belongs to a
 * campaign. Plain text (#9); clicking calls `onOpen` (the host routes to Campaigns).
 */
export function CampaignChip({ campaign, onOpen, className }: CampaignChipProps) {
  const label = campaign.name || campaign.id;
  const body = (
    <>
      <Network className="h-3 w-3" aria-hidden />
      <span className="truncate">Part of campaign: {label}</span>
      {campaign.case_count ? (
        <span className="text-muted-foreground">({campaign.case_count})</span>
      ) : null}
    </>
  );
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={className}
        aria-label={`Part of campaign ${label}`}
      >
        <Badge variant="info" className="max-w-full cursor-pointer gap-1">
          {body}
        </Badge>
      </button>
    );
  }
  return (
    <Badge variant="info" className={className ? `max-w-full gap-1 ${className}` : 'max-w-full gap-1'}>
      {body}
    </Badge>
  );
}
