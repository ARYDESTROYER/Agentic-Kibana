/**
 * CaseDetail — Collaboration vs Feedback tab wiring (Wave-0 swap/duplication fix).
 *
 * Regression lock for a mis-wiring where the Collaboration and Feedback tabs had
 * their value/label/rendered-component out of agreement, and the Feedback surface
 * duplicated the Collaboration tab's ownership + notes content. This spec pins:
 *
 *   1. Each TabsTrigger's `value` matches its label:
 *        value="collab"   ↔ "Collaboration"
 *        value="feedback" ↔ "Feedback"
 *   2. Each TabsContent renders the RIGHT, DISTINCT component:
 *        collab   → <CollaborationThreadTab>  (threads / tasks / ownership — ONE surface)
 *        feedback → <FeedbackTab>             (AI-decision grading ONLY)
 *      and the two components are DIFFERENT (no shared/duplicated surface).
 *   3. The Feedback tab does NOT duplicate the Collaboration ownership+notes block:
 *      the grading-only FeedbackTab carries no thread/task/assignee props, and the
 *      source documents the no-duplication contract.
 *
 * Static source assertions (same approach as CaseDetail.live.test.tsx): CaseDetail
 * is a large sheet with heavy prop/api coupling, so we assert the wiring on the
 * source of truth rather than fully mounting it. #9 is unaffected (no rendering of
 * attacker-influenceable text is introduced here).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync(path.resolve(__dirname, '..', 'CaseDetail.tsx'), 'utf8');

/** Slice from the first occurrence of `needle` to the next `end` (exclusive). */
function slice(needle: string, end: string): string {
  const i = src.indexOf(needle);
  expect(i, `expected to find "${needle}"`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + needle.length);
  return src.slice(i, j === -1 ? src.length : j);
}

describe('CaseDetail — Collaboration / Feedback tab wiring', () => {
  it('each TabsTrigger value matches its human label', () => {
    // The Collaboration trigger carries value="collab".
    const collabTrigger = slice('value="collab"', 'TabsTrigger>');
    expect(collabTrigger).toMatch(/Collaboration/);
    expect(collabTrigger).not.toMatch(/Feedback/);

    // The Feedback trigger carries value="feedback".
    const feedbackTrigger = slice('value="feedback"', 'TabsTrigger>');
    expect(feedbackTrigger).toMatch(/Feedback/);
    expect(feedbackTrigger).not.toMatch(/Collaboration/);
  });

  it('each TabsContent renders the correct, DISTINCT component (no duplication)', () => {
    const collabContent = slice(
      '<TabsContent value="collab"',
      '</TabsContent>',
    );
    const feedbackContent = slice(
      '<TabsContent value="feedback"',
      '</TabsContent>',
    );

    // Collaboration → the thread/tasks/ownership surface.
    expect(collabContent).toMatch(/<CollaborationThreadTab/);
    // Feedback → the grading-only surface.
    expect(feedbackContent).toMatch(/<FeedbackTab/);

    // The two tabs render DIFFERENT components — no shared/duplicated surface.
    expect(collabContent).not.toMatch(/<FeedbackTab/);
    expect(feedbackContent).not.toMatch(/<CollaborationThreadTab/);

    // Exactly one Collaboration surface and exactly one Feedback surface.
    expect((src.match(/<CollaborationThreadTab\b/g) || []).length).toBe(1);
    expect((src.match(/<FeedbackTab\b/g) || []).length).toBe(1);
  });

  it('the Feedback tab does NOT duplicate the Collaboration ownership+notes block', () => {
    // The grading-only FeedbackTab receives ONLY the case + an onUpdated callback —
    // none of the thread/task/assignee wiring that the Collaboration tab owns.
    const feedbackContent = slice(
      '<TabsContent value="feedback"',
      '</TabsContent>',
    );
    expect(feedbackContent).not.toMatch(/thread=/);
    expect(feedbackContent).not.toMatch(/tasks=/);
    expect(feedbackContent).not.toMatch(/onAssigned=/);
    expect(feedbackContent).not.toMatch(/onPost=/);

    // The FeedbackTab component is scoped to AI-decision grading (submits feedback),
    // and is a SEPARATE component from the thread tab.
    expect(src).toMatch(/const FeedbackTab: React\.FC<\{/);
    expect(src).toMatch(/const CollaborationThreadTab: React\.FC<\{/);

    // The no-duplication contract is documented at the FeedbackTab body.
    const feedbackBody = slice('const FeedbackTab: React.FC<{', 'const ChatTab');
    expect(feedbackBody).toMatch(/no duplication/i);
    expect(feedbackBody).toMatch(/api\.caseFeedback/);
  });

  it('the misleading legacy component name is gone (grading tab is FeedbackTab, not CollaborationTab)', () => {
    // A bare `CollaborationTab` (word boundary — excludes CollaborationThreadTab)
    // must no longer exist; it was the source of the swap confusion.
    expect(src).not.toMatch(/\bCollaborationTab\b/);
  });
});
