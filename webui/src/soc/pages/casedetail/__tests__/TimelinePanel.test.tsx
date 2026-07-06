/**
 * TimelinePanel — the clean "what happened" narrative (task 5 split).
 *
 * The Timeline tab now holds ONLY the six-stage <StageTimeline> narrative — no AI
 * assessment, no DecisionCard, no ReAct trace (those moved to <InvestigationPanel>).
 * Verifies the "what happened" header + the stage story render, and that the
 * loading/error states pass through.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import { TimelinePanel } from '../TimelinePanel';
import type { TimelineStagesResponse } from '@/soc/pages/CaseDetail.api';

expect.extend(toHaveNoViolations);

const STAGES: TimelineStagesResponse = {
  case_id: 'c1',
  total: 1,
  stages: [
    {
      id: 'input',
      kind: 'input',
      label: 'Alert received',
      status: 'done',
      deterministic: false,
      headline: 'Six alerts from Lab Elastic',
      state: {},
      steps: [],
    },
  ],
};

describe('TimelinePanel — the "what happened" narrative', () => {
  it('renders the "What happened" header and the stage story', () => {
    render(
      <TimelinePanel
        stages={STAGES}
        stagesLoading={false}
        stagesError={null}
        onRetryStages={vi.fn()}
      />,
    );
    expect(screen.getByText('What happened')).toBeInTheDocument();
    expect(screen.getByText('Six alerts from Lab Elastic')).toBeInTheDocument();
  });

  it('does NOT render the AI assessment / decision / trace (those live on Investigation)', () => {
    render(
      <TimelinePanel
        stages={STAGES}
        stagesLoading={false}
        stagesError={null}
        onRetryStages={vi.fn()}
      />,
    );
    expect(screen.queryByText('AI assessment')).toBeNull();
    expect(screen.queryByText('Deterministic decision')).toBeNull();
    expect(screen.queryByRole('button', { name: /full agent trace/i })).toBeNull();
  });

  it('passes a loading state through to the stage timeline (skeleton)', () => {
    render(
      <TimelinePanel
        stages={null}
        stagesLoading
        stagesError={null}
        onRetryStages={vi.fn()}
      />,
    );
    // The header is always present; the stage body shows the loading skeleton (no story).
    expect(screen.getByText('What happened')).toBeInTheDocument();
    expect(screen.queryByText('Six alerts from Lab Elastic')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <TimelinePanel
        stages={STAGES}
        stagesLoading={false}
        stagesError={null}
        onRetryStages={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
