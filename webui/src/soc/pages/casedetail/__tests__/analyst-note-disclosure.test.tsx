/**
 * THE ANALYST-COMMENT DISCLOSURE.
 *
 * A note written on a close / confirm-FP, and a comment written on the AI grading, are
 * both carried into `index_resolved_case`: they are embedded in the resolved-case
 * precedent chunk and read back by the investigator on every future retrieval that
 * matches. In production an ordinary operational aside ("Backfill: confirming agent
 * FALSE_POSITIVE disposition…") became durable evidence and depressed investigator
 * confidence to just under the auto-close bar, so nothing closed. The text was
 * well-formed — its MEANING was the problem — so sanitising could never have fixed it.
 * The only real fix is telling the analyst, where they type, what the note becomes.
 *
 * This spec pins that the label is present on exactly the flows that persist the text:
 *   (a) the close-with-disposition dialog (wire verb `close`);
 *   (b) the confirm-false-positive dialog;
 *   (c) the grading "What did the AI miss?" comment;
 *   (d) and NOT on a lifecycle action whose note is never indexed (escalate/hold).
 * It also pins the note field is programmatically described by the label (a11y).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ConfirmActionDialog } from '../ConfirmActionDialog';
import { GradingFields } from '../grading';
import { ALL_ACTIONS, DURABLE_CONTEXT_NOTE, type ActionKind } from '../shared';

function renderDialog(action: ActionKind) {
  const noop = vi.fn();
  return render(
    <ConfirmActionDialog
      pending={ALL_ACTIONS[action]}
      acting={false}
      onClose={noop}
      onSubmit={noop}
      note=""
      onNoteChange={noop}
      resolution=""
      onResolutionChange={noop}
      priority=""
      onPriorityChange={noop}
      assignee=""
      onAssigneeChange={noop}
      tags={[]}
      onTagsChange={noop}
      tagDraft=""
      onTagDraftChange={noop}
      disposition=""
      onDispositionChange={noop}
      reason=""
      onReasonChange={noop}
      verdict="FALSE_POSITIVE"
      grading={{}}
      onGradingChange={noop}
    />,
  );
}

describe('analyst-comment disclosure', () => {
  it('states the note becomes durable AI-visible context', () => {
    // Concise, factual, and about the durable/AI-read consequence — a label, not a
    // warning banner (no "careful"/"warning"/"danger" framing).
    expect(DURABLE_CONTEXT_NOTE).toMatch(/durable context/i);
    expect(DURABLE_CONTEXT_NOTE).toMatch(/AI reads/i);
    expect(DURABLE_CONTEXT_NOTE).toMatch(/similar cases/i);
    expect(DURABLE_CONTEXT_NOTE.length).toBeLessThan(200);
  });

  it('labels the analyst note on the unified close-with-disposition flow', () => {
    renderDialog('close_disposition');

    const note = screen.getByLabelText('Analyst note (optional)');
    expect(screen.getByText(DURABLE_CONTEXT_NOTE)).toBeInTheDocument();
    expect(note).toHaveAccessibleDescription(DURABLE_CONTEXT_NOTE);
  });

  it('labels the analyst note on confirm-false-positive', () => {
    renderDialog('confirm_fp');
    expect(screen.getByText(DURABLE_CONTEXT_NOTE)).toBeInTheDocument();
  });

  it('labels the analyst note on the plain close action', () => {
    renderDialog('close');
    expect(screen.getByText(DURABLE_CONTEXT_NOTE)).toBeInTheDocument();
  });

  it('does not claim durability for a note that is never indexed', () => {
    renderDialog('escalate');
    expect(screen.getByLabelText('Analyst note (optional)')).toBeInTheDocument();
    expect(screen.queryByText(DURABLE_CONTEXT_NOTE)).toBeNull();
  });

  it('labels the AI-grading comment, which is posted to case feedback and re-indexed', () => {
    render(
      <GradingFields
        verdict="FALSE_POSITIVE"
        disposition="true_positive"
        draft={{}}
        onChange={vi.fn()}
      />,
    );

    const miss = screen.getByLabelText('What did the AI miss? (optional)');
    expect(screen.getByText(DURABLE_CONTEXT_NOTE)).toBeInTheDocument();
    expect(miss).toHaveAccessibleDescription(DURABLE_CONTEXT_NOTE);
  });
});
