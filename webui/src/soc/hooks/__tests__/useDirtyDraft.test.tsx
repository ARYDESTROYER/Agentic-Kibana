/**
 * useDirtyDraft / useUnsavedChanges — draft-vs-saved coverage.
 *
 *   1. clean at start; goes dirty on edit; reset() restores; commit() clears dirty.
 *   2. a background `initial` change re-seeds when clean but preserves in-progress edits.
 *   3. useUnsavedChanges registers/removes the beforeunload guard by dirty state.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useDirtyDraft, useUnsavedChanges } from '../useDirtyDraft';

describe('useDirtyDraft', () => {
  it('tracks dirty across update/reset/commit', () => {
    const { result } = renderHook(() => useDirtyDraft({ a: 1, b: 'x' }));
    expect(result.current.dirty).toBe(false);

    act(() => result.current.update({ a: 2 }));
    expect(result.current.dirty).toBe(true);
    expect(result.current.draft).toEqual({ a: 2, b: 'x' });

    act(() => result.current.reset());
    expect(result.current.dirty).toBe(false);
    expect(result.current.draft).toEqual({ a: 1, b: 'x' });

    act(() => result.current.update({ b: 'y' }));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.commit());
    expect(result.current.dirty).toBe(false);
    expect(result.current.saved).toEqual({ a: 1, b: 'y' });
  });

  it('re-seeds on a background initial change only when clean', () => {
    const first = { a: 1 };
    const { result, rerender } = renderHook(({ init }) => useDirtyDraft(init), {
      initialProps: { init: first },
    });
    // Clean → a fresh fetch re-seeds both saved + draft.
    rerender({ init: { a: 2 } });
    expect(result.current.saved).toEqual({ a: 2 });
    expect(result.current.draft).toEqual({ a: 2 });

    // Now edit, then a background change lands: the DRAFT edit is preserved.
    act(() => result.current.update({ a: 99 }));
    rerender({ init: { a: 3 } });
    expect(result.current.saved).toEqual({ a: 3 });
    expect(result.current.draft).toEqual({ a: 99 });
    expect(result.current.dirty).toBe(true);
  });
});

describe('useUnsavedChanges', () => {
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  afterEach(() => {
    add.mockClear();
    remove.mockClear();
  });

  it('registers the beforeunload guard only while dirty', () => {
    const { rerender, unmount } = renderHook(({ dirty }) => useUnsavedChanges(dirty), {
      initialProps: { dirty: false },
    });
    expect(add).not.toHaveBeenCalledWith('beforeunload', expect.any(Function));

    rerender({ dirty: true });
    expect(add).toHaveBeenCalledWith('beforeunload', expect.any(Function));

    unmount();
    expect(remove).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });
});
