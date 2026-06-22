import React, { useEffect, useState } from 'react';
import {
  EuiBadge,
  EuiCallOut,
  EuiDescriptionList,
  EuiLoadingSpinner,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { TlsocApi } from '../lib/api';

export interface LogOverviewResult {
  overview: string;
  entities: string[];
  why_it_matters: string;
  suggested_next_step: string;
  mitre: string[];
  ip_reputation?: {
    ip?: string;
    reputation_score?: number;
    is_malicious?: boolean;
    country?: string;
  } | null;
  cost?: number;
}

interface Props {
  api: TlsocApi;
  source: Record<string, any>;
  index?: string;
  id?: string;
  dataView?: string;
}

/**
 * Feature 2: renders the backend's single-event AI overview (POST /api/overview).
 * Reused by the Discover doc-viewer tab and the in-app per-row button. Read-only,
 * cost-gated server-side; this component just displays the result.
 */
export const LogOverview: React.FC<Props> = ({ api, source, index, id, dataView }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LogOverviewResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await api.post<LogOverviewResult>('overview', {
          source,
          index,
          id,
          data_view: dataView,
        });
        if (!cancelled) {
          setData(res);
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message || 'Overview request failed');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, source, index, id, dataView]);

  if (loading) {
    return (
      <EuiText size="s">
        <EuiLoadingSpinner size="m" /> Generating AI overview…
      </EuiText>
    );
  }
  if (error) {
    return (
      <EuiCallOut color="danger" size="s" title="AI overview unavailable">
        <p>{error}</p>
      </EuiCallOut>
    );
  }
  if (!data) {
    return null;
  }

  const rep = data.ip_reputation;
  const items = [
    { title: 'Overview', description: data.overview || '—' },
    ...(data.why_it_matters ? [{ title: 'Why it matters', description: data.why_it_matters }] : []),
    ...(data.suggested_next_step
      ? [{ title: 'Suggested next step', description: data.suggested_next_step }]
      : []),
  ];

  return (
    <div>
      <EuiDescriptionList listItems={items} compressed />
      {data.entities && data.entities.length > 0 ? (
        <>
          <EuiSpacer size="s" />
          <EuiText size="xs" color="subdued">
            Entities:{' '}
            {data.entities.map((e, i) => (
              <EuiBadge key={i} color="hollow">
                {e}
              </EuiBadge>
            ))}
          </EuiText>
        </>
      ) : null}
      {data.mitre && data.mitre.length > 0 ? (
        <>
          <EuiSpacer size="xs" />
          <EuiText size="xs" color="subdued">
            MITRE:{' '}
            {data.mitre.map((m, i) => (
              <EuiBadge key={i} color="accent">
                {m}
              </EuiBadge>
            ))}
          </EuiText>
        </>
      ) : null}
      {rep && rep.ip ? (
        <>
          <EuiSpacer size="xs" />
          <EuiText size="xs" color="subdued">
            IP reputation:{' '}
            <EuiBadge color={rep.is_malicious ? 'danger' : 'default'}>
              {rep.ip} · {Math.round(rep.reputation_score || 0)}/100
              {rep.country ? ` · ${rep.country}` : ''}
            </EuiBadge>
          </EuiText>
        </>
      ) : null}
    </div>
  );
};
