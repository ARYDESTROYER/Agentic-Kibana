import React, { useEffect, useState } from 'react';
import { EuiCallOut, EuiSpacer } from '@elastic/eui';
import type { Case } from '../../common';
import type { TlsocApi } from '../lib/api';
import { SectionHeader } from './ui';
import { CaseGrid } from './case_grid';

interface ScansProps {
  api: TlsocApi;
  /** Selected case id (drives the selected-card ring); detail opens in the flyout. */
  selectedCaseId?: string | null;
  /** Open a case in the global detail flyout. */
  onOpenCase: (caseId: string) => void;
  /** Bumped by the app when a case changes elsewhere; triggers a re-fetch. */
  refreshSignal?: number;
}

/**
 * Automated Scans — the cases the agent opened on its own from background
 * correlation. Same card + grid + flyout as Investigate; the data source is the
 * `scans` endpoint and the per-case detail (trigger reason, reproduce, etc.) lives
 * in the shared detail flyout.
 */
export const Scans: React.FC<ScansProps> = ({ api, selectedCaseId, onOpenCase, refreshSignal }) => {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadScans = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get<{ cases: Case[]; total: number }>('scans', { limit: 100 });
      setCases(resp.cases || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadScans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  return (
    <div>
      <SectionHeader
        icon="inspect"
        title="Automated Scans"
        description="Cases the agent opened automatically from background correlation. Open one to review at no LLM cost."
      />

      {error ? (
        <>
          <EuiCallOut color="danger" size="s" title={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}

      <CaseGrid
        cases={cases}
        loading={loading}
        onRefresh={loadScans}
        selectedCaseId={selectedCaseId}
        onOpenCase={onOpenCase}
        headerTitle="Scan results"
        countNoun="scans"
        emptyTitle="No automated scans yet"
        emptyBody="When background scanning is enabled, the agent opens cases here automatically."
      />
    </div>
  );
};
