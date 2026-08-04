/**
 * RulePreviewPanel spec (Round-5 G6 · R5) — the read-only, NO-COST rule preview.
 *
 * THE load-bearing assertion for this wave: running a preview hits ONLY the pure,
 * read-only `api.rules.preview` path — it NEVER calls any LLM / case-mutating path
 * (`chat` / `investigate` / `reinvestigateCase` / `runPlaybook` / `caseAction` /
 * `bulkCases`), so it bills ZERO UsageDoc (#6) and never closes/escalates a case (#3).
 * It also renders the match count + histogram from the pure endpoint's result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';

// Spy every method the panel COULD reach. `rules.preview` is the ONLY one it may call;
// the LLM/close/mutating spies must stay untouched (the no-cost / #3 guarantee).
// `vi.hoisted` lets these be referenced inside the hoisted `vi.mock` factory.
const {
  previewSpy,
  previewDecisionSpy,
  chatSpy,
  investigateSpy,
  reinvestigateSpy,
  runPlaybookSpy,
  caseActionSpy,
  bulkCasesSpy,
} = vi.hoisted(() => ({
  previewSpy: vi.fn(async () => ({
    scanned: 1000,
    matched: 42,
    match_rate: 0.042,
    histogram: [
      { bucket: '2026-07-01T00:00:00+00:00', count: 20 },
      { bucket: '2026-07-01T12:00:00+00:00', count: 22 },
    ],
    sample: [],
    predicates: 1,
    predicates_evaluated: 1,
    hard_capped: false,
  })),
  previewDecisionSpy: vi.fn(),
  chatSpy: vi.fn(),
  investigateSpy: vi.fn(),
  reinvestigateSpy: vi.fn(),
  runPlaybookSpy: vi.fn(),
  caseActionSpy: vi.fn(),
  bulkCasesSpy: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    rules: { preview: previewSpy, versions: vi.fn(), rollback: vi.fn() },
    triage: { previewDecision: previewDecisionSpy },
    chat: chatSpy,
    investigate: investigateSpy,
    reinvestigateCase: reinvestigateSpy,
    runPlaybook: runPlaybookSpy,
    caseAction: caseActionSpy,
    bulkCases: bulkCasesSpy,
  },
}));

import { RulePreviewPanel } from '../RulePreviewPanel';
import type { RuleForm } from '../../types';

const MATCH_RULE: RuleForm = {
  tier: 'detection_match',
  about: { name: 'ssh-bruteforce', description: '', enabled: true, priority: 100 },
  predicates: [{ field: 'rule.id', op: 'equals', value: '5710' }],
  threshold: { groupBy: 'ip', n: 5, windowSeconds: 120, mode: 'threshold' },
};

const AUTOMATION_RULE: RuleForm = {
  tier: 'case_automation',
  about: { name: 'tagger', description: '', enabled: true, priority: 50 },
  automation: { conditions: {}, action: 'tag', payload: { tags: ['x'] } },
};

function renderPanel(rule: RuleForm = MATCH_RULE) {
  return render(
    <TooltipProvider>
      <RulePreviewPanel rule={rule} />
    </TooltipProvider>,
  );
}

describe('RulePreviewPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs the preview through the READ-ONLY rules.preview path only (no LLM, no close)', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /run preview/i }));

    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(1));

    // it sent the flat predicate + a bounded look-back window (7d default) to the RO endpoint
    const arg = previewSpy.mock.calls[0][0];
    expect(arg.match).toEqual([{ field: 'rule.id', op: 'equals', value: '5710' }]);
    expect(String(arg.from)).toMatch(/^now-7d$/);

    // ⛔ the whole point: NO LLM / case-mutating / close path was ever invoked.
    expect(previewDecisionSpy).not.toHaveBeenCalled(); // no what-if decision fired on a preview
    expect(chatSpy).not.toHaveBeenCalled();
    expect(investigateSpy).not.toHaveBeenCalled();
    expect(reinvestigateSpy).not.toHaveBeenCalled();
    expect(runPlaybookSpy).not.toHaveBeenCalled();
    expect(caseActionSpy).not.toHaveBeenCalled();
    expect(bulkCasesSpy).not.toHaveBeenCalled();
  });

  it('renders the match count + histogram from the pure result', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /run preview/i }));
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument());
    // the "matched" summary word + the scanned total render from the pure result
    expect(screen.getByText('matched')).toBeInTheDocument();
    expect(screen.getByText('1,000')).toBeInTheDocument();
    // the histogram is rendered as an accessible recharts image
    expect(screen.getByRole('img', { name: /match-count histogram/i })).toBeInTheDocument();
  });

  it('never offers a scan for a case-automation rule (no predicate to preview)', () => {
    renderPanel(AUTOMATION_RULE);
    expect(screen.getByText(/preview is for detection rules/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run preview/i })).not.toBeInTheDocument();
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('projects only the authoritative first predicate from a legacy multi-row draft', async () => {
    // Old local drafts may still carry extra rows. Normal authoring cannot create them,
    // and preview must match the single-predicate wire contract exactly.
    const MULTI: RuleForm = {
      ...MATCH_RULE,
      predicates: [
        { field: 'rule.id', op: 'equals', value: '5710' },
        { field: 'source.ip', op: 'equals', value: '10.0.0.1' },
        { field: 'user.name', op: 'equals', value: 'root' },
      ],
    };
    renderPanel(MULTI);
    fireEvent.click(screen.getByRole('button', { name: /run preview/i }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(1));
    expect(previewSpy.mock.calls[0][0].match).toEqual([
      { field: 'rule.id', op: 'equals', value: '5710' },
    ]);
  });
});
