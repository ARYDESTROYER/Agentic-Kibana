/**
 * ModelsCatalog — the LLM model catalog table (Round 3 / Feature 9).
 *
 * Renders the GET /api/llm/models rows: provider, capability badges (context window,
 * max output, modalities, tool-json/cache support), pricing (input/output per million),
 * a provenance badge (exact/heuristic/free/default), the per-role assignment, and a
 * price-override marker. Per-row actions: open the price-override editor, and a metered
 * "test call".
 *
 * #9: every model id / label / capability / modality is operator-/registry-influenceable
 * and is rendered as PLAIN text or in a Badge (controlled label) — never HTML. The test
 * reply + any error are shown in a fenced CodeBlock by the parent page.
 */
import * as React from 'react';
import { Pencil, FlaskConical, Sparkles, Boxes } from 'lucide-react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { fmtMoney, fmtTokens, humanizeToken } from '@/lib/format';
import {
  PRICING_SOURCE_META,
  type ModelCatalogRow,
} from '@/soc/pages/Models.api';

export interface ModelsCatalogProps {
  rows: ModelCatalogRow[];
  loading?: boolean;
  /** Open the per-model price-override editor. */
  onEditPrice?: (row: ModelCatalogRow) => void;
  /** Run a metered test call against the model. */
  onTest?: (row: ModelCatalogRow) => void;
  /** The model id currently running a test (shows a spinner / disables the row). */
  testingId?: string | null;
  /** Optional provider filter — only rows whose provider matches are shown. */
  providerFilter?: string;
  /** Whether the current user may manage models (drives action availability). */
  canManage?: boolean;
}

/** Capability chips derived from a catalog row (controlled labels, never raw text). */
export function capabilityChips(row: ModelCatalogRow): { key: string; label: string }[] {
  const chips: { key: string; label: string }[] = [];
  if (row.context_window > 0) {
    chips.push({ key: 'ctx', label: `${fmtTokens(row.context_window)} ctx` });
  }
  if (row.max_output > 0) {
    chips.push({ key: 'out', label: `${fmtTokens(row.max_output)} out` });
  }
  for (const m of row.modalities) {
    chips.push({ key: `mod:${m}`, label: humanizeToken(m) });
  }
  // Surface the well-known capability flags as readable chips.
  const caps = new Set(row.capabilities.map((c) => c.toLowerCase()));
  if (caps.has('tools') || caps.has('tool_use') || caps.has('tool_json') || caps.has('function_calling')) {
    chips.push({ key: 'tools', label: 'Tool JSON' });
  }
  if (
    caps.has('cache') ||
    caps.has('prompt_caching') ||
    row.cache_read_per_million != null ||
    row.cache_write_per_million != null
  ) {
    chips.push({ key: 'cache', label: 'Cache' });
  }
  if (caps.has('vision')) chips.push({ key: 'vision', label: 'Vision' });
  if (caps.has('reasoning')) chips.push({ key: 'reasoning', label: 'Reasoning' });
  return chips;
}

function ProvenanceBadge({ source }: { source: string }) {
  const meta = PRICING_SOURCE_META[source] ?? PRICING_SOURCE_META.default;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Badge variant={meta.variant} className="cursor-default">
            {meta.label}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <span>Pricing provenance: {source}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function ModelsCatalog({
  rows,
  loading,
  onEditPrice,
  onTest,
  testingId,
  providerFilter,
  canManage = true,
}: ModelsCatalogProps) {
  const filtered = React.useMemo(
    () =>
      providerFilter && providerFilter !== 'all'
        ? rows.filter((r) => r.provider === providerFilter)
        : rows,
    [rows, providerFilter],
  );

  const columns: DataTableColumn<ModelCatalogRow>[] = [
    {
      id: 'model',
      header: 'Model',
      cell: (r) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-foreground">{r.label}</span>
          <span className="font-mono text-[0.7rem] text-muted-foreground">{r.id}</span>
        </div>
      ),
    },
    {
      id: 'provider',
      header: 'Provider',
      cell: (r) => (
        <Badge variant="outline" className="capitalize">
          {r.provider}
        </Badge>
      ),
    },
    {
      id: 'capabilities',
      header: 'Capabilities',
      cell: (r) => {
        const chips = capabilityChips(r);
        if (!chips.length) {
          return <span className="text-xs text-muted-foreground">—</span>;
        }
        return (
          <div className="flex flex-wrap gap-1">
            {chips.map((c) => (
              <Badge key={c.key} variant="secondary" className="text-[10px]">
                {c.label}
              </Badge>
            ))}
          </div>
        );
      },
    },
    {
      id: 'pricing',
      header: 'Price / 1M',
      align: 'right',
      cell: (r) => (
        <div className="flex flex-col items-end gap-0.5 tabular-nums">
          <span className="text-sm text-foreground">
            in {fmtMoney(r.input_per_million)} · out {fmtMoney(r.output_per_million)}
          </span>
          {r.cache_read_per_million != null ? (
            <span className="text-[0.7rem] text-muted-foreground">
              cache-read {fmtMoney(r.cache_read_per_million)}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'provenance',
      header: 'Source',
      align: 'center',
      cell: (r) => (
        <div className="flex items-center justify-center gap-1.5">
          <ProvenanceBadge source={String(r.pricing_source)} />
          {r.price_overridden ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Sparkles className="h-3.5 w-3.5 text-primary" aria-label="Operator price override" />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <span>Operator price override active</span>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      ),
    },
    {
      id: 'assigned',
      header: 'Assigned to',
      cell: (r) =>
        r.assigned_roles.length ? (
          <div className="flex flex-wrap gap-1">
            {r.assigned_roles.map((role) => (
              <Badge key={role} variant="info" className="text-[10px]">
                {humanizeToken(role)}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <div className="flex items-center justify-end gap-1">
          {onTest ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onTest(r)}
              disabled={!canManage || testingId === r.id}
              aria-label={`Test ${r.id}`}
              title="Metered test call"
            >
              <FlaskConical
                className={testingId === r.id ? 'h-4 w-4 animate-pulse' : 'h-4 w-4'}
                aria-hidden
              />
            </Button>
          ) : null}
          {onEditPrice ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onEditPrice(r)}
              disabled={!canManage}
              aria-label={`Override price for ${r.id}`}
              title="Override pricing"
            >
              <Pencil className="h-4 w-4" aria-hidden />
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <DataTable<ModelCatalogRow>
      columns={columns}
      rows={filtered}
      getRowId={(r) => r.id}
      loading={loading}
      ariaLabel="LLM model catalog"
      empty={
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Boxes className="h-8 w-8 opacity-40" aria-hidden />
          <span className="text-sm">No models in the catalog. Add an LLM key.</span>
        </div>
      }
    />
  );
}

export default ModelsCatalog;
