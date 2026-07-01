/**
 * Models & LLM settings section (Round-5 Sett-A decomposition).
 *
 * Lifted verbatim from the former `Settings.tsx` `ModelsSection` — the per-role model
 * assignment, with a deep-link to the richer Models admin page. Model ids render as
 * plain text (externally-sourced but non-secret).
 */
import { AlertTriangle, Sparkles } from 'lucide-react';

import type { ModelConfig, ModelsResponse, Preferences } from '@/lib/types';
import { MODEL_ROLES } from '@/lib/types';

import { Button } from '@/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';

import { SectionTitle, ModelPicker, type NavigateFn, type SecProps } from './primitives';

/** Per-role → Preferences model-config field. */
export const ROLE_PREF_KEY: Record<string, keyof Preferences> = {
  router: 'router_model',
  investigator: 'investigator_model',
  formatter: 'formatter_model',
  standup: 'standup_model',
  chat: 'chat_model',
  overview: 'overview_model',
  embedding: 'embedding_model',
};

export function ModelsSection({
  prefs,
  update,
  models,
  onNavigate,
}: SecProps & { models: ModelsResponse | null; onNavigate?: NavigateFn }) {
  return (
    <div className="space-y-6">
      <SectionTitle title="Per-role models" sub="The model used for each task." />
      {!models ? (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertTitle>Model catalog unavailable</AlertTitle>
          <AlertDescription>
            Could not load the available models. Add an LLM key under Secret keys, then refresh.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {MODEL_ROLES.map((role) => (
          <ModelPicker
            key={role}
            role={role}
            models={models}
            value={prefs[ROLE_PREF_KEY[role]] as ModelConfig | undefined}
            onChange={(m) => update({ [ROLE_PREF_KEY[role]]: m } as Partial<Preferences>)}
          />
        ))}
      </div>
      {/* The richer Models admin page (catalog capabilities, pricing/provenance,
          cost estimator + budget ceiling, providers) is its own first-class surface;
          this subsection keeps only the per-role assignment. */}
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3">
        <span className="text-sm text-muted-foreground">
          Model catalog, pricing, cost &amp; budget, and providers
        </span>
        {onNavigate ? (
          <Button variant="outline" size="sm" onClick={() => onNavigate('models')}>
            <Sparkles className="h-4 w-4" aria-hidden />
            Open Models admin
          </Button>
        ) : null}
      </div>
    </div>
  );
}
