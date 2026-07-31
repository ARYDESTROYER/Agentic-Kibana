/**
 * useConfigEditor — load/draft/dirty/save spec (G6 R6). Powers the Baseline /
 * Campaigns / BatchJobs typed config editors (W0-F F5 endpoints).
 *
 * The hook is a CONFIG WRITER lifecycle only — it wraps a `{getConfig, putConfig}`
 * client, tracks a draft + dirty flag, and echoes the persisted config on save. It
 * never calls `decide()` and never bills an LLM.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useConfigEditor } from '../useConfigEditor';
import { useHasUnsavedChanges } from '@/soc/hooks/useDirtyDraft';

interface Cfg {
  enabled: boolean;
  n: number;
}

const DEFAULTS: Cfg = { enabled: false, n: 3 };

function makeClient(initial: Partial<Cfg>) {
  const putConfig = vi.fn(async (patch: Partial<Cfg>) => ({
    ok: true,
    config: { ...DEFAULTS, ...initial, ...patch },
  }));
  const getConfig = vi.fn(async () => ({ config: { ...DEFAULTS, ...initial } }));
  return { getConfig, putConfig };
}

describe('useConfigEditor', () => {
  it('loads the config over defaults and starts clean', async () => {
    const client = makeClient({ enabled: true, n: 7 });
    const { result } = renderHook(() => useConfigEditor<Cfg>(client, DEFAULTS));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.draft).toEqual({ enabled: true, n: 7 });
    expect(result.current.dirty).toBe(false);
  });

  it('marks dirty on update and clean again on discard', async () => {
    const client = makeClient({ n: 3 });
    const { result } = renderHook(() => useConfigEditor<Cfg>(client, DEFAULTS));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.update({ n: 5 }));
    expect(result.current.dirty).toBe(true);
    expect(result.current.draft.n).toBe(5);

    act(() => result.current.discard());
    expect(result.current.dirty).toBe(false);
    expect(result.current.draft.n).toBe(3);
  });

  it('registers its draft with the shell guard until discard or unmount', async () => {
    const client = makeClient({ n: 3 });
    const { result, unmount } = renderHook(() => {
      const editor = useConfigEditor<Cfg>(client, DEFAULTS);
      const hasUnsavedChanges = useHasUnsavedChanges();
      return { editor, hasUnsavedChanges };
    });
    await waitFor(() => expect(result.current.editor.loading).toBe(false));
    expect(result.current.hasUnsavedChanges).toBe(false);

    act(() => result.current.editor.update({ n: 5 }));
    await waitFor(() => expect(result.current.hasUnsavedChanges).toBe(true));

    act(() => result.current.editor.discard());
    await waitFor(() => expect(result.current.hasUnsavedChanges).toBe(false));

    act(() => result.current.editor.update({ n: 7 }));
    await waitFor(() => expect(result.current.hasUnsavedChanges).toBe(true));
    unmount();
  });

  it('saves the draft via putConfig and re-baselines the dirty flag', async () => {
    const client = makeClient({ n: 3 });
    const { result } = renderHook(() => useConfigEditor<Cfg>(client, DEFAULTS));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.update({ n: 9 }));
    await act(async () => {
      await result.current.save();
    });
    expect(client.putConfig).toHaveBeenCalledWith({ enabled: false, n: 9 });
    expect(result.current.dirty).toBe(false);
    expect(result.current.saved.n).toBe(9);
  });

  it('surfaces a load error without throwing', async () => {
    const failing = {
      getConfig: vi.fn(async () => {
        throw new Error('boom');
      }),
      putConfig: vi.fn(),
    };
    const { result } = renderHook(() => useConfigEditor<Cfg>(failing, DEFAULTS));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    // Falls back to defaults so the editor still renders.
    expect(result.current.draft).toEqual(DEFAULTS);
  });
});
