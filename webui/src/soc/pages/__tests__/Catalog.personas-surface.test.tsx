/** Agent personas remain a direct Intelligence leaf, not a tab hidden under Playbooks. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ getPersonas: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getPersonas: mocks.getPersonas,
    },
  };
});

import { TooltipProvider } from '@/ui/tooltip';
import Catalog from '../Catalog';

describe('Catalog — direct Agent personas surface', () => {
  beforeEach(() => {
    mocks.getPersonas.mockReset();
    mocks.getPersonas.mockResolvedValue({
      enabled: true,
      personas: [
        {
          id: 'identity_access',
          label: 'Identity & access',
          specialization: 'Authentication and privilege investigations.',
          focus_tools: ['es_query', 'enrich'],
          keywords: ['login', 'mfa'],
        },
      ],
    });
  });

  it('renders the requested persona catalog without a second tab switcher', async () => {
    render(
      <TooltipProvider>
        <Catalog embedded defaultTab="personas" />
      </TooltipProvider>,
    );

    expect(await screen.findByText('Identity & access')).toBeInTheDocument();
    expect(screen.getByText('Authentication and privilege investigations.')).toBeInTheDocument();
    const personaSummary = screen.getByText('Identity & access').closest('summary');
    expect(personaSummary?.parentElement).not.toHaveAttribute('open');
    fireEvent.click(personaSummary as HTMLElement);
    expect(personaSummary?.parentElement).toHaveAttribute('open');
    expect(screen.getByText('es_query')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(mocks.getPersonas).toHaveBeenCalledTimes(1);
  });
});
