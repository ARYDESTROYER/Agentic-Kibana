/**
 * Models — "Add local model" (self-hosted / LiteLLM) dialog tests (task 7).
 *
 * Asserts the Catalog tab exposes an "Add local model" action, the dialog posts the
 * expected body to POST /api/llm/models/custom (reusing the openai_compatible path,
 * $0), the optional "Fetch models" probe hits POST /api/llm/providers/test, and a
 * registered local model can be removed. The modelsApi client is mocked (no network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { addCustomMock, removeCustomMock, providersTestMock, catalogMock, providersMock } =
  vi.hoisted(() => ({
    addCustomMock: vi.fn(),
    removeCustomMock: vi.fn(),
    providersTestMock: vi.fn(),
    catalogMock: vi.fn(),
    providersMock: vi.fn(),
  }));

vi.mock('../Models.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Models.api')>();
  return {
    ...actual,
    modelsApi: {
      ...actual.modelsApi,
      catalog: catalogMock,
      providers: providersMock,
      addCustom: addCustomMock,
      removeCustom: removeCustomMock,
      providersTest: providersTestMock,
    },
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'tester', authEnabled: false, hasPermission: () => true }),
}));

vi.mock('@/soc/components/Can', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/components/Can')>();
  return {
    ...actual,
    // Bypass the route guard + grant manage in the test.
    ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useCan: () => true,
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import type * as React from 'react';
import { TooltipProvider } from '@/ui/tooltip';
import Models from '../Models';
import type { ModelCatalogRow, ModelsCatalogResponse, ProvidersResponse } from '../Models.api';

function row(over: Partial<ModelCatalogRow>): ModelCatalogRow {
  return {
    id: 'x',
    label: 'X',
    provider: 'openai',
    context_window: 0,
    max_output: 0,
    modalities: [],
    capabilities: [],
    input_per_million: 1,
    output_per_million: 3,
    cache_write_per_million: null,
    cache_read_per_million: null,
    batch_multiplier: 0.5,
    base_url: null,
    pricing_source: 'exact',
    assigned_roles: [],
    price_overridden: false,
    ...over,
  };
}

const CATALOG: ModelsCatalogResponse = {
  models: [row({ id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' })],
  providers: { openai: ['gpt-4o'] },
  configured: {},
  overrides: {},
};

const PROVIDERS: ProvidersResponse = {
  providers: [{ name: 'openai_compatible', configured: true, models: [], supports_base_url: true }],
};

function renderPage() {
  return render(
    <TooltipProvider>
      <Models />
    </TooltipProvider>,
  );
}

describe('Models — Add local model', () => {
  beforeEach(() => {
    catalogMock.mockReset();
    providersMock.mockReset();
    addCustomMock.mockReset();
    removeCustomMock.mockReset();
    providersTestMock.mockReset();
    catalogMock.mockResolvedValue(CATALOG);
    providersMock.mockResolvedValue(PROVIDERS);
    addCustomMock.mockResolvedValue({ ok: true, model: {}, configured: {} });
    providersTestMock.mockResolvedValue({ ok: true, models: ['llama-3.1-8b'] });
  });

  it('posts the expected body to POST /api/llm/models/custom', async () => {
    renderPage();
    // Open the dialog from the Catalog tab toolbar.
    const openBtn = await screen.findByRole('button', { name: /add local model/i });
    fireEvent.click(openBtn);

    fireEvent.change(await screen.findByLabelText(/base url/i), {
      target: { value: 'http://localhost:4000/v1' },
    });
    fireEvent.change(screen.getByLabelText(/model id/i), {
      target: { value: 'llama-3.1-8b-instruct' },
    });
    fireEvent.change(screen.getByLabelText(/^label/i), { target: { value: 'Team Llama' } });

    fireEvent.click(screen.getByRole('button', { name: /add model/i }));

    await waitFor(() => expect(addCustomMock).toHaveBeenCalledTimes(1));
    expect(addCustomMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model_id: 'llama-3.1-8b-instruct',
        base_url: 'http://localhost:4000/v1',
        label: 'Team Llama',
      }),
    );
  });

  it('fetches models from the endpoint via the reachability probe', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /add local model/i }));
    fireEvent.change(await screen.findByLabelText(/base url/i), {
      target: { value: 'http://litellm:4000/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /fetch models/i }));
    await waitFor(() => expect(providersTestMock).toHaveBeenCalledWith('http://litellm:4000/v1', undefined));
    // The fetched id populates the model-id picker.
    expect(await screen.findByText('llama-3.1-8b')).toBeInTheDocument();
  });

  it('lists a registered local model with a Remove action', async () => {
    catalogMock.mockResolvedValue({
      ...CATALOG,
      models: [
        ...CATALOG.models,
        row({
          id: 'team-llama',
          label: 'Team Llama',
          provider: 'openai_compatible',
          input_per_million: 0,
          output_per_million: 0,
          base_url: 'http://litellm:4000/v1',
          is_custom: true,
        }),
      ],
    });
    removeCustomMock.mockResolvedValue({ ok: true, model: 'team-llama', removed: true });
    renderPage();

    // The local-models panel shows the row + a Remove control.
    const removeBtn = await screen.findByRole('button', { name: /remove team-llama/i });
    expect(screen.getByText(/local & self-hosted models/i)).toBeInTheDocument();
    fireEvent.click(removeBtn);
    await waitFor(() => expect(removeCustomMock).toHaveBeenCalledWith('team-llama'));
  });
});
