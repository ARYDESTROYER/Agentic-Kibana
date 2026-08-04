import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

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
import Intelligence from '../Intelligence';
import { TooltipProvider } from '@/ui/tooltip';

function widthAuthorities(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[class]')).filter((node) =>
    (node.getAttribute('class') ?? '').includes('max-w-[1760px]'),
  );
}

describe('Intelligence blocking loads', () => {
  it('uses one host heading, one width authority, and labelled leaf controls while Knowledge boots', () => {
    mocks.ragStats.mockReturnValue(new Promise<never>(() => {}));
    mocks.ragDocuments.mockReturnValue(new Promise<never>(() => {}));

    const { container } = render(
      <TooltipProvider>
        <Intelligence tab="knowledge" />
      </TooltipProvider>,
    );

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Knowledge corpus' })).toBeInTheDocument();
    expect(widthAuthorities(container)).toHaveLength(1);
    const controls = screen.getByRole('group', { name: 'Knowledge corpus controls' });
    expect(within(controls).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.getByText('Loading knowledge corpus')).toBeInTheDocument();
    expect(screen.getAllByTestId('console-loading-glyph')).toHaveLength(1);
    expect(screen.queryByText('Corpus by source')).not.toBeInTheDocument();
  });

  it('uses one host heading and labelled leaf controls while durable memory boots', () => {
    mocks.getMemory.mockReturnValue(new Promise<never>(() => {}));

    render(
      <TooltipProvider>
        <Intelligence tab="memory" />
      </TooltipProvider>,
    );

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Operator memory' })).toBeInTheDocument();
    const controls = screen.getByRole('group', { name: 'Operator memory controls' });
    expect(within(controls).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.getByText('Loading memory')).toBeInTheDocument();
    expect(screen.getAllByTestId('console-loading-glyph')).toHaveLength(1);
    expect(screen.queryByText('Saved memories')).not.toBeInTheDocument();
  });

  it('preserves the standalone Knowledge page header', () => {
    mocks.ragStats.mockReturnValue(new Promise<never>(() => {}));
    mocks.ragDocuments.mockReturnValue(new Promise<never>(() => {}));

    render(<Knowledge />);

    expect(screen.getByRole('heading', { level: 1, name: 'Knowledge & RAG' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Knowledge corpus controls' })).not.toBeInTheDocument();
  });

  it('preserves the standalone Memory page header', () => {
    mocks.getMemory.mockReturnValue(new Promise<never>(() => {}));

    render(<Memory />);

    expect(screen.getByRole('heading', { level: 1, name: 'Memory' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Operator memory controls' })).not.toBeInTheDocument();
  });
});
