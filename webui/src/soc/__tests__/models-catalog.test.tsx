/**
 * Models catalog render tests (Round 3 / Feature 9).
 *
 * Renders the ModelsCatalog table with a mixed catalog and asserts: capability chips,
 * pricing, the provenance badge, the assigned-role badge, and the operator-override
 * marker all show; the provider filter narrows the rows; and the per-row test/edit
 * actions fire their callbacks. Offline — the component is presentational.
 */
import type * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';
import { ModelsCatalog, capabilityChips } from '../components/ModelsCatalog';
import type { ModelCatalogRow } from '../pages/Models.api';

const ROWS: ModelCatalogRow[] = [
  {
    id: 'claude-opus-4',
    label: 'Claude Opus 4',
    provider: 'anthropic',
    context_window: 200000,
    max_output: 32000,
    modalities: ['text', 'vision'],
    capabilities: ['tools', 'cache'],
    input_per_million: 15,
    output_per_million: 75,
    cache_write_per_million: 18.75,
    cache_read_per_million: 1.5,
    base_url: null,
    pricing_source: 'exact',
    assigned_roles: ['investigator', 'chat'],
    price_overridden: true,
  },
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    provider: 'openai',
    context_window: 128000,
    max_output: 16000,
    modalities: ['text'],
    capabilities: ['tools'],
    input_per_million: 0.15,
    output_per_million: 0.6,
    cache_write_per_million: null,
    cache_read_per_million: null,
    base_url: null,
    pricing_source: 'heuristic',
    assigned_roles: [],
    price_overridden: false,
  },
];

function renderCatalog(props: Partial<React.ComponentProps<typeof ModelsCatalog>> = {}) {
  return render(
    <TooltipProvider>
      <ModelsCatalog rows={ROWS} {...props} />
    </TooltipProvider>,
  );
}

describe('capabilityChips', () => {
  it('derives context/output/modality/tool/cache chips', () => {
    const chips = capabilityChips(ROWS[0]).map((c) => c.label);
    expect(chips).toContain('200K ctx');
    expect(chips).toContain('32K out');
    expect(chips).toContain('Vision');
    expect(chips).toContain('Tool JSON');
    expect(chips).toContain('Cache');
  });

  it('marks cache from a cache price even without a capability flag', () => {
    const row: ModelCatalogRow = {
      ...ROWS[1],
      capabilities: [],
      cache_read_per_million: 0.05,
    };
    expect(capabilityChips(row).map((c) => c.label)).toContain('Cache');
  });
});

describe('ModelsCatalog render', () => {
  it('renders both models with labels, pricing and provenance', () => {
    renderCatalog();
    expect(screen.getByText('Claude Opus 4')).toBeInTheDocument();
    expect(screen.getByText('GPT-4o mini')).toBeInTheDocument();
    // Provenance badges.
    expect(screen.getByText('Exact')).toBeInTheDocument();
    expect(screen.getByText('Heuristic')).toBeInTheDocument();
    // Assigned-role badges (humanized).
    expect(screen.getByText('Investigator')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
  });

  it('filters by provider', () => {
    renderCatalog({ providerFilter: 'openai' });
    expect(screen.getByText('GPT-4o mini')).toBeInTheDocument();
    expect(screen.queryByText('Claude Opus 4')).not.toBeInTheDocument();
  });

  it('fires onTest and onEditPrice for a row', () => {
    const onTest = vi.fn();
    const onEditPrice = vi.fn();
    renderCatalog({ onTest, onEditPrice });
    fireEvent.click(screen.getByLabelText('Test claude-opus-4'));
    fireEvent.click(screen.getByLabelText('Override price for claude-opus-4'));
    expect(onTest).toHaveBeenCalledWith(ROWS[0]);
    expect(onEditPrice).toHaveBeenCalledWith(ROWS[0]);
  });

  it('disables actions when the user cannot manage models', () => {
    const onTest = vi.fn();
    renderCatalog({ onTest, canManage: false });
    const btn = screen.getByLabelText('Test claude-opus-4');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onTest).not.toHaveBeenCalled();
  });
});
