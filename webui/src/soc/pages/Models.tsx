/**
 * Models — first-class LLM model administration (Round 3 / Feature 9).
 *
 * Promoted out of the Settings subsection into its own admin page. Three tabs:
 *   - Catalog            — every model with capability badges, pricing, provenance,
 *                          per-role assignment; per-row price-override + metered test.
 *   - Cost & budget      — a live cost estimator (POST /api/cost/estimate) and the
 *                          budget ceiling card with a burn-down (GET/PUT /api/budget,
 *                          GET /api/budget/status) using the Stage-1 chart primitives.
 *   - Providers          — the provider registry (anthropic/openai/azure/bedrock/
 *                          vertex/openai_compatible/mock) + configured booleans.
 *
 * RBAC: gated behind <ProtectedRoute resource="models" action="read">; the mutating
 * controls (price override, budget save, test call) additionally require
 * `models:manage` (driven by the existing <Can>/useCan guard).
 *
 * #9: model ids / labels / replies / errors are attacker-influenceable — rendered as
 * PLAIN text or in a fenced CodeBlock; never HTML, never re-fed into a prompt.
 * #3: nothing here touches case_manager.decide(); a budget only governs whether an LLM
 * call RUNS (enforced in the gateway, which fails to NEEDS_HUMAN).
 */
import * as React from 'react';
import {
  Cpu,
  RefreshCw,
  Loader2,
  DollarSign,
  Calculator,
  Server,
  CheckCircle2,
  XCircle,
  Save,
} from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtMoney, humanizeToken } from '@/lib/format';
import { Card } from '@/ui/card';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { PageHeader } from '@/soc/components/PageHeader';
import { StatCard } from '@/soc/components/StatCard';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { ProtectedRoute, useCan } from '@/soc/components/Can';
import { ModelsCatalog } from '@/soc/components/ModelsCatalog';
import { BudgetCard } from '@/soc/components/BudgetCard';
import {
  modelsApi,
  PRICING_SOURCE_META,
  type ModelCatalogRow,
  type ModelsCatalogResponse,
  type ProvidersResponse,
  type ModelTestResult,
  type CostEstimateResult,
} from './Models.api';

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

export default function Models() {
  return (
    <ProtectedRoute resource="models" action="read">
      <ModelsInner />
    </ProtectedRoute>
  );
}

