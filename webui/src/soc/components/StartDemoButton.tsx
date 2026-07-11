/**
 * One-click cold-start into the isolated, $0 live demo tenant.
 *
 * Used by genuine zero-data states so an evaluator is never forced to connect a
 * production source before seeing the product work. The backend remains the safety
 * authority: POST /demo/enable is demo:manage-gated and creates a reversible,
 * synthetic tenant. This control is hidden when the principal lacks that grant.
 */
import * as React from 'react';
import { FlaskConical, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button, type ButtonProps } from '@/ui/button';
import { useCan } from './Can';
import { useDemo } from '../demo';

export interface StartDemoButtonProps
  extends Omit<ButtonProps, 'children' | 'onClick'> {
  /** Refresh the hosting surface after the demo store has been seeded. */
  onStarted?: () => void | Promise<void>;
}

export function StartDemoButton({
  onStarted,
  variant = 'outline',
  size = 'sm',
  ...props
}: StartDemoButtonProps) {
  const canManage = useCan('demo', 'manage');
  const { active, refresh } = useDemo();
  const [busy, setBusy] = React.useState(false);

  const start = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Let backend defaults own the dataset/rate knobs. Supplying only the mode
      // makes this CTA follow future high-fidelity demo defaults automatically.
      await api.demo.enable({ mode: 'live' });
      await refresh();
      await onStarted?.();
      toast.success('Live demo started — synthetic sources are streaming.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start the live demo.');
    } finally {
      setBusy(false);
    }
  }, [busy, onStarted, refresh]);

  // Enabling an already-active run is intentionally destructive: the backend first
  // clears and reseeds it. A cold-start CTA must therefore disappear as soon as any
  // demo tenant is active, even if that run currently has zero cases.
  if (!canManage || active) return null;

  return (
    <Button
      variant={variant}
      size={size}
      onClick={() => void start()}
      disabled={busy}
      {...props}
    >
      {busy ? (
        <Loader2 className="animate-spin" aria-hidden />
      ) : (
        <FlaskConical aria-hidden />
      )}
      {busy ? 'Starting demo…' : 'Start live demo'}
    </Button>
  );
}

export default StartDemoButton;
