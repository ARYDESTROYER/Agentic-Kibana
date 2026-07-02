/**
 * FeedbackPanel — grading-enable + slider-a11y coverage (Round-6 findings).
 *
 *   #12: picking a non-default assessment (Disagree / Partially) must ENABLE Submit on
 *        its own — a deliberate disagreement is the panel's primary signal.
 *   #14: the "Analyst time saved" control is the shared LabeledSlider, so its Radix
 *        thumb carries an accessible name (was a bare Slider with none).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { caseFeedbackMock } = vi.hoisted(() => ({ caseFeedbackMock: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { caseFeedback: caseFeedbackMock } }));

import { FeedbackTab } from '../FeedbackPanel';
import type { Case } from '@/lib/types';

const CASE = { case_id: 'case-1', status: 'open', feedback: [] } as unknown as Case;

describe('FeedbackPanel', () => {
  beforeEach(() => caseFeedbackMock.mockReset());

  it('enables Submit when only a non-default assessment is chosen (#12)', () => {
    render(<FeedbackTab c={CASE} onUpdated={vi.fn()} />);
    const submit = screen.getByRole('button', { name: /submit grading/i });
    // Default assessment is "agree" and nothing else is set ⇒ disabled.
    expect(submit).toBeDisabled();

    // Choosing "Disagree" alone is a submittable grading.
    fireEvent.click(screen.getByRole('button', { name: /^disagree$/i }));
    expect(submit).toBeEnabled();
  });

  it('exposes an accessible name on the analyst-time-saved slider (#14)', () => {
    render(<FeedbackTab c={CASE} onUpdated={vi.fn()} />);
    // LabeledSlider forwards aria-label to the role="slider" thumb.
    expect(screen.getByRole('slider', { name: /analyst time saved/i })).toBeInTheDocument();
  });
});