export function ModelsInner() {
  const canManage = useCan('models', 'manage');
  const [catalog, setCatalog] = React.useState<ModelsCatalogResponse | null>(null);
  const [providers, setProviders] = React.useState<ProvidersResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [providerFilter, setProviderFilter] = React.useState('all');

  // Per-model dialogs.
  const [priceFor, setPriceFor] = React.useState<ModelCatalogRow | null>(null);
  const [testFor, setTestFor] = React.useState<ModelCatalogRow | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [cat, prov] = await Promise.all([
        modelsApi.catalog(),
        modelsApi.providers().catch(() => null),
      ]);
      setCatalog(cat);
      if (prov) setProviders(prov);
    } catch (e) {
      toast.error(errMsg(e, 'Could not load models.'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const models = catalog?.models ?? [];
  const providerNames = React.useMemo(
    () => Array.from(new Set(models.map((m) => m.provider))).sort(),
    [models],
  );

  const exactCount = models.filter((m) => m.pricing_source === 'exact').length;
  const assignedCount = models.filter((m) => m.assigned_roles.length > 0).length;
  const overrideCount = models.filter((m) => m.price_overridden).length;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Cpu}
        eyebrow="Administration"
        title="Models & LLMs"
        description="The model catalog, per-role routing, pricing, and the cost-budget ceiling."
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
            Refresh
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Models" value={models.length} icon={Cpu} accent="primary" />
        <StatCard label="Verified pricing" value={exactCount} accent="success" sub="exact rates" />
        <StatCard label="Assigned" value={assignedCount} accent="info" sub="to a role" />
        <StatCard label="Overrides" value={overrideCount} accent="medium" sub="operator prices" />
      </div>

      <Tabs defaultValue="catalog">
        <TabsList>
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
          <TabsTrigger value="cost">Cost &amp; budget</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
        </TabsList>

        {/* --- Catalog --- */}
        <TabsContent value="catalog" className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Every model the gateway can route. Pricing provenance is badged; an operator
              override pins a contract rate.
            </p>
            <div className="w-48">
              <Select value={providerFilter} onValueChange={setProviderFilter}>
                <SelectTrigger aria-label="Filter by provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All providers</SelectItem>
                  {providerNames.map((p) => (
                    <SelectItem key={p} value={p}>
                      {humanizeToken(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <ModelsCatalog
            rows={models}
            loading={loading}
            providerFilter={providerFilter}
            canManage={canManage}
            onEditPrice={(r) => setPriceFor(r)}
            onTest={(r) => setTestFor(r)}
          />
        </TabsContent>

        {/* --- Cost & budget --- */}
        <TabsContent value="cost" className="space-y-6">
          <CostEstimator models={models} canManage={canManage} />
          <BudgetCard canManage={canManage} />
        </TabsContent>

        {/* --- Providers --- */}
        <TabsContent value="providers" className="space-y-4">
          <ProvidersGrid providers={providers} loading={loading} />
        </TabsContent>
      </Tabs>

      {priceFor ? (
        <PriceOverrideDialog
          model={priceFor}
          onClose={() => setPriceFor(null)}
          onSaved={() => {
            setPriceFor(null);
            void load();
          }}
        />
      ) : null}

      {testFor ? (
        <TestCallDialog model={testFor} onClose={() => setTestFor(null)} />
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Price-override dialog (PUT/DELETE /api/llm/models/{id}/pricing).
// --------------------------------------------------------------------------- //
function PriceOverrideDialog({
  model,
  onClose,
  onSaved,
}: {
  model: ModelCatalogRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [input, setInput] = React.useState(String(model.input_per_million));
  const [output, setOutput] = React.useState(String(model.output_per_million));
  const [busy, setBusy] = React.useState(false);

  const save = async () => {
    const inp = Number(input);
    const out = Number(output);
    if (!Number.isFinite(inp) || inp < 0 || !Number.isFinite(out) || out < 0) {
      toast.error('Enter non-negative numbers for both rates.');
      return;
    }
    setBusy(true);
    try {
      await modelsApi.setPricing(model.id, inp, out);
      toast.success(`Price override set for ${model.id}.`);
      onSaved();
    } catch (e) {
      toast.error(errMsg(e, 'Could not set the price override.'));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await modelsApi.clearPricing(model.id);
      toast.success(`Override cleared for ${model.id}.`);
      onSaved();
    } catch (e) {
      toast.error(errMsg(e, 'Could not clear the override.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Override pricing</DialogTitle>
          <DialogDescription>
            Pin a contract rate for <span className="font-mono">{model.id}</span> (USD per
            1M tokens). Overrides badge as “Exact”.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="price-in">Input / 1M</Label>
            <Input
              id="price-in"
              type="number"
              min={0}
              step="0.01"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="price-out">Output / 1M</Label>
            <Input
              id="price-out"
              type="number"
              min={0}
              step="0.01"
              value={output}
              onChange={(e) => setOutput(e.target.value)}
              disabled={busy}
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          {model.price_overridden ? (
            <Button variant="outline" className="text-critical" onClick={() => void clear()} disabled={busy}>
              Clear override
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- //
// Test-call dialog (POST /api/llm/models/test) — metered; fenced output (#9).
// --------------------------------------------------------------------------- //
function TestCallDialog({ model, onClose }: { model: ModelCatalogRow; onClose: () => void }) {
  const [prompt, setPrompt] = React.useState('Reply with the single word: ok');
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<ModelTestResult | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await modelsApi.test({
        model: model.id,
        provider: model.provider,
        prompt: prompt.slice(0, 2000),
      });
      setResult(res);
      if (res.ok) toast.success(`${model.id} responded.`);
      else toast.error('Test call failed — see the response below.');
    } catch (e) {
      toast.error(errMsg(e, 'The test call could not be sent.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Test model</DialogTitle>
          <DialogDescription>
            Routes a tiny prompt through the one gateway against{' '}
            <span className="font-mono">{model.id}</span>. This is metered and hits the cost
            ledger.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="test-prompt">Prompt</Label>
            <Textarea
              id="test-prompt"
              rows={3}
              value={prompt}
              maxLength={2000}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={busy}
            />
          </div>

          {result ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={result.ok ? 'success' : 'critical'}>
                  {result.ok ? 'OK' : 'Error'}
                </Badge>
                {result.ok ? (
                  <>
                    <span className="text-xs text-muted-foreground">
                      {result.prompt_tokens ?? 0} in · {result.completion_tokens ?? 0} out ·{' '}
                      {fmtMoney(result.cost ?? 0)}
                    </span>
                    {result.pricing_source ? (
                      <Badge
                        variant={
                          PRICING_SOURCE_META[String(result.pricing_source)]?.variant ?? 'secondary'
                        }
                        className="text-2xs"
                      >
                        {PRICING_SOURCE_META[String(result.pricing_source)]?.label ??
                          result.pricing_source}
                      </Badge>
                    ) : null}
                  </>
                ) : null}
              </div>
              {/* The reply / error is UNTRUSTED model output → fenced CodeBlock (#9). */}
              <CodeBlock
                value={result.ok ? result.reply || '(empty reply)' : result.error || 'Unknown error'}
                caption={result.ok ? 'Model reply' : 'Error'}
                wrap
                maxHeightClassName="max-h-56"
              />
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button onClick={() => void run()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Send test
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- //
// Cost estimator (POST /api/cost/estimate) — a pre-flight USD estimate.
// --------------------------------------------------------------------------- //
function CostEstimator({
  models,
  canManage,
}: {
  models: ModelCatalogRow[];
  canManage: boolean;
}) {
  const [model, setModel] = React.useState(models[0]?.id ?? '');
  const [promptChars, setPromptChars] = React.useState('4000');
  const [maxTokens, setMaxTokens] = React.useState('1000');
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<CostEstimateResult | null>(null);

  React.useEffect(() => {
    if (!model && models.length) setModel(models[0].id);
  }, [models, model]);

  const run = async () => {
    if (!model) {
      toast.error('Pick a model.');
      return;
    }
    setBusy(true);
    try {
      const res = await modelsApi.estimate({
        model,
        prompt_chars: Math.max(0, Number(promptChars) || 0),
        max_tokens: Math.max(0, Number(maxTokens) || 0),
      });
      setResult(res);
    } catch (e) {
      toast.error(errMsg(e, 'Estimate failed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 p-6">
      <div className="flex items-center gap-2">
        <Calculator className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">Cost estimator</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        A pre-flight USD estimate for a prompt size + completion budget on one model.
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="space-y-1.5">
          <Label>Model</Label>
          <Select value={model || undefined} onValueChange={setModel}>
            <SelectTrigger aria-label="Model to estimate">
              <SelectValue placeholder="— model —" />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="est-chars">Prompt chars</Label>
          <Input
            id="est-chars"
            type="number"
            min={0}
            value={promptChars}
            onChange={(e) => setPromptChars(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="est-tokens">Max output tokens</Label>
          <Input
            id="est-tokens"
            type="number"
            min={0}
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <Button
            onClick={() => void run()}
            disabled={busy || !canManage}
            className="w-full"
            title={canManage ? undefined : 'Requires models:manage'}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Estimate
          </Button>
        </div>
      </div>
      {result ? (
        <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-success" aria-hidden />
            <span className="text-lg font-semibold tabular-nums text-foreground">
              {fmtMoney(result.estimated_cost, result.currency === 'USD' ? '$' : result.currency)}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            {result.prompt_chars.toLocaleString()} chars · {result.max_tokens.toLocaleString()} max tokens
          </span>
          <Badge
            variant={PRICING_SOURCE_META[String(result.pricing_source)]?.variant ?? 'secondary'}
            className="text-2xs"
          >
            {PRICING_SOURCE_META[String(result.pricing_source)]?.label ?? result.pricing_source}
          </Badge>
        </div>
      ) : null}
    </Card>
  );
}

// --------------------------------------------------------------------------- //
// Providers grid (GET /api/llm/providers).
// --------------------------------------------------------------------------- //
function ProvidersGrid({
  providers,
  loading,
}: {
  providers: ProvidersResponse | null;
  loading?: boolean;
}) {
  if (loading && !providers) {
    return <p className="text-sm text-muted-foreground">Loading providers…</p>;
  }
  const rows = providers?.providers ?? [];
  if (!rows.length) {
    return <p className="text-sm text-muted-foreground">No providers available.</p>;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((p) => (
        <Card key={p.name} className="space-y-2 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-muted-foreground" aria-hidden />
              <span className="font-medium capitalize text-foreground">
                {humanizeToken(p.name)}
              </span>
            </div>
            {p.configured ? (
              <Badge variant="success" className="gap-1">
                <CheckCircle2 className="h-3 w-3" aria-hidden /> Configured
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1">
                <XCircle className="h-3 w-3" aria-hidden /> Not set
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{p.models.length} models</span>
            {p.supports_base_url ? <Badge variant="outline">Custom base URL</Badge> : null}
          </div>
        </Card>
      ))}
    </div>
  );
}
