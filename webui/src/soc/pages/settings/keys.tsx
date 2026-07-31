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

type SecretGroup = 'Data access' | 'AI runtime' | 'Threat intelligence';

export const SECRET_KEYS: Array<{ key: string; label: string; help: string; group: SecretGroup }> = [
  { key: 'es_api_key', label: 'Elasticsearch read-only API key', help: 'Scoped, read-only key for the log indices.', group: 'Data access' },
  { key: 'es_mgmt_api_key', label: 'Elasticsearch management API key', help: 'Scoped to tlsoc-agent-* bookkeeping indices.', group: 'Data access' },
  { key: 'openai_api_key', label: 'OpenAI API key', help: 'Default runtime for GPT-5.6 Luna completion roles and embeddings.', group: 'AI runtime' },
  { key: 'anthropic_api_key', label: 'Anthropic API key', help: 'Optional alternate runtime for Claude models.', group: 'AI runtime' },
  { key: 'embedding_api_key', label: 'Embedding API key', help: 'Defaults to the OpenAI key when blank.', group: 'AI runtime' },
  { key: 'abuseipdb_api_key', label: 'AbuseIPDB API key', help: 'IP reputation enrichment (optional).', group: 'Threat intelligence' },
  { key: 'virustotal_api_key', label: 'VirusTotal API key', help: 'File/URL/IP reputation (optional).', group: 'Threat intelligence' },
];

const SECRET_GROUPS: SecretGroup[] = ['Data access', 'AI runtime', 'Threat intelligence'];

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
      <div className="space-y-7">
        {SECRET_GROUPS.map((group) => (
          <fieldset key={group} className="space-y-4 border-t border-border/70 pt-4">
            <legend className="text-sm font-semibold tracking-tight text-foreground">{group}</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {SECRET_KEYS.filter((key) => key.group === group).map((key) => (
                <SecretInput
                  key={key.key}
                  label={key.label}
                  secretKey={key.key}
                  configured={configured[key.key]}
                  value={draft[key.key] || ''}
                  help={key.help}
                  onChange={(value) => set(key.key, value)}
                />
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="flex justify-end border-t border-border/70 pt-4">
        <Button onClick={onSave} disabled={saving || readOnly || !pending}>
          <Save className="h-4 w-4" aria-hidden />
          {saving ? 'Updating…' : 'Update keys'}
        </Button>
      </div>
    </div>
  );
}
