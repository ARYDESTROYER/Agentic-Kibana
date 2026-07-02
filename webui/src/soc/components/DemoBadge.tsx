/**
 * SAMPLE / DEMO badge (Round-2 Wave 5).
 *
 * A small amber "SAMPLE" pill marking synthetic demo cases so a viewer never
 * mistakes simulated data for real triage. A case is demo when its `tags` include
 * `'demo'` OR its `case_id` starts with `demo-` (both are stamped by the backend
 * demo store). Pure presentational; no demo context needed (the case carries its
 * own provenance), so it renders correctly in lists, detail headers, and tests.
 */
import { FlaskConical } from 'lucide-react';
import { Badge } from '@/ui/badge';
import { cn } from '@/lib/cn';
import type { Case } from '@/lib/types';

/** Whether a case is a synthetic demo case (tag `demo` or `demo-` id prefix). */
export function isDemoCase(c: Pick<Case, 'case_id' | 'tags'> | null | undefined): boolean {
  if (!c) return false;
  const id = typeof c.case_id === 'string' ? c.case_id : '';
  if (id.startsWith('demo-')) return true;
  return Array.isArray(c.tags) && c.tags.some((t) => String(t).toLowerCase() === 'demo');
}

export interface DemoBadgeProps {
  /** Render nothing unless this is true (convenience for `isDemoCase(c)`). */
  show?: boolean;
  className?: string;
  /** Hide the leading flask icon (e.g. in dense table cells). */
  iconless?: boolean;
}

/**
 * The SAMPLE pill. Renders only when `show` is true (or omitted → always render);
 * callers typically gate it with `isDemoCase(c)`.
 */
export function DemoBadge({ show = true, className, iconless }: DemoBadgeProps) {
  if (!show) return null;
  return (
    <Badge
      variant="warning"
      className={cn('gap-1', className)}
      title="Synthetic demo data — not a real case"
    >
      {iconless ? null : <FlaskConical className="h-3 w-3" aria-hidden />}
      SAMPLE
    </Badge>
  );
}

export default DemoBadge;
