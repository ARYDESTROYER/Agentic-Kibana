/**
 * usePosture — wraps the server posture rollup through useAsync.
 *
 *   1. calls fetchPosture with the window hours + no compare by default;
 *   2. period='prev' passes 'prev' so the server returns the compare block;
 *   3. surfaces the resolved payload as data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { fetchPostureMock } = vi.hoisted(() => ({ fetchPostureMock: vi.fn() }));

vi.mock('@/soc/pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('@/soc/pages/Metrics.posture.api')>(
    '@/soc/pages/Metrics.posture.api',
  );
  return { ...actual, fetchPosture: fetchPostureMock };
});

import { usePosture } from '../usePosture';

describe('usePosture', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset();
    fetchPostureMock.mockResolvedValue({ window_hours: 24, case_count: 7 });
  });

  it('fetches for the given window with no compare by default', async () => {
    const { result } = renderHook(() => usePosture(24));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchPostureMock).toHaveBeenCalledWith(24, '');
    expect(result.current.data).toMatchObject({ case_count: 7 });
    expect(result.current.error).toBeNull();
  });

  it("passes 'prev' when period is prev", async () => {
    const { result } = renderHook(() => usePosture(72, 'prev'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchPostureMock).toHaveBeenCalledWith(72, 'prev');
  });
});
