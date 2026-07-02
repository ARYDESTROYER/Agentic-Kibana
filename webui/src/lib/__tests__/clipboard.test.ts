import { describe, it, expect, vi, beforeEach } from 'vitest';
import { copyText } from '@/lib/clipboard';

describe('copyText', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves true when clipboard API succeeds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });
});
