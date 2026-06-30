/**
 * Co-located API + types for the Models / LLM admin page (Round 3 / Feature 9).
 *
 * Kept OUT of the shared `lib/api.ts` (parallel-build hygiene). Endpoints (all `/api`):
 *   GET  /llm/models                — the catalog: capabilities, pricing, provenance,
 *                                     per-role assignment, operator overrides.
 *   GET  /llm/providers             — the provider registry + configured booleans.
 *   POST /llm/models/test           — route a tiny prompt through the ONE gateway
 *                                     (metered; hits the cost ledger) to verify a model.
 *   PUT  /llm/models/{id}/pricing   — set an operator per-model price override.
 *   DELETE /llm/models/{id}/pricing — clear the override.
 *   POST /cost/estimate             — a pre-flight USD estimate for a prompt + budget.
 *   GET/PUT /budget                 — read / update the cost-budget ceiling config.
 *   GET  /budget/status             — live rolling spend vs the ceilings (burn-down).
 *
 * #9: every model id / label / reply / error string is attacker-influenceable; the
 * server returns them PLAIN and bounded, and the UI renders them as plain text or in a
 * fenced CodeBlock — never HTML, never a prompt input.
 */
import { api } from '@/lib/api';

export type PricingSource = 'exact' | 'heuristic' | 'zero' | 'default';

/** One row of GET /api/llm/models. */
export interface ModelCatalogRow {
  id: string;
  label: string;
  provider: string;
  context_window: number;
  max_output: number;
  modalities: string[];
  capabilities: string[];
  input_per_million: number;
  output_per_million: number;
  cache_write_per_million: number | null;
  cache_read_per_million: number | null;
  base_url: string | null;
  pricing_source: PricingSource | string;
  assigned_roles: string[];
  price_overridden: boolean;
}

/** GET /api/llm/models. */
export interface ModelsCatalogResponse {
  models: ModelCatalogRow[];
  providers: Record<string, string[]>;
  configured: Record<string, boolean>;
  overrides: Record<string, { input: number; output: number }>;
}

/** One provider row of GET /api/llm/providers. */
export interface ProviderRow {
  name: string;
  configured: boolean;
  models: string[];
  supports_base_url: boolean;
}

export interface ProvidersResponse {
  providers: ProviderRow[];
}

/** POST /api/llm/models/test result (success or a fenced error). */
export interface ModelTestResult {
  ok: boolean;
  model: string;
  provider: string;
  reply?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  pricing_source?: PricingSource | string;
  base_url?: string | null;
  error?: string;
}

/** POST /api/cost/estimate result. */
export interface CostEstimateResult {
  model: string;
  prompt_chars: number;
  max_tokens: number;
  estimated_cost: number;
  currency: string;
  pricing_source: PricingSource | string;
}

/** The cost-budget ceiling config (mirrors backend BudgetConfig). */
export interface BudgetConfig {
  enabled: boolean;
  daily_usd: number | null;
  monthly_usd: number | null;
  soft_warn_pct: number;
  on_exceed: 'warn' | 'block';
}

/** One window's status in GET /api/budget/status. */
export interface BudgetWindowStatus {
  spent: number;
  cap: number | null;
  fraction: number | null;
  band: 'ok' | 'warn' | 'over' | string;
}

/** GET /api/budget/status. */
export interface BudgetStatus {
  enabled: boolean;
  on_exceed: 'warn' | 'block' | string;
  soft_warn_pct: number;
  currency: string;
  daily: BudgetWindowStatus;
  monthly: BudgetWindowStatus;
}

export const modelsApi = {
  catalog: () => api.get<ModelsCatalogResponse>('llm/models'),
  providers: () => api.get<ProvidersResponse>('llm/providers'),
  test: (body: { model: string; provider?: string; prompt?: string }) =>
    api.post<ModelTestResult>('llm/models/test', body),
  setPricing: (modelId: string, input_per_million: number, output_per_million: number) =>
    api.put<{ ok: boolean; model: string; pricing: { input: number; output: number }; pricing_source: string }>(
      `llm/models/${encodeURIComponent(modelId)}/pricing`,
      { input_per_million, output_per_million },
    ),
  clearPricing: (modelId: string) =>
    api.del<{ ok: boolean; model: string; removed: boolean; pricing_source: string }>(
      `llm/models/${encodeURIComponent(modelId)}/pricing`,
    ),
  estimate: (body: { model: string; prompt?: string; prompt_chars?: number; max_tokens?: number }) =>
    api.post<CostEstimateResult>('cost/estimate', body),
  getBudget: () => api.get<{ budget: BudgetConfig }>('budget'),
  putBudget: (budget: BudgetConfig) =>
    api.put<{ ok: boolean; budget: BudgetConfig }>('budget', budget),
  budgetStatus: () => api.get<BudgetStatus>('budget/status'),
};

/** The per-role model slots (mirrors backend `_ROLE_FIELDS`). */
export const MODEL_ROLE_SLOTS = [
  'router',
  'investigator',
  'formatter',
  'standup',
  'chat',
  'overview',
  'embedding',
] as const;

/** Provenance badge metadata — variant + label for a pricing source. */
export const PRICING_SOURCE_META: Record<
  string,
  { label: string; variant: 'success' | 'warning' | 'info' | 'secondary' }
> = {
  exact: { label: 'Exact', variant: 'success' },
  heuristic: { label: 'Heuristic', variant: 'warning' },
  zero: { label: 'Free', variant: 'info' },
  default: { label: 'Default', variant: 'secondary' },
};
