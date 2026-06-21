/**
 * Helpers for turning a ConnectorForm value into the backend's save calls.
 *
 * The backend keeps a known set of top-level secret keys (POST /api/setup/secrets)
 * used by the implicit primary Elasticsearch source + the LLM/enrichment keys.
 * A connector's `auth_fields` mark secrets with `secret: true`; when a secret
 * field's key matches one of those known top-level keys we route it through
 * setup/secrets. Other (per-source) secrets are recorded as configured on the
 * source instance via `configured_secrets` (handled server-side); their VALUES
 * are not persisted by this UI beyond the setup/secrets call.
 */
import { api } from './api';
import type { ConnectorFormValue } from '../components/common/ConnectorForm';
import type { ConnectorManifest, SecretsUpdate, SourceUpsert } from './types';

/** Secret keys the backend accepts on POST /api/setup/secrets. */
export const KNOWN_SECRET_KEYS = new Set<keyof SecretsUpdate>([
  'es_api_key',
  'es_mgmt_api_key',
  'es_url',
  'es_ca_cert',
  'openai_api_key',
  'anthropic_api_key',
  'abuseipdb_api_key',
  'virustotal_api_key',
  'embedding_api_key',
]);

/** Field keys that are config in a connector but also map to known top-level secrets/wiring. */
const CONFIG_TO_SECRET_KEY: Record<string, keyof SecretsUpdate> = {
  es_url: 'es_url',
  es_ca_cert: 'es_ca_cert',
};

/**
 * Split a form value into:
 *   - `secrets`   : the SecretsUpdate body (known top-level secret keys), or null
 *   - `config`    : the non-secret connector config to store on the source
 *   - `secretKeys`: every secret field key the operator just set (for provenance)
 */
export function splitFormValue(
  _manifest: ConnectorManifest,
  value: ConnectorFormValue,
): { secrets: SecretsUpdate | null; config: Record<string, unknown>; secretKeys: string[] } {
  const secrets: Partial<SecretsUpdate> = {};
  const secretKeys: string[] = [];

  // typed secret VALUES from password fields
  for (const [key, v] of Object.entries(value.secrets)) {
    if (!v) continue;
    secretKeys.push(key);
    if (KNOWN_SECRET_KEYS.has(key as keyof SecretsUpdate)) {
      secrets[key as keyof SecretsUpdate] = v;
    }
  }

  // some non-secret config (es_url, es_ca_cert) also flows to setup/secrets wiring
  const config: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value.config)) {
    config[key] = v;
    const mapped = CONFIG_TO_SECRET_KEY[key];
    if (mapped && typeof v === 'string' && v) {
      secrets[mapped] = v;
    }
  }

  return {
    secrets: Object.keys(secrets).length ? (secrets as SecretsUpdate) : null,
    config,
    secretKeys,
  };
}

/** Persist a source: push known secrets, then upsert the source instance. */
export async function saveSource(
  manifest: ConnectorManifest,
  value: ConnectorFormValue,
  opts: {
    id: string;
    displayName: string;
    enabled: boolean;
    isPrimary: boolean;
    ingestMode?: string | null;
  },
): Promise<void> {
  const { secrets, config } = splitFormValue(manifest, value);
  if (secrets) {
    await api.updateSecrets(secrets);
  }
  const upsert: SourceUpsert = {
    id: opts.id,
    source_type: manifest.source_type,
    display_name: opts.displayName,
    enabled: opts.enabled,
    is_primary: opts.isPrimary,
    ingest_mode: opts.ingestMode ?? null,
    config,
  };
  await api.upsertSource(upsert);
}

/** A URL-safe slug from a display name (for a default source id). */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'source'
  );
}
