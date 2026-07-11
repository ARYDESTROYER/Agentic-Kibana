/**
 * Demo-mode banner (Round-2 Wave 5).
 *
 * A persistent amber notice shown in the app shell whenever the demo tenant is
 * active (status.mode !== 'off'). It makes the simulated state unmistakable and
 * offers the two reversible exits inline: Reset (re-seed from the same seed) and
 * Exit & clear (stop the tick + hard-delete all demo data, returning the real
 * state). It can be collapsed to a slim pill (the state lives in localStorage so it
 * stays collapsed across navigations) but is never fully dismissible — demo is a
 * loud, deliberate state.
 *
 * Reads/writes go through the shared <DemoProvider>; on success it refreshes the
 * context so the rest of the console (cases store, cost suffix, health chip) flips
 * with it. Nothing here renders when demo is off.
 */
import * as React from 'react';
import { FlaskConical, RotateCcw, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Button } from '@/ui/button';
import { cn } from '@/lib/cn';
import { useDemo } from '@/soc/demo';
import { useIsMobile } from '@/soc/hooks/useMediaQuery';
import { useCan } from './Can';

const COLLAPSE_KEY = 'tlsoc.demoBanner.collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(v: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
  } catch {
    /* best-effort */
  }
}

export const DemoBanner: React.FC = () => {
  const { status, active, refresh } = useDemo();
  const [collapsed, setCollapsed] = React.useState<boolean>(() => readCollapsed());
  const [busy, setBusy] = React.useState<'reset' | 'disable' | null>(null);
  const isMobile = useIsMobile();
  const canManage = useCan('demo', 'manage');

  const setCollapsedPersisted = React.useCallback((v: boolean) => {
    setCollapsed(v);
    writeCollapsed(v);
  }, []);

  const onReset = React.useCallback(async () => {
    setBusy('reset');
    try {
      await api.demo.reset();
      await refresh();
      toast.success('Demo data re-seeded.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reset demo data.');
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const onDisable = React.useCallback(async () => {
    setBusy('disable');
    try {
      await api.demo.disable();
      await refresh();
      toast.success('Demo mode exited — synthetic data cleared.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not exit demo mode.');
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  if (!active) return null;

  const modeLabel = status.mode === 'live' ? 'live simulation' : 'seeded';

  // Collapsed: a slim amber pill that re-expands on click.
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsedPersisted(false)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border border-warning/50 bg-warning/10 px-3 py-1 text-xs font-medium text-warning-text',
          'transition-colors hover:bg-warning/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
        aria-label="Demo mode active — expand details"
      >
        <FlaskConical className="h-3.5 w-3.5" aria-hidden />
        Demo mode active
      </button>
    );
  }

  // On a phone the full explanatory desktop banner consumed roughly four content
  // rows on every route. Keep the safety state unmistakable, but reduce the persistent
  // chrome to one compact control row; the complete isolation statement remains in
  // the accessibility tree and the two reversible actions stay directly available.
  if (isMobile) {
    return (
      <Alert
        variant="warning"
        className="flex min-h-12 items-center gap-2 px-3 py-2 pr-2 [&>svg]:static [&>svg]:size-4 [&>svg~*]:pl-0"
      >
        <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <AlertTitle className="mb-0 truncate text-xs">
            {status.mode === 'live' ? 'Live demo' : 'Seeded demo'} · synthetic data
          </AlertTitle>
          <AlertDescription className="sr-only">
            You are viewing a fully isolated {modeLabel} dataset. Real cases are hidden,
            no model costs are incurred, and demo activity does not modify real cases or cursors.
          </AlertDescription>
        </div>
        {canManage ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-warning-text hover:bg-warning/10"
              onClick={() => void onReset()}
              disabled={busy !== null}
              aria-label={busy === 'reset' ? 'Resetting demo data' : 'Reset demo data'}
            >
              <RotateCcw
                className={cn('h-3.5 w-3.5', busy === 'reset' && 'animate-spin')}
                aria-hidden
              />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 border-warning/50 px-2 text-warning-text hover:bg-warning/10"
              onClick={() => void onDisable()}
              disabled={busy !== null}
              aria-label="Exit Demo Mode and clear synthetic data"
            >
              {busy === 'disable' ? 'Exiting…' : 'Exit'}
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-warning-text hover:bg-warning/10"
          onClick={() => setCollapsedPersisted(true)}
          aria-label="Collapse demo banner"
        >
          <ChevronDown className="h-4 w-4 rotate-180" aria-hidden />
        </Button>
      </Alert>
    );
  }

  return (
    <Alert variant="warning" className="flex flex-wrap items-start gap-3 pr-3">
      <FlaskConical className="h-4 w-4" aria-hidden />
      <div className="min-w-0 flex-1">
        <AlertTitle className="flex items-center gap-2">
          Demo mode active (simulated data)
        </AlertTitle>
        <AlertDescription className="mt-0.5">
          You are viewing a fully isolated {modeLabel} dataset. Real cases are hidden and
          nothing here costs money or touches your real cases or cursors. Disabling restores
          your real state intact.
        </AlertDescription>
      </div>
      <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:shrink-0">
        {canManage ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-warning/50 text-warning-text hover:bg-warning/10"
              onClick={() => void onReset()}
              disabled={busy !== null}
            >
              <RotateCcw className={cn('h-3.5 w-3.5', busy === 'reset' && 'animate-spin')} aria-hidden />
              Reset
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-warning/50 text-warning-text hover:bg-warning/10"
              onClick={() => void onDisable()}
              disabled={busy !== null}
            >
              {busy === 'disable' ? 'Exiting…' : 'Exit & clear'}
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-warning-text hover:bg-warning/10"
          onClick={() => setCollapsedPersisted(true)}
          aria-label="Collapse demo banner"
        >
          <ChevronDown className="h-4 w-4 rotate-180" aria-hidden />
        </Button>
      </div>
    </Alert>
  );
};

export default DemoBanner;
