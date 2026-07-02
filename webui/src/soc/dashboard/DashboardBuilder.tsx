/**
 * `DashboardBuilder` — the 5-step builder loop that hosts one dashboard's view/edit
 * experience (Round 5 / G7, CD4):
 *
 *   1. READ-ONLY by default (the calm default, #10) — the WidgetGrid renders in view
 *      mode (zero grid JS) with a single primary "Edit dashboard" CTA, `<Can>`-gated.
 *   2. EXPLICIT Edit mode — a sticky Save / Discard / Reset bar appears, an
 *      unsaved-changes guard arms (`useUnsavedChanges` → `beforeunload`), and the grid
 *      swaps to the lazily-loaded RGL edit surface.
 *   3. ADD from a curated gallery (never a blank canvas) — the WidgetGallery Sheet.
 *   4. CONFIGURE per widget — the WidgetConfigSheet.
 *   5. DRAG/RESIZE (pointer OR keyboard, WCAG 2.5.7), then EXPLICIT Save.
 *
 * The draft widget list is buffered against the last-saved snapshot via `useDirtyDraft`
 * so Discard restores the EXACT saved state and Save persists via
 * `api.dashboards.update` (a debounced no-op tick during drag is intentionally NOT
 * auto-persisted — persistence is on explicit Save, matching Grafana's Apply/Save
 * discipline; the debounce is only about not thrashing local state).
 *
 * "Reset to default" DELETES the user's saved copy so the org/role/code default takes
 * over on next load — a distinct action from Discard (labelled precisely so it never
 * gets confused with the platform factory reset).
 *
 * NON-NEGOTIABLES: a layout is ADVISORY presentation (#3 — never feeds `decide()`);
 * widget titles/dashboard names are UNTRUSTED and render as plain text/SVG (#9); the
 * read-only default is calm (#10). The RGL dep is loaded ONLY in edit mode (via the
 * WidgetGrid lazy boundary) — view mode + first paint ship zero grid JS.
 */
