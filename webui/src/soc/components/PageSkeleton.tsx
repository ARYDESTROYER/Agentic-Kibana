/**
 * PageSkeleton — the Suspense fallback shown while a lazily-loaded page chunk
 * downloads. It mirrors the resting page chrome (a header block + a row of KPI
 * tiles + a content card) so the layout doesn't visibly shift when the real page
 * resolves. Built only from existing primitives (Skeleton/SkeletonCard +
 * LoadingBar); reduced-motion safe via the global shimmer/indeterminate rules.
 *
 * Wave 0 route code-splitting: with ~25 pages now behind React.lazy, a chunk
 * fetch is sub-second on a warm cache but can flash on a cold one — this keeps
 * that moment graceful and on-brand instead of a white screen.
 */
import * as React from 'react';
import { Skeleton, SkeletonCard } from '@/ui/skeleton';
import { LoadingBar } from './LoadingBar';

export const PageSkeleton: React.FC = () => (
  <div className="space-y-6" aria-busy="true" aria-label="Loading page">
    {/* Slim top progress hint */}
    <LoadingBar className="max-w-xs" label="Loading page" />

    {/* Header block: icon chip + eyebrow/title/description, mirroring PageHeader */}
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3.5">
        <Skeleton className="mt-0.5 h-10 w-10 shrink-0 rounded-md" />
        <div className="space-y-2">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-3 w-72" />
        </div>
      </div>
      <Skeleton className="h-9 w-28 rounded-md" />
    </div>

    {/* A row of KPI-tile placeholders */}
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <SkeletonCard key={i} lines={2} />
      ))}
    </div>

    {/* A taller content card (table / detail body) */}
    <SkeletonCard lines={6} withIcon={false} />
  </div>
);

export default PageSkeleton;
