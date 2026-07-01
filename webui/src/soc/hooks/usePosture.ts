/**
 * usePosture — the shared hook for the server-side security-posture rollup.
 *
 * Round-5 W0-B B5: gives Overview/Dashboard a one-liner to consume `GET /api/metrics/
 * posture` (the backend computes MTTA/MTTR/dwell percentiles, quality rates, aging + SLA
 * + period-over-period deltas server-side). The Dashboard-density wave (Dash-A) uses this
 * to delete the ~120 lines of client-side posture math that duplicated the server rollup.
 *
 * Built on `useAsync` (load/error/reload) + the existing co-located `fetchPosture` data
 * layer (`pages/Metrics.posture.api.ts`) — no new endpoint, no new client method.
 *
 *   usePosture(hours, period) -> { data: PostureResponse|null, loading, error, reload }
 *
 * `period` selects the period-over-period comparison window: `'prev'` includes the
 * `compare` block (deltas vs the prior equal window); `'none'` (default) omits it. It
 * re-fetches whenever `hours` or `period` change.
 *
 * SECURITY (#9): every label/entity in `PostureResponse` is operator-/log-derived; the
 * consuming components render them as PLAIN text. This hook only moves the SHAPE around.
 */
import { fetchPosture } from '@/soc/pages/Metrics.posture.api';
import type { PostureResponse } from '@/soc/pages/Metrics.posture.api';

import { useAsync } from './useAsync';
import type { AsyncState } from './useAsync';

/** The comparison window for the posture rollup. `'prev'` → include deltas. */
export type PosturePeriod = 'none' | 'prev';

export function usePosture(
  hours: number,
  period: PosturePeriod = 'none',
): AsyncState<PostureResponse> {
  return useAsync<PostureResponse>(
    () => fetchPosture(hours, period === 'prev' ? 'prev' : ''),
    [hours, period],
  );
}
