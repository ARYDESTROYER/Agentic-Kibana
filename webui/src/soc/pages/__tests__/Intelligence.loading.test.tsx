import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  ragStats: vi.fn(),
  ragDocuments: vi.fn(),
  getMemory: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      ragStats: mocks.ragStats,
      ragDocuments: mocks.ragDocuments,
      getMemory: mocks.getMemory,
    },
  };
});

vi.mock('@/soc/components/Can', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/components/Can')>();
  return { ...actual, useCan: () => false };
});

import Knowledge from '../Knowledge';
import Memory from '../Memory';

describe('Intelligence blocking loads', () => {
  it('uses one centered Console loader while the knowledge corpus boots', () => {
    mocks.ragStats.mockReturnValue(new Promise<never>(() => {}));
    mocks.ragDocuments.mockReturnValue(new Promise<never>(() => {}));

    render(<Knowledge embedded />);

    expect(screen.getByText('Loading knowledge corpus')).toBeInTheDocument();
    expect(screen.getAllByTestId('console-loading-glyph')).toHaveLength(1);
    expect(screen.queryByText('Corpus by source')).not.toBeInTheDocument();
  });

  it('uses one centered Console loader while durable memory boots', () => {
    mocks.getMemory.mockReturnValue(new Promise<never>(() => {}));

    render(<Memory embedded />);

    expect(screen.getByText('Loading memory')).toBeInTheDocument();
    expect(screen.getAllByTestId('console-loading-glyph')).toHaveLength(1);
    expect(screen.queryByText('Saved memories')).not.toBeInTheDocument();
  });
});
