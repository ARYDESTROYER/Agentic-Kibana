import React from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiDescriptionList,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { Case } from '../../common';
import type { OpenInDiscover } from '../lib/discover';

interface VerdictCardProps {
  theCase: Case;
  openInDiscover: OpenInDiscover;
}

function verdictColor(verdict?: string): 'danger' | 'success' | 'warning' | 'default' {
  const v = (verdict || '').toUpperCase();
  if (v.includes('TRUE')) return 'danger';
  if (v.includes('FALSE')) return 'success';
  if (v.includes('INCONCLUSIVE') || v.includes('UNKNOWN')) return 'warning';
  return 'default';
}

export const VerdictCard: React.FC<VerdictCardProps> = ({ theCase, openInDiscover }) => {
  const c = theCase;
  return (
    <EuiPanel hasBorder>
      <EuiFlexGroup alignItems="center" gutterSize="m" wrap>
        <EuiFlexItem grow={false}>
          <EuiTitle size="s">
            <h3>{c.title || `Case ${c.case_id}`}</h3>
          </EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiBadge color={verdictColor(c.verdict)}>{c.verdict || 'UNKNOWN'}</EuiBadge>
        </EuiFlexItem>
        {typeof c.confidence === 'number' ? (
          <EuiFlexItem grow={false}>
            <EuiBadge color="hollow">confidence {(c.confidence * 100).toFixed(0)}%</EuiBadge>
          </EuiFlexItem>
        ) : null}
        {typeof c.risk_score === 'number' ? (
          <EuiFlexItem grow={false}>
            <EuiBadge color="hollow">risk {c.risk_score}</EuiBadge>
          </EuiFlexItem>
        ) : null}
      </EuiFlexGroup>

      {c.summary ? (
        <>
          <EuiSpacer size="s" />
          <EuiText size="s">
            <p>{c.summary}</p>
          </EuiText>
        </>
      ) : null}

      {c.evidence && c.evidence.length > 0 ? (
        <>
          <EuiSpacer size="m" />
          <EuiTitle size="xs">
            <h4>Evidence</h4>
          </EuiTitle>
          <EuiSpacer size="xs" />
          <ul>
            {c.evidence.map((ev, i) => (
              <li key={i}>
                <EuiText size="s">
                  <p>{ev.summary}</p>
                </EuiText>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {c.mitre && c.mitre.length > 0 ? (
        <>
          <EuiSpacer size="s" />
          <EuiFlexGroup gutterSize="xs" wrap responsive={false}>
            {c.mitre.map((m, i) => (
              <EuiFlexItem grow={false} key={i}>
                <EuiBadge color="accent">{m}</EuiBadge>
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
        </>
      ) : null}

      {c.recommended_action ? (
        <>
          <EuiSpacer size="m" />
          <EuiDescriptionList
            type="column"
            compressed
            listItems={[{ title: 'Recommended action', description: c.recommended_action }]}
          />
        </>
      ) : null}

      {c.reproduce_query ? (
        <>
          <EuiSpacer size="m" />
          <EuiButton
            size="s"
            iconType="discoverApp"
            onClick={() => openInDiscover(c.reproduce_query as string)}
          >
            Reproduce in Discover
          </EuiButton>
        </>
      ) : null}
    </EuiPanel>
  );
};
