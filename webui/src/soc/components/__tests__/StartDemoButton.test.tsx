import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  canManage: true,
  active: false,
  enable: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: { demo: { enable: (...args: unknown[]) => h.enable(...args) } },
}));
vi.mock('@/soc/demo', () => ({
  useDemo: () => ({ active: h.active, refresh: h.refresh }),
}));
vi.mock('../Can', () => ({
  useCan: () => h.canManage,
}));
vi.mock('sonner', () => ({
  toast: { success: h.success, error: h.error },
}));

import { StartDemoButton } from '../StartDemoButton';

describe('StartDemoButton', () => {
  beforeEach(() => {
    h.canManage = true;
    h.active = false;
    h.enable.mockReset().mockResolvedValue({ mode: 'live', active: true });
    h.refresh.mockReset().mockResolvedValue({ mode: 'live', active: true });
    h.success.mockReset();
    h.error.mockReset();
  });

  it('starts the backend-owned live defaults, refreshes demo context, then refreshes its host', async () => {
    const onStarted = vi.fn().mockResolvedValue(undefined);
    render(<StartDemoButton onStarted={onStarted} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start live demo' }));
    await waitFor(() => expect(h.enable).toHaveBeenCalledWith({ mode: 'live' }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(h.success).toHaveBeenCalledWith(
      'Live demo started — synthetic sources are streaming.',
    );
  });

  it('does not expose a privileged demo mutation without demo:manage', () => {
    h.canManage = false;
    render(<StartDemoButton />);
    expect(screen.queryByRole('button', { name: 'Start live demo' })).toBeNull();
  });

  it('never reseeds an already-active demo from a cold-start CTA', () => {
    h.active = true;
    render(<StartDemoButton />);
    expect(screen.queryByRole('button', { name: 'Start live demo' })).toBeNull();
    expect(h.enable).not.toHaveBeenCalled();
  });
});
