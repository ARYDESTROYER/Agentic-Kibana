/**
 * CaseDetail — 5-tab story shell (Round-7 #9a: 8 → 5 tabs; task 5: rename Investigation
 * → Timeline).
 *
 * The old 8-tab shell (Overview / Timeline / Why / Threat / Trace / Collaboration /
 * Feedback / Chat) collapsed into a 5-tab story spine, and the merged investigation tab
 * was renamed to Timeline (task 5) and sits right after Overview:
 *
 *     overview · timeline · threat · collab · chat
 *
 * The Timeline tab's panel is still <InvestigationPanel> — the Timeline + Why + Trace
 * panels compose INSIDE it (Facts "What happened" → AI assessment → pinned deterministic
 * DecisionCard + a collapsible full trace). The standalone Feedback tab was retired
 * (grading folds into the close dialog; the aggregate stays in Metrics). This spec pins:
 *
 *   1. The `tab` union is EXACTLY the 5 story tabs — the removed values are gone.
 *   2. Exactly 5 <TabsTrigger>, each `value` matching its human label.
 *   3. Each <TabsContent> renders the RIGHT, DISTINCT panel; the merged sub-panels
 *      (StageTimeline / WhyPanel / TraceTimeline) and the retired FeedbackTab are NOT
 *      mounted directly in the shell.
 *   4. <InvestigationPanel> is wired the stages / rationale / timeline state + retries,
 *      and those payloads lazy-load on the `timeline` tab (so the DecisionCard can
 *      read its policy clause).
 *   5. The header carries a self-hiding <AutoClosedBadge> (Round-7 #11).
 *
 * CaseDetail is a large sheet with heavy prop/api coupling, so — like the sibling
 * CaseDetail.*.test.tsx specs — these are STATIC assertions on the orchestrator source
 * (the load-bearing tab wiring), not a full mount. #9 is unaffected (no
 * attacker-influenceable text is rendered here).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync(path.resolve(__dirname, '..', 'CaseDetail.tsx'), 'utf8');

/** Slice from the first occurrence of `needle` to the next `end` (exclusive). */
function slice(text: string, needle: string, end: string): string {
  const i = text.indexOf(needle);
  expect(i, `expected to find "${needle}"`).toBeGreaterThan(-1);
  const j = text.indexOf(end, i + needle.length);
  return text.slice(i, j === -1 ? text.length : j);
}

const TAB_VALUES = ['overview', 'timeline', 'threat', 'collab', 'chat'] as const;
const REMOVED_TABS = ['investigation', 'why', 'trace', 'feedback'] as const;

/** value → expected human label + the panel component mounted for it. */
const TAB_LABEL: Record<(typeof TAB_VALUES)[number], string> = {
  overview: 'Overview',
  timeline: 'Timeline',
  threat: 'Threat context',
  collab: 'Collaboration',
  chat: 'Chat',
};
const TAB_PANEL: Record<(typeof TAB_VALUES)[number], string> = {
  overview: 'OverviewPanel',
  timeline: 'InvestigationPanel',
  threat: 'ThreatContextPanel',
  collab: 'CollaborationThreadTab',
  chat: 'ChatTab',
};

describe('CaseDetail — 5-tab story shell', () => {
  it('the tab union is exactly the 5 story tabs (the removed 4 are gone)', () => {
    const union = slice(src, 'const [tab, setTab] = React.useState<', ">('overview')");
    for (const v of TAB_VALUES) expect(union, `union should include '${v}'`).toContain(`'${v}'`);
    for (const v of REMOVED_TABS) {
      expect(union, `union should NOT include the removed '${v}'`).not.toContain(`'${v}'`);
    }
  });

  it('renders exactly 5 TabsTrigger, each value matching its human label', () => {
    const tabsList = slice(src, '<TabsList', '</TabsList>');
    const triggers = tabsList.match(/<TabsTrigger value="[^"]+"/g) || [];
    expect(triggers.length).toBe(5);

    for (const v of TAB_VALUES) {
      const trigger = slice(tabsList, `value="${v}"`, 'TabsTrigger>');
      expect(trigger, `trigger '${v}' should be labeled "${TAB_LABEL[v]}"`).toContain(
        TAB_LABEL[v],
      );
    }
    // No stale trigger for a removed tab.
    for (const v of REMOVED_TABS) {
      expect(tabsList).not.toContain(`value="${v}"`);
    }
  });

  it('each TabsContent mounts the correct, DISTINCT panel', () => {
    for (const v of TAB_VALUES) {
      const content = slice(src, `<TabsContent value="${v}"`, '</TabsContent>');
      expect(content, `TabsContent '${v}' should mount <${TAB_PANEL[v]}>`).toContain(
        `<${TAB_PANEL[v]}`,
      );
    }
    // Exactly one mount site per panel.
    for (const comp of Object.values(TAB_PANEL)) {
      expect((src.match(new RegExp(`<${comp}\\b`, 'g')) || []).length).toBe(1);
    }
  });

  it('the merged sub-panels + retired Feedback tab are not mounted in the shell', () => {
    // StageTimeline / WhyPanel / TraceTimeline now live INSIDE <InvestigationPanel>,
    // not as standalone tabs; FeedbackTab was retired entirely.
    for (const gone of ['StageTimeline', 'WhyPanel', 'TraceTimeline', 'FeedbackTab']) {
      expect(src, `${gone} must not be referenced by the shell`).not.toContain(gone);
    }
  });

  it('InvestigationPanel is wired the stages/rationale/timeline state + retries', () => {
    const content = slice(src, '<TabsContent value="timeline"', '</TabsContent>');
    for (const prop of [
      'stages={stages}',
      'onRetryStages={loadStages}',
      'rationale={rationale}',
      'onRetryRationale={loadRationale}',
      'timeline={timeline}',
      'onRetryTimeline={loadTimeline}',
    ]) {
      expect(content, `investigation panel should receive ${prop}`).toContain(prop);
    }
  });

  it('stages/rationale/timeline lazy-load on the timeline tab', () => {
    // Each lazy effect fires on tab === 'timeline' with an error guard so a failed
    // fetch never re-fires forever.
    expect(src).toContain(
      "tab === 'timeline' && stages === null && !stagesLoading && !stagesError",
    );
    expect(src).toContain(
      "tab === 'timeline' && rationale === null && !rationaleLoading && !rationaleError",
    );
    expect(src).toContain(
      "tab === 'timeline' && timeline === null && !timelineLoading && !timelineError",
    );
    // No lingering effect keyed on a removed tab value.
    for (const v of REMOVED_TABS) {
      expect(src).not.toContain(`tab === '${v}'`);
    }
  });

  it('the header carries a self-hiding AutoClosedBadge (Round-7 #11)', () => {
    expect(src).toContain(
      '<AutoClosedBadge status={c.status} decisionBy={c.decision_by} />',
    );
    // It is imported from the shared badges module.
    expect(src).toMatch(
      /import \{[^}]*AutoClosedBadge[^}]*\} from '@\/soc\/components\/badges'/,
    );
  });

  it('the header History control targets the Timeline tab', () => {
    const historyBtn = slice(src, 'aria-label="Timeline"', 'Button>');
    expect(historyBtn).toContain("setTab('timeline')");
  });
});
