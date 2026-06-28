/**
 * ConnectorPicker — choose a connector from the catalog, grouped by category
 * (SIEM / EDR-XDR / transports / queues / object-store / file). Used by the new
 * SourceEditor's "Add source" flow.
 *
 * All connector text (display_name / description / source_type / ingest modes) is
 * fixed catalog copy from the backend manifest, but we still render it as plain
 * text — never as markup.
 */
import * as React from 'react';
import {
  Search,
  CheckCircle2,
  Database,
  ShieldAlert,
  Network,
  Workflow,
  HardDrive,
  FileText,
  Package,
  type LucideIcon,
} from 'lucide-react';
import type { ConnectorManifest, ConnectorCategory } from '@/lib/types';
import { cn } from '@/lib/cn';

import { Card } from '@/ui/card';
import { Input } from '@/ui/input';
import { Badge } from '@/ui/badge';
import { EmptyState } from '@/soc/components/EmptyState';

/** Stable category display order. */
const CATEGORY_ORDER = ['siem', 'edr_xdr', 'transport', 'queue', 'object_store', 'file'];

interface CategoryMeta {
  label: string;
  icon: LucideIcon;
  /** Token text-color class for the category icon. */
  tone: string;
}

const CATEGORY_META: Record<string, CategoryMeta> = {
  siem: { label: 'SIEM / Log stores', icon: Database, tone: 'text-primary' },
  edr_xdr: { label: 'EDR / XDR', icon: ShieldAlert, tone: 'text-critical' },
  transport: { label: 'Transports / Receivers', icon: Network, tone: 'text-info' },
  queue: { label: 'Queues / Brokers', icon: Workflow, tone: 'text-warning' },
  object_store: { label: 'Object stores', icon: HardDrive, tone: 'text-success' },
  file: { label: 'Files', icon: FileText, tone: 'text-muted-foreground' },
};

export function categoryMeta(category?: ConnectorCategory): CategoryMeta {
  return (
    CATEGORY_META[String(category || '')] || {
      label: category ? String(category) : 'Other',
      icon: Package,
      tone: 'text-muted-foreground',
    }
  );
}

export interface ConnectorPickerProps {
  connectors: ConnectorManifest[];
  selected?: string;
  onSelect: (manifest: ConnectorManifest) => void;
}

export const ConnectorPicker: React.FC<ConnectorPickerProps> = ({
  connectors,
  selected,
  onSelect,
}) => {
  const [query, setQuery] = React.useState('');

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return connectors;
    return connectors.filter((c) =>
      `${c.display_name} ${c.source_type} ${c.description || ''}`.toLowerCase().includes(q),
    );
  }, [connectors, query]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, ConnectorManifest[]>();
    for (const c of filtered) {
      const cat = String(c.category || 'other');
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(c);
    }
    const cats = Array.from(map.keys()).sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a);
      const ib = CATEGORY_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return cats.map((cat) => ({
      cat,
      meta: categoryMeta(cat),
      items: map
        .get(cat)!
        .slice()
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
    }));
  }, [filtered]);

  return (
    <div>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          className="pl-9"
          placeholder="Search connectors…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search connectors"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          {filtered.length} of {connectors.length}
        </span>
      </div>

      {grouped.length === 0 ? (
        <EmptyState
          icon={Search}
          compact
          title="No matching connectors"
          description="No connector matches your search. Try a different term or clear the search."
          className="mt-4"
        />
      ) : null}

      <div className="mt-4 space-y-6">
        {grouped.map(({ cat, meta, items }) => (
          <div key={cat}>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {meta.label}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((c) => {
                const isSel = selected === c.source_type;
                const Icon = meta.icon;
                return (
                  <Card
                    key={c.source_type}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSel}
                    aria-label={`Select ${c.display_name}`}
                    onClick={() => onSelect(c)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(c);
                      }
                    }}
                    className={cn(
                      'cursor-pointer p-4 transition-colors outline-none',
                      'hover:border-primary/50 hover:bg-accent/40',
                      'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                      isSel && 'border-primary ring-1 ring-primary',
                    )}
                  >
                    <div className="flex items-start justify-between">
                      <span
                        className={cn(
                          'inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card',
                          meta.tone,
                        )}
                      >
                        <Icon className="h-5 w-5" aria-hidden />
                      </span>
                      {isSel ? (
                        <CheckCircle2 className="h-5 w-5 text-primary" aria-hidden />
                      ) : null}
                    </div>
                    <div className="mt-3 truncate font-semibold text-foreground" title={c.display_name}>
                      {c.display_name}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {c.description || c.source_type}
                    </p>
                    {(c.ingest_modes || []).length ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {(c.ingest_modes || []).slice(0, 3).map((m) => (
                          <Badge key={m} variant="outline" className="text-[0.7rem]">
                            {m}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </Card>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ConnectorPicker;
