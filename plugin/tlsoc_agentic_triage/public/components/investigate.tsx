import React, { useEffect, useState } from 'react';
import {
  EuiButton,
  EuiCallOut,
  EuiFieldSearch,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSelect,
  EuiSpacer,
} from '@elastic/eui';
import type { Case, Entity } from '../../common';
import type { TlsocApi } from '../lib/api';
import { SectionHeader } from './ui';
import { MetaLabel } from './case_card';
import { CaseGrid } from './case_grid';

/** Shape of a Kibana HttpFetchError; we read the backend's JSON `body` detail
 * and `response.status` so a NEUTRAL 400 ("No events found") becomes an info
 * empty-state instead of a red danger error. */
interface HttpFetchErrorLike {
  body?: { statusCode?: number; message?: string; error?: string; detail?: string };
  response?: { status?: number };
  message?: string;
}

function errorDetail(err: unknown): string {
  const e = err as HttpFetchErrorLike;
  return e?.body?.detail ?? e?.body?.message ?? e?.message ?? 'Request failed';
}

function isNoEventsError(err: unknown): boolean {
  const e = err as HttpFetchErrorLike;
  const status = e?.body?.statusCode ?? e?.response?.status;
  if (status === 400) return true;
  return errorDetail(err).toLowerCase().includes('no events');
}

interface InvestigateProps {
  api: TlsocApi;
  /** Selected case id (drives the selected-card ring); detail opens in the flyout. */
  selectedCaseId: string | null;
  /** Open a case in the global detail flyout. */
  onOpenCase: (caseId: string) => void;
  /** Bumped by the app when a case changes elsewhere; triggers a re-fetch. */
  refreshSignal?: number;
}

export const Investigate: React.FC<InvestigateProps> = ({
  api,
  selectedCaseId,
  onOpenCase,
  refreshSignal,
}) => {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // BUG-2: NEUTRAL "no events found" outcome — info empty-state, not a red error.
  const [notice, setNotice] = useState<string | null>(null);
  const [investigating, setInvestigating] = useState(false);

  // manual investigation inputs
  const [manualType, setManualType] = useState<Entity['type']>('ip');
  const [manualValue, setManualValue] = useState('');

  const loadCases = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get<{ cases: Case[]; total: number }>('cases', { limit: 100 });
      setCases(resp.cases || []);
    } catch (e) {
      setError(errorDetail(e));
    } finally {
      setLoading(false);
    }
  };

  // Initial load + whenever the app signals a change from the flyout.
  useEffect(() => {
    loadCases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  /**
   * PAID investigation. Only call on an explicit user action (the search box's
   * Investigate button / Enter). Opens the resulting case in the flyout.
   */
  const investigate = async (entity: Entity, group_by: Entity['type']) => {
    setInvestigating(true);
    setError(null);
    setNotice(null);
    try {
      const theCase = await api.post<Case>('investigate', {
        entity,
        group_by,
        source_surface: 'investigate',
      });
      await loadCases();
      if (theCase && theCase.case_id) {
        onOpenCase(theCase.case_id);
      }
    } catch (e) {
      // BUG-2: a NEUTRAL 400 ("No events found for ...") is an empty-state, not
      // a failure. Only real 5xx / unexpected errors render as danger.
      if (isNoEventsError(e)) {
        setNotice(errorDetail(e));
      } else {
        setError(errorDetail(e));
      }
    } finally {
      setInvestigating(false);
    }
  };

  const runManualInvestigate = () => {
    const value = manualValue.trim();
    if (value) {
      investigate({ type: manualType, value }, manualType);
    }
  };

  return (
    <div>
      <SectionHeader
        title="Security Investigation"
        description="Triage emerging threats and analyze entity behavior across the infrastructure."
      />

      {error ? (
        <>
          <EuiCallOut color="danger" size="s" title={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {/* BUG-2: NEUTRAL no-events outcome — info, not an error. */}
      {notice ? (
        <>
          <EuiCallOut color="primary" size="s" iconType="iInCircle" title="No events found">
            <p>{notice}</p>
          </EuiCallOut>
          <EuiSpacer size="m" />
        </>
      ) : null}

      {/* Manual entry: investigate by IP / user / host. */}
      <EuiPanel hasBorder paddingSize="l">
        <MetaLabel>Investigate by IP / user / host</MetaLabel>
        <EuiSpacer size="s" />
        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
          <EuiFlexItem grow={false} style={{ minWidth: 150 }}>
            <EuiSelect
              value={manualType}
              onChange={(e) => setManualType(e.target.value as Entity['type'])}
              options={[
                { value: 'ip', text: 'IP Address' },
                { value: 'user', text: 'User' },
                { value: 'host', text: 'Host' },
              ]}
              aria-label="Entity type"
            />
          </EuiFlexItem>
          <EuiFlexItem style={{ minWidth: 240 }}>
            <EuiFieldSearch
              fullWidth
              placeholder="Enter entity identifier (e.g. 10.130.171.247 or j.doe)..."
              value={manualValue}
              isClearable
              onChange={(e) => setManualValue(e.target.value)}
              onSearch={(v) => {
                const value = v.trim();
                if (value) {
                  investigate({ type: manualType, value }, manualType);
                }
              }}
              aria-label="Entity identifier"
            />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButton fill isLoading={investigating} isDisabled={!manualValue.trim()} onClick={runManualInvestigate}>
              Investigate
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>

      <EuiSpacer size="l" />

      <CaseGrid
        cases={cases}
        loading={loading}
        onRefresh={loadCases}
        selectedCaseId={selectedCaseId}
        onOpenCase={onOpenCase}
        countNoun="alerts"
        emptyTitle="No cases yet"
        emptyBody="Investigate an entity above to open one."
      />
    </div>
  );
};
