/**
 * Investigate (preview) — kick off a manual investigation of an entity via
 * POST /api/investigate and render the resulting case verdict. Minimal port.
 */
import React, { useState } from 'react';
import {
  EuiButton,
  EuiDescriptionList,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSelect,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { Case } from '../../lib/types';
import { api } from '../../lib/api';
import { ConfidenceBadge, ErrorCallout, PreviewPill, RiskBadge, SectionHeader, StatusBadge, VerdictBadge } from '../common/ui';
import { fmtMoney } from '../../lib/format';

export const InvestigatePage: React.FC = () => {
  const [entityType, setEntityType] = useState<'ip' | 'user' | 'host'>('ip');
  const [entityValue, setEntityValue] = useState('');
  const [result, setResult] = useState<Case | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async () => {
    if (!entityValue.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const c = await api.investigate({
        entity: { type: entityType, value: entityValue.trim() },
        group_by: entityType,
        source_surface: 'investigate',
      });
      setResult(c);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <SectionHeader
        icon="inspect"
        title="Investigate"
        description="Run a manual investigation on an IP, user, or host."
        actions={<PreviewPill />}
      />

      <EuiPanel hasBorder paddingSize="l">
        <EuiFlexGroup gutterSize="s" alignItems="flexEnd" responsive={false} wrap>
          <EuiFlexItem grow={false} style={{ minWidth: 140 }}>
            <EuiSelect
              prepend="Entity"
              options={[
                { value: 'ip', text: 'IP' },
                { value: 'user', text: 'User' },
                { value: 'host', text: 'Host' },
              ]}
              value={entityType}
              onChange={(e) => setEntityType(e.target.value as typeof entityType)}
            />
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiFieldText
              placeholder="e.g. 10.0.0.5"
              value={entityValue}
              onChange={(e) => setEntityValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run();
              }}
              fullWidth
            />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButton fill iconType="play" onClick={run} isLoading={loading}>
              Investigate
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>

      <EuiSpacer size="m" />
      {error ? <ErrorCallout error={error} title="Investigation failed" /> : null}

      {result ? (
        <EuiPanel hasBorder paddingSize="l">
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
            <EuiFlexItem grow={false}>
              <VerdictBadge verdict={result.verdict} />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <RiskBadge score={result.risk_score} />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <ConfidenceBadge confidence={result.confidence} />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <StatusBadge status={result.status} />
            </EuiFlexItem>
          </EuiFlexGroup>
          <EuiSpacer size="m" />
          <EuiText>
            <h3>{result.title || result.case_id}</h3>
            <p>{result.summary || result.recommended_action || 'No summary.'}</p>
          </EuiText>
          <EuiSpacer size="m" />
          <EuiDescriptionList
            compressed
            type="column"
            listItems={[
              { title: 'Case ID', description: result.case_id },
              { title: 'Entity', description: `${result.entity?.type}:${result.entity?.value}` },
              { title: 'MITRE', description: (result.mitre || []).join(', ') || '—' },
              { title: 'Reproduce query', description: result.reproduce_query || '—' },
              { title: 'Token cost', description: fmtMoney(result.token_cost) },
            ]}
          />
        </EuiPanel>
      ) : null}
    </div>
  );
};
