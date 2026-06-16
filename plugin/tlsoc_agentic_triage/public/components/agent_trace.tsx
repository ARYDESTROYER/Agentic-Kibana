import React, { useCallback, useEffect, useState } from 'react';
import {
  EuiAvatar,
  EuiBadge,
  EuiCallOut,
  EuiCodeBlock,
  EuiComment,
  EuiCommentList,
  EuiLoadingSpinner,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { TraceResponse, TraceStep } from '../../common';
import type { TlsocApi } from '../lib/api';

interface AgentTraceProps {
  api: TlsocApi;
  caseId: string;
  /** Bumped by the parent after a (re-)investigation so the trace re-fetches. */
  refreshKey?: number;
}

/** Per-actor presentation. Actors mirror the backend audit `actor` field:
 * poller / router / investigator / formatter / case_manager / pipeline.
 * Colors are hex so they are valid `EuiAvatar` background colors (named EUI
 * colors are not accepted by EuiAvatar.color). */
type ActorStyle = { icon: string; color: string; label: string };

function actorStyle(actor?: string): ActorStyle {
  switch ((actor || '').toLowerCase()) {
    case 'poller':
      return { icon: 'clock', color: '#98a2b3', label: 'Poller' };
    case 'router':
      return { icon: 'branch', color: '#0077cc', label: 'Router' };
    case 'investigator':
      return { icon: 'inspect', color: '#bd271e', label: 'Investigator' };
    case 'formatter':
      return { icon: 'documentEdit', color: '#017d73', label: 'Formatter' };
    case 'case_manager':
      return { icon: 'gear', color: '#f5a700', label: 'Case manager' };
    case 'pipeline':
      return { icon: 'logstashIf', color: '#69707d', label: 'Pipeline' };
    default:
      return { icon: 'dot', color: '#98a2b3', label: actor || 'agent' };
  }
}

function actionLabel(actionType?: string): string {
  switch ((actionType || '').toLowerCase()) {
    case 'prompt':
      return 'LLM prompt';
    case 'es_query':
      return 'ES query';
    case 'tool_call':
      return 'Tool call';
    case 'verdict':
      return 'Verdict';
    case 'decision':
      return 'Decision';
    case 'error':
      return 'Error';
    case 'poll':
      return 'Poll';
    case 'scan':
      return 'Scan';
    default:
      return actionType || 'step';
  }
}

/**
 * C3-3 — Agent-pipeline trace timeline. Fetches the projected audit rows for a
 * case (`GET /cases/{id}/trace`) and renders them as an `EuiCommentList`.
 *
 * SECURITY (non-negotiable #9): `prompt_excerpt` and `tool_output_summary` carry
 * fenced UNTRUSTED log data and are rendered ONLY inside `<EuiCodeBlock>` — never
 * as markdown or HTML.
 */
export const AgentTrace: React.FC<AgentTraceProps> = ({ api, caseId, refreshKey }) => {
  const [steps, setSteps] = useState<TraceStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTrace = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get<TraceResponse>('cases/' + caseId + '/trace');
      setSteps(Array.isArray(resp.steps) ? resp.steps : []);
    } catch (e) {
      setError((e as Error).message || 'Could not load agent trace');
      setSteps([]);
    } finally {
      setLoading(false);
    }
  }, [api, caseId]);

  useEffect(() => {
    fetchTrace();
  }, [fetchTrace, refreshKey]);

  if (loading) {
    return (
      <EuiText size="s" color="subdued">
        <EuiLoadingSpinner size="m" /> Loading agent trace…
      </EuiText>
    );
  }

  if (error) {
    // The endpoint never 404s; a failure here is a real error.
    return (
      <EuiCallOut color="danger" size="s" title="Could not load agent trace">
        <p>{error}</p>
      </EuiCallOut>
    );
  }

  if (!steps.length) {
    return (
      <EuiText size="s" color="subdued">
        <p>No agent activity recorded yet.</p>
      </EuiText>
    );
  }

  return (
    <EuiCommentList aria-label="Agent pipeline trace">
      {steps.map((step, i) => {
        const style = actorStyle(step.actor);
        const summary = (step.result_summary || '').trim();
        const hasQuery = !!(step.query_text && step.query_text.trim());
        const hasToolOutput = !!(step.tool_output_summary && step.tool_output_summary.trim());
        const hasPrompt = !!(step.prompt_excerpt && step.prompt_excerpt.trim());

        const event = (
          <EuiText size="xs">
            <span>{actionLabel(step.action_type)}</span>
            {step.tool_name ? (
              <>
                {' '}
                <EuiBadge color="hollow">{step.tool_name}</EuiBadge>
              </>
            ) : null}
            {step.model ? (
              <>
                {' '}
                <EuiBadge color="default">{step.model}</EuiBadge>
              </>
            ) : null}
          </EuiText>
        );

        return (
          <EuiComment
            key={i}
            username={style.label}
            timelineAvatar={
              <EuiAvatar
                name={style.label}
                iconType={style.icon}
                color={style.color}
                iconColor="#ffffff"
                size="m"
              />
            }
            timelineAvatarAriaLabel={style.label}
            event={event}
            timestamp={step.ts || undefined}
          >
            {summary ? (
              <EuiText size="s">
                <p>{summary}</p>
              </EuiText>
            ) : null}

            {hasQuery ? (
              <>
                <EuiSpacer size="xs" />
                <EuiText size="xs" color="subdued">
                  <strong>Query</strong>
                </EuiText>
                {/* UNTRUSTED — never render query text as markup. */}
                <EuiCodeBlock language="sql" fontSize="s" paddingSize="s" isCopyable>
                  {step.query_text}
                </EuiCodeBlock>
              </>
            ) : null}

            {hasToolOutput ? (
              <>
                <EuiSpacer size="xs" />
                <EuiText size="xs" color="subdued">
                  <strong>Tool output</strong>
                </EuiText>
                {/* UNTRUSTED log-derived data — fenced inside a code block only. */}
                <EuiCodeBlock fontSize="s" paddingSize="s" isCopyable>
                  {step.tool_output_summary}
                </EuiCodeBlock>
              </>
            ) : null}

            {hasPrompt ? (
              <>
                <EuiSpacer size="xs" />
                <EuiText size="xs" color="subdued">
                  <strong>Prompt excerpt</strong>
                </EuiText>
                {/* UNTRUSTED — fenced prompt content; code block only. */}
                <EuiCodeBlock fontSize="s" paddingSize="s" isCopyable>
                  {step.prompt_excerpt}
                </EuiCodeBlock>
              </>
            ) : null}
          </EuiComment>
        );
      })}
    </EuiCommentList>
  );
};
