/**
 * Enrichment settings section (Round-5 Sett-A decomposition).
 *
 * Lifted verbatim from the former `Settings.tsx` `EnrichmentSection`. The master
 * toggle + cache TTL, plus the self-contained provider catalog editor (which manages
 * its own toggles/secrets save lifecycle independent of the page's dirty-map).
 */

import { NumPref, SectionTitle, SwitchPref, type SecProps } from './primitives';
import { EnrichmentProvidersEditor } from '@/soc/components/EnrichmentProvidersEditor';

export function EnrichmentSection({ prefs, update }: SecProps) {
  const e = prefs.enrichment || {};
  const set = (patch: Partial<typeof e>) => update({ enrichment: { ...e, ...patch } });
  return (
    <div className="space-y-6">
      <SectionTitle title="Enrichment" sub="Threat-intel lookups (cached in Redis)." />
      <div className="space-y-2">
        <SwitchPref label="Enrichment enabled" checked={e.enabled ?? true} onChange={(v) => set({ enabled: v })} />
      </div>
      <NumPref label="Cache TTL (seconds)" value={e.cache_ttl_seconds} onChange={(v) => set({ cache_ttl_seconds: v })} />
      {/* The full provider catalog (manifests + write-only secrets + try-a-lookup).
          Self-contained: it fetches its own provider manifests and persists the
          per-provider use_* toggles + secrets via its own co-located api (the
          shared settings PUT for toggles, the dedicated secrets route for keys),
          so it manages its own save lifecycle independent of the section dirty-map.
          `embedded` suppresses its own heading since the section provides one. */}
      <EnrichmentProvidersEditor embedded />
    </div>
  );
}
