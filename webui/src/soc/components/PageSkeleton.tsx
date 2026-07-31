/**
 * PageSkeleton — the Suspense fallback shown while a lazily-loaded page chunk
 * downloads. The shared centered LoadingState is layered over quiet, motionless
 * page geometry so the route does not jump or flash a top-left progress treatment.
 *
 * Wave 0 route code-splitting: with ~25 pages now behind React.lazy, a chunk
 * fetch is sub-second on a warm cache but can flash on a cold one — this keeps
 * that moment graceful and on-brand instead of a white screen.
 */
import * as React from 'react';
import { LoadingState } from '@/design-system/loading';

export interface PageSkeletonProps {
  /**
   * Route-shape hint retained for callers: values above zero use the page/KPI
   * geometry; `0` uses the quieter form/panel geometry.
   */
  kpis?: number;
  /** Human route name shown while its lazy chunk loads. */
  label?: string;
}

export const PageSkeleton: React.FC<PageSkeletonProps> = ({ kpis = 4, label = 'page' }) => {
  const loadingLabel = `Loading ${label}`;
  return (
    <LoadingState
      data-testid="route-loading-fallback"
      label={loadingLabel}
      description="Preparing the workspace."
      layout="page"
      shape={kpis > 0 ? 'page' : 'panel'}
    />
  );
};

export default PageSkeleton;
