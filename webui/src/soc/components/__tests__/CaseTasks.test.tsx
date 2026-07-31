/**
 * CaseTasks — status Select ↔ badge agreement (Round-6 finding #24).
 *
 * The status <Select> options are the lowercase canonical set, but `task.status` is
 * typed to allow any string (and the backend may return "Done"/"OPEN"/unknown). The
 * badge already lowercases + defaults via statusMeta(); the Select must do the same so
 * the trigger never renders blank next to a populated badge.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { CaseTasks, canonicalStatus } from '../CaseTasks';
import type { CaseTask } from '@/soc/pages/CaseDetail.api';

function task(over: Partial<CaseTask>): CaseTask {
  return {
    id: 't1',
    case_id: 'case-1',
    title: 'Contain the host',
    assignee: null,
    status: 'open',
    order: 0,
    created_at: '2026-06-30T10:00:00Z',
    logs: [],
    ...over,
  };
}

describe('canonicalStatus (#24)', () => {
  it('lowercases canonical values', () => {
    expect(canonicalStatus('Done')).toBe('done');
    expect(canonicalStatus('OPEN')).toBe('open');
    expect(canonicalStatus('In_Progress')).toBe('in_progress');
    expect(canonicalStatus('blocked')).toBe('blocked');
  });

  it('maps unknown / empty statuses to the "open" default (mirroring statusMeta)', () => {
    expect(canonicalStatus('mystery')).toBe('open');
    expect(canonicalStatus('')).toBe('open');
    expect(canonicalStatus(undefined as unknown as string)).toBe('open');
  });
});

describe('CaseTasks — non-canonical status', () => {
  it('drives the status Select from a normalised value so its trigger is not blank', () => {
    render(
      <CaseTasks
        tasks={[task({ status: 'Done' })]}
        canWrite
        onAdd={vi.fn()}
        onStatus={vi.fn()}
        onLog={vi.fn()}
      />,
    );
    // The status Select trigger reflects the (normalised) selected value, not a blank.
    const trigger = screen.getByRole('combobox', { name: 'Task status' });
    expect(trigger.textContent).toContain('Done');
  });

  it('keeps the completion glyph inside a labelled 24px target', () => {
    const onStatus = vi.fn();
    render(
      <CaseTasks
        tasks={[task({ status: 'open' })]}
        canWrite
        onAdd={vi.fn()}
        onStatus={onStatus}
        onLog={vi.fn()}
      />,
    );

    const toggle = screen.getByRole('button', { name: 'Mark task done' });
    expect(toggle).toHaveClass('min-h-6', 'min-w-6');
    expect(toggle.querySelector('svg')).toHaveClass('h-3.5', 'w-3.5');

    fireEvent.click(toggle);
    expect(onStatus).toHaveBeenCalledWith('t1', 'done');
  });
});
