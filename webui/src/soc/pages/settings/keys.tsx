/**
 * Secret keys settings section (Round-5 Sett-A decomposition).
 *
 * Lifted verbatim from the former `Settings.tsx` `KeysSection`. Keys are WRITE-ONLY:
 * the console only ever knows whether a key is configured (a boolean), never the
 * value. Entered values are buffered in the page's `secretDraft` and pushed via the
 * dedicated secrets route — independent of the main settings save (#10).
 */
import { Save, ShieldCheck } from 'lucide-react';

import type { ConfiguredStatus } from '@/lib/types';

import { Button } from '@/ui/button';
import { Alert, AlertDescription } from '@/ui/alert';

import { SectionTitle, SecretInput } from './primitives';

export const SECRET_KEYS: Array<{ key: string; label: string; help: string }> = [
  { key: 'es_api_key', label: 'Elasticsearch read-only API key', help: 'Scoped, read-only key for the log indices.' },
  { key: 'es_mgmt_api_key', label: 'Elasticsearch management API key', help: 'Scoped to tlsoc-agent-* bookkeeping indices.' },
  { key: 'anthropic_api_key', label: 'Anthropic API key', help: 'For Claude models.' },
  { key: 'openai_api_key', label: 'OpenAI API key', help: 'For GPT models / embeddings.' },
  { key: 'embedding_api_key', label: 'Embedding API key', help: 'Defaults to the OpenAI key when blank.' },
  { key: 'abuseipdb_api_key', label: 'AbuseIPDB API key', help: 'IP reputation enrichment (optional).' },
  { key: 'virustotal_api_key', label: 'VirusTotal API key', help: 'File/URL/IP reputation (optional).' },
];

export function KeysSection({
  configured,
  draft,
  setDraft,
  onSave,
  saving,
  readOnly,
}: {
  configured: ConfiguredStatus;
  draft: Record<string, string>;
  setDraft: (d: Record<string, string>) => void;
  onSave: () => void;
  saving: boolean;
  readOnly: boolean;
}) {
  const set = (k: string, v: string) => setDraft({ ...draft, [k]: v });
  const pending = Object.values(draft).some((v) => v && v.trim().length > 0);
  return (
    <div className="space-y-6">
      <SectionTitle
        title="Secret keys"
        sub="Write-only. The console only ever sees whether a key is configured."
      />
      <Alert>
        <ShieldCheck className="h-4 w-4" aria-hidden />
        <AlertDescription>
          Existing values are never displayed. Enter a value to replace a key; leave a field blank
          to keep the current one.
        </AlertDescription>
      </Alert>
      <div className="grid gap-4 sm:grid-cols-2">
        {SECRET_KEYS.map((k) => (
          <SecretInput
            key={k.key}
            label={k.label}
            secretKey={k.key}
            configured={configured[k.key]}
            value={draft[k.key] || ''}
            help={k.help}
            onChange={(v) => set(k.key, v)}
          />
        ))}
      </div>
      <Button onClick={onSave} disabled={saving || readOnly || !pending}>
        <Save className="h-4 w-4" aria-hidden />
        {saving ? 'Updating…' : 'Update keys'}
      </Button>
    </div>
  );
}