import * as React from 'react';
import { Pencil, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import type { DashboardLayout, DashboardWidget } from '@/lib/types';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { IconButton } from '@/soc/components/IconButton';
import { Can } from '@/soc/components/Can';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { StickySaveBar } from '@/soc/components/SettingsGrid';
import { useDirtyDraft, useUnsavedChanges } from '@/soc/hooks/useDirtyDraft';

import { WidgetGrid, type WidgetEditActions } from './WidgetGrid';
import { WidgetGallery } from './WidgetGallery';
import { WidgetConfigSheet } from './WidgetConfigSheet';
import {
  DashboardDataProvider,
  DASHBOARD_AUTO_REFRESH_MS,
  type DashboardSourceKey,
} from './DashboardDataProvider';
import {
  applyLayout,
  moveWidget,
  resizeWidget,
  packWidgets,
  widgetId,
  widgetOptions,
  freshId,
  normalizeWidget,
  type GridItemShape,
  type MoveDir,
  type ResizeDir,
} from './layout-utils';
import { getWidgetDef, type PermissionCheck } from './registry';

/** The RBAC resource/action that gates EDITING a dashboard (personal customization). */
const EDIT_RESOURCE = 'metrics';
const EDIT_ACTION = 'view';

export interface DashboardBuilderProps {
  /** The dashboard to render/edit (already reconciled + RBAC-filtered by the host). */
  dashboard: DashboardLayout;
  /** Permission check for the widget gallery / reconcile (defaults permit-all). */
  can?: PermissionCheck;
  /**
   * Whether this board is the per-role DEFAULT (id `overview`) vs a user-created board.
   * Drives the destructive-action wording: the default offers "Reset to default layout"
   * (restore), a user board offers "Delete dashboard" (permanent). Default `true`.
   */
  isDefaultBoard?: boolean;
  /**
   * Whether a server-side copy of this board actually exists yet. The read-only role
   * default is NOT persisted until the first Save, so resetting it must be a purely
   * local revert (a DELETE would 404). Default `true` (a saved board).
   */
  persisted?: boolean;
  /** Called after a successful Save with the persisted dashboard (host refreshes). */
  onSaved?: (dashboard: DashboardLayout) => void;
  /** Called after a successful Reset-to-default (host reloads the effective default). */
  onReset?: () => void;
  className?: string;
}

/** The pieces of a dashboard the builder buffers as its editable draft. */
interface DashboardDraft {
  name: string;
  columns: number;
  widgets: DashboardWidget[];
}

function toDraft(d: DashboardLayout): DashboardDraft {
  const columns = typeof d.columns === 'number' ? d.columns : 12;
  return {
    name: d.name ?? '',
    columns,
    // Seed the edit-mode draft with the SAME deterministic packing VIEW mode applies
    // (WidgetGrid → packWidgets), so the FIRST Edit entry shows the coherent flow-packed
    // grid instead of RGL vertical-compacting an all-at-origin per-role default into a
    // single column (a visible "jump" on first edit). packWidgets is idempotent for a
    // real saved layout, so a customised board round-trips byte-for-byte and does NOT
    // read as dirty on entering edit.
    //
    // Single-breakpoint MVP: the draft carries only `columns` + `widgets` (ONE layout).
    // The backend `DashboardLayout` keeps a per-breakpoint `layouts` map for forward
    // wire-compat, but the builder never AUTHORS it — the save payload in `save()` only
    // ever sends the single-breakpoint widget list, so the server keeps `layouts: {}`.
    // Responsive per-breakpoint overrides are intentionally NOT wired on the FE.
    widgets: packWidgets((d.widgets ?? []).map(normalizeWidget), columns),
  };
}

export function DashboardBuilder({
  dashboard,
  can,
  isDefaultBoard = true,
  persisted = true,
  onSaved,
  onReset,
  className,
}: DashboardBuilderProps) {
  const initial = React.useMemo(() => toDraft(dashboard), [dashboard]);
  const { draft, setDraft, dirty, reset, commit } = useDirtyDraft<DashboardDraft>(initial);

  const [editing, setEditing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [galleryOpen, setGalleryOpen] = React.useState(false);
  const [configWidget, setConfigWidget] = React.useState<DashboardWidget | null>(null);
  const [confirmReset, setConfirmReset] = React.useState(false);
  // External refresh signal handed to the DashboardDataProvider (which lives BELOW this
  // header, so a header control can't reach its context) — bumping this re-fetches every
  // widget's shared source. The provider ALSO auto-refreshes lightly on a visible-tab
  // interval, so data never freezes on the mount snapshot.
  const [reloadNonce, setReloadNonce] = React.useState(0);

  // Arm the browser unload guard only while editing WITH unsaved changes.
  useUnsavedChanges(dirty, editing);

  const cols = draft.columns || 12;

  // ------- Draft mutations (all pure array ops on the widget list) ------- //

  const setWidgets = React.useCallback(
    (next: DashboardWidget[]) => setDraft((prev) => ({ ...prev, widgets: next })),
    [setDraft],
  );

  const setName = React.useCallback(
    (name: string) => setDraft((prev) => ({ ...prev, name })),
    [setDraft],
  );

  const addWidget = React.useCallback(
    (w: DashboardWidget) => setWidgets([...draft.widgets, normalizeWidget(w)]),
    [draft.widgets, setWidgets],
  );

  const removeWidget = React.useCallback(
    (w: DashboardWidget) =>
      setWidgets(draft.widgets.filter((x) => widgetId(x) !== widgetId(w))),
    [draft.widgets, setWidgets],
  );

  const duplicateWidget = React.useCallback(
    (w: DashboardWidget) => {
      const copy = normalizeWidget({
        ...w,
        i: freshId('w-'),
        // Nudge the copy down a row so it doesn't perfectly overlap the source.
        y: (w as { y?: number }).y != null ? (w as { y: number }).y + 1 : 0,
        options: { ...widgetOptions(w) },
      } as DashboardWidget);
      setWidgets([...draft.widgets, copy]);
    },
    [draft.widgets, setWidgets],
  );

  const moveOne = React.useCallback(
    (w: DashboardWidget, dir: MoveDir) =>
      setWidgets(
        draft.widgets.map((x) => (widgetId(x) === widgetId(w) ? moveWidget(x, dir, cols) : x)),
      ),
    [draft.widgets, setWidgets, cols],
  );

  const resizeOne = React.useCallback(
    (w: DashboardWidget, dir: ResizeDir) =>
      setWidgets(
        draft.widgets.map((x) => (widgetId(x) === widgetId(w) ? resizeWidget(x, dir, cols) : x)),
      ),
    [draft.widgets, setWidgets, cols],
  );

  const applyConfig = React.useCallback(
    (w: DashboardWidget, options: Record<string, unknown>) =>
      setWidgets(
        draft.widgets.map((x) =>
          widgetId(x) === widgetId(w) ? ({ ...x, options } as DashboardWidget) : x,
        ),
      ),
    [draft.widgets, setWidgets],
  );

  // RGL layout change → merge geometry back onto the widgets. Debounced so a per-pixel
  // drag tick doesn't thrash state; the settle wins.
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cancel any pending geometry settle so it can't fire AFTER a Discard/Save and
  // re-apply the just-reverted/just-saved layout onto the committed state.
  const cancelLayoutSettle = React.useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);
  const onGridLayoutChange = React.useCallback(
    (layout: GridItemShape[]) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        setDraft((prev) => ({ ...prev, widgets: applyLayout(prev.widgets, layout) }));
      }, 200);
    },
    [setDraft],
  );
  React.useEffect(() => () => cancelLayoutSettle(), [cancelLayoutSettle]);

  const editActions = React.useMemo<WidgetEditActions>(
    () => ({
      onConfigure: setConfigWidget,
      onDuplicate: duplicateWidget,
      onRemove: removeWidget,
      onMove: moveOne,
      onResize: resizeOne,
    }),
    [duplicateWidget, removeWidget, moveOne, resizeOne],
  );

  // ------- Persist / discard / reset ------- //

  const save = React.useCallback(async () => {
    cancelLayoutSettle();
    setSaving(true);
    try {
      const payload: DashboardLayout = {
        ...dashboard,
        id: dashboard.id,
        name: draft.name,
        columns: draft.columns,
        widgets: draft.widgets,
      };
      // Explicit Save opts into the immediate path (drag/resize streams stay debounced).
      const stored = await api.dashboards.update(dashboard.id, payload, { immediate: true });
      // Commit the SAVED state (from the server echo when present, else our payload)
      // so `dirty` clears against exactly what persisted.
      commit(toDraft(stored ?? payload));
      setEditing(false);
      toast.success('Dashboard saved');
      onSaved?.(stored ?? payload);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the dashboard'));
    } finally {
      setSaving(false);
    }
  }, [dashboard, draft, commit, onSaved, cancelLayoutSettle]);

  const discard = React.useCallback(() => {
    cancelLayoutSettle();
    reset();
    setEditing(false);
  }, [reset, cancelLayoutSettle]);

  const doReset = React.useCallback(async () => {
    // The read-only role default is NOT persisted until first Save, so there is no
    // server copy to DELETE — a DELETE would 404 and surface a spurious error. Revert
    // locally instead (the default is already the effective layout).
    if (isDefaultBoard && !persisted) {
      cancelLayoutSettle();
      reset();
      setEditing(false);
      setConfirmReset(false);
      toast.success('Restored the default layout');
      onReset?.();
      return;
    }
    const okMsg = isDefaultBoard ? 'Reset to the default layout' : 'Dashboard deleted';
    const succeed = () => {
      setEditing(false);
      onReset?.();
    };
    setSaving(true);
    try {
      await api.dashboards.remove(dashboard.id);
      toast.success(okMsg);
      succeed();
    } catch (err) {
      // A 404 means the copy is already gone — the desired end state is in effect, so
      // treat it as success rather than alarming the user with an error toast.
      if (err instanceof ApiError && err.status === 404) {
        toast.success(okMsg);
        succeed();
      } else {
        toast.error(
          errorMessage(
            err,
            isDefaultBoard ? 'Could not reset the dashboard' : 'Could not delete the dashboard',
          ),
        );
      }
    } finally {
      setSaving(false);
      setConfirmReset(false);
    }
  }, [dashboard.id, isDefaultBoard, persisted, reset, onReset, cancelLayoutSettle]);

  // The widgets shown in view mode always reflect the SAVED snapshot; in edit mode the
  // live draft. (Discard restores the saved snapshot exactly.)
  const shownWidgets = draft.widgets;

  // The union of data sources the PLACED widgets actually read — narrows the provider
  // so it fetches ONLY what a widget consumes. This drops billing/unconsumed sources
  // (notably `standup`, which no widget declares) so the dashboards view NEVER triggers
  // an LLM call for data nothing displays (#6/#7 — dashboards never bill the LLM, H3).
  // An empty dashboard needs zero sources → zero round-trips.
  const neededSources = React.useMemo<DashboardSourceKey[]>(() => {
    const set = new Set<DashboardSourceKey>();
    for (const w of shownWidgets) {
      const def = getWidgetDef((w as { type?: string }).type ?? '');
      if (!def) continue; // unknown/legacy type contributes no sources
      for (const s of def.sources) set.add(s);
    }
    return [...set];
  }, [shownWidgets]);

  return (
    <div className={className}>
      {/* Header action row: view = single "Edit" CTA; edit = rename + Add-widget. */}
      {editing ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <label
              htmlFor="dashboard-name-input"
              className="shrink-0 text-xs font-medium text-muted-foreground"
            >
              Name
            </label>
            {/* Dashboard name is UNTRUSTED → stored + rendered as plain text (#9). */}
            <Input
              id="dashboard-name-input"
              data-testid="dashboard-name-input"
              value={draft.name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Dashboard name"
              maxLength={80}
              className="h-8 w-56"
            />
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setGalleryOpen(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add widget
          </Button>
        </div>
      ) : (
        <div className="mb-4 flex items-center justify-end gap-2">
          {/* Manual refresh — re-pull every widget's shared source now. Tooltip is off so
              the control needs no TooltipProvider ancestor (it stays labelled either way). */}
          <IconButton
            label="Refresh dashboard data"
            tooltip={false}
            variant="outline"
            onClick={() => setReloadNonce((n) => n + 1)}
            data-testid="dashboard-refresh-btn"
          >
            <RefreshCw aria-hidden />
          </IconButton>
          <Can resource={EDIT_RESOURCE} action={EDIT_ACTION}>
            <Button
              type="button"
              size="sm"
              onClick={() => setEditing(true)}
              data-testid="dashboard-edit-btn"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Edit dashboard
            </Button>
          </Can>
        </div>
      )}

      {/* The grid — wrapped in ONE data provider so widgets fetch each source once,
          NARROWED to only the sources the placed widgets read (never `standup`, so the
          page bills zero LLM calls — #6/#7, H3). */}
      <DashboardDataProvider
        sourceKeys={neededSources}
        reloadNonce={reloadNonce}
        refreshIntervalMs={DASHBOARD_AUTO_REFRESH_MS}
      >
        <WidgetGrid
          widgets={shownWidgets}
          editing={editing}
          cols={cols}
          onLayoutChange={onGridLayoutChange}
          editActions={editActions}
        />
      </DashboardDataProvider>

      {/* Sticky action bar (edit mode only). */}
      {editing ? (
        <StickySaveBar
          visible
          busy={saving}
          onSave={save}
          onDiscard={discard}
          saveLabel="Save dashboard"
          discardLabel="Discard"
          message={
            dirty ? 'You have unsaved dashboard changes.' : 'Editing — drag, resize, add or remove widgets.'
          }
          className="flex-wrap"
        />
      ) : null}

      {/* In edit mode, offer the destructive action next to the sticky bar controls.
          The role default RESTORES; a user-created board is permanently DELETED. */}
      {editing ? (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setConfirmReset(true)}
            disabled={saving}
          >
            {isDefaultBoard ? 'Reset to default layout' : 'Delete dashboard'}
          </Button>
        </div>
      ) : null}

      {/* Add-from-gallery */}
      <WidgetGallery open={galleryOpen} onOpenChange={setGalleryOpen} can={can} onAdd={addWidget} />

      {/* Per-widget config */}
      <WidgetConfigSheet
        widget={configWidget}
        onOpenChange={(o) => {
          if (!o) setConfigWidget(null);
        }}
        onApply={applyConfig}
      />

      {/* Destructive confirm — copy matches the actual outcome (restore vs delete),
          distinct from the platform factory reset. */}
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        onConfirm={doReset}
        destructive
        title={isDefaultBoard ? 'Reset to the default layout?' : 'Delete this dashboard?'}
        description={
          isDefaultBoard
            ? 'This discards your personal customizations for this dashboard and restores the default layout for your role. It does not affect any other settings.'
            : 'This permanently deletes this dashboard and cannot be undone. It does not affect any other dashboards or settings.'
        }
        confirmLabel={isDefaultBoard ? 'Reset layout' : 'Delete dashboard'}
      />
    </div>
  );
}

export default DashboardBuilder;
