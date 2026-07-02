/**
 * Dashboards — the custom-dashboards page (Round 5 / G7). The operator's personal,
 * build-your-own landing surface. It ships ON by default with a read-only, per-role
 * DEFAULT layout; an explicit Edit mode (in `DashboardBuilder`) lets a user customize
 * it (clone-to-customize on first save).
 *
 * RESOLUTION (org ← user cascade, §4.3):
 *   effective dashboard = the user's SAVED copy (from `api.dashboards.list`) if present,
 *   else a code-defined per-role DEFAULT built from the widget registry
 *   (`buildDefaultWidgets`). The default is READ-ONLY in place — the first Save persists
 *   the customized copy into the user's bucket (a real dashboard id), so a default is
 *   never edited in place.
 *
 * BUNDLE: the drag/resize grid (`react-grid-layout`) is loaded ONLY when the user
 * enters Edit mode (the WidgetGrid lazy boundary). This page + view mode + first paint
 * ship ZERO grid JS (`bundle-first-paint` guardrail).
 *
 * NON-NEGOTIABLES: a dashboard is ADVISORY presentation only (#3 — never feeds
 * `decide()`); dashboard names + widget titles are UNTRUSTED and render as plain text
 * (#9); the read-only default is the calm default (#10). Layouts persist per-user via
 * the `DashboardStore` (KV, zero-migration).
 */
import * as React from 'react';
import { LayoutDashboard, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import type { DashboardLayout, DashboardWidget } from '@/lib/types';

import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { LoadError } from '@/soc/components/LoadError';
import { Can } from '@/soc/components/Can';
import { useAuth } from '@/soc/auth';
import { useAsync } from '@/soc/hooks/useAsync';

import { DashboardBuilder } from '@/soc/dashboard/DashboardBuilder';
import { buildDefaultWidgets, reconcileWidgets } from '@/soc/dashboard/registry';

/** The id of the primary, per-role default dashboard (never persisted until customized). */
const DEFAULT_DASHBOARD_ID = 'overview';

/** Build the code-defined per-role default dashboard (read-only until first Save). */
function buildRoleDefault(
  role: string | null | undefined,
  can: (r: string, a: string) => boolean,
): DashboardLayout {
  const widgets = buildDefaultWidgets(role, { can }) as DashboardWidget[];
  return {
    id: DEFAULT_DASHBOARD_ID,
    name: 'Overview',
    schema_version: 1,
    columns: 12,
    widgets,
  };
}

export function Dashboards() {
  const { role, hasPermission } = useAuth();

  const {
    data,
    loading,
    error,
    reload,
  } = useAsync<DashboardLayout[]>(async () => {
    const res = await api.dashboards.list();
    return res.dashboards ?? [];
  }, []);

  // Which dashboard is selected in the switcher. Starts on the default; a saved board
  // supersedes it once one exists.
  const [selectedId, setSelectedId] = React.useState<string>(DEFAULT_DASHBOARD_ID);

  // The role default (recomputed as RBAC resolves). Memo so its identity is stable for
  // the builder's dirty-draft seeding.
  const roleDefault = React.useMemo(
    () => buildRoleDefault(role, hasPermission),
    [role, hasPermission],
  );

  const saved = React.useMemo(() => data ?? [], [data]);

  // The list shown in the switcher: the user's saved boards + (if none is customized
  // yet) the read-only default. Reconcile each board's widgets on load (drop unknown
  // types, RBAC-filter) so a stale layout never renders a hole.
  const options = React.useMemo<DashboardLayout[]>(() => {
    const reconciled = saved.map((b) => ({
      ...b,
      widgets: reconcileWidgets(b.widgets as DashboardWidget[], { can: hasPermission }),
    }));
    // The default is offered when the user has not saved a board of that id.
    const hasDefaultSaved = reconciled.some((b) => b.id === DEFAULT_DASHBOARD_ID);
    return hasDefaultSaved ? reconciled : [roleDefault, ...reconciled];
  }, [saved, roleDefault, hasPermission]);

  // Resolve the active dashboard (selected id → default).
  const active = React.useMemo<DashboardLayout>(() => {
    return options.find((b) => b.id === selectedId) ?? options[0] ?? roleDefault;
  }, [options, selectedId, roleDefault]);

  // Keep the selection valid as data changes.
  React.useEffect(() => {
    if (!options.some((b) => b.id === selectedId) && options.length) {
      setSelectedId(options[0].id);
    }
  }, [options, selectedId]);

  const createBlank = React.useCallback(async () => {
    try {
      // Auto-number so repeated "New dashboard" boards stay distinguishable in the
      // picker (they can be renamed in edit mode; the switcher shows the name).
      const base = 'New dashboard';
      const taken = new Set(saved.map((b) => (b.name ?? '').trim()));
      let name = base;
      for (let n = 2; taken.has(name); n += 1) name = `${base} ${n}`;
      const created = await api.dashboards.create({
        id: '',
        name,
        schema_version: 1,
        columns: 12,
        widgets: [],
      });
      toast.success('Dashboard created');
      await reload();
      if (created?.id) setSelectedId(created.id);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not create a dashboard'));
    }
  }, [reload, saved]);

  const header = (
    <PageHeader
      variant="dense"
      icon={LayoutDashboard}
      title="Dashboards"
      description="Your build-your-own operations view. Edit to add, arrange, and resize widgets."
      data-testid="dashboards-header"
      meta={
        options.length > 1 ? (
          <Select value={active.id} onValueChange={setSelectedId}>
            <SelectTrigger className="h-8 w-56" aria-label="Select dashboard">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {/* Name is UNTRUSTED → rendered as plain text (#9). */}
                  {b.name || 'Untitled dashboard'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : undefined
      }
      actions={
        <Can resource="metrics" action="view">
          <Button type="button" variant="outline" size="sm" onClick={createBlank}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New dashboard
          </Button>
        </Can>
      }
    />
  );

  return (
    <PageContainer variant="fluid">
      {header}

      <div className="mt-6">
        {loading && !data ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-40 w-full rounded-lg" />
            ))}
          </div>
        ) : error && !data ? (
          <LoadError error={error} title="Couldn't load dashboards" onRetry={reload} />
        ) : (
          <DashboardBuilder
            // Remount the builder when the active dashboard identity changes so its
            // draft re-seeds cleanly from the newly-selected board.
            key={active.id}
            dashboard={active}
            can={hasPermission}
            // The role default (id 'overview') RESTORES on reset and is not persisted
            // until first Save; a user-created board is persisted + permanently deleted.
            isDefaultBoard={active.id === DEFAULT_DASHBOARD_ID}
            persisted={saved.some((b) => b.id === active.id)}
            onSaved={() => {
              void reload();
            }}
            onReset={() => {
              // After a reset the saved copy is gone; fall back to the default id.
              setSelectedId(DEFAULT_DASHBOARD_ID);
              void reload();
            }}
          />
        )}
      </div>
    </PageContainer>
  );
}

export default Dashboards;
