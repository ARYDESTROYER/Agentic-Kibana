/**
 * Slider — aria labelling reaches the role="slider" thumb (round-6 #20 / WCAG 4.1.2).
 *
 * Radix puts role="slider" (and reads aria-label/aria-valuetext) on the THUMB, not on
 * Root, so labelling aria spread onto Root is inert for assistive tech. The wrapper must
 * forward those props to the thumb.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Slider } from '../slider';

describe('Slider — accessible name/value on the thumb', () => {
  it('forwards aria-label + aria-valuetext to the role="slider" thumb', () => {
    const { getByRole } = render(
      // eslint-disable-next-line jsx-a11y/role-supports-aria-props -- Slider renders role="slider" on the thumb; jsx-a11y can't infer the custom component's role
      <Slider value={[80]} min={0} max={100} aria-label="Minimum risk to notify" aria-valuetext="80%" />,
    );
    const thumb = getByRole('slider');
    expect(thumb).toHaveAttribute('aria-label', 'Minimum risk to notify');
    expect(thumb).toHaveAttribute('aria-valuetext', '80%');
  });

  it('forwards aria-describedby + aria-labelledby to the thumb', () => {
    const { getByRole } = render(
      <Slider value={[10]} aria-labelledby="lbl" aria-describedby="hint" />,
    );
    const thumb = getByRole('slider');
    expect(thumb).toHaveAttribute('aria-labelledby', 'lbl');
    expect(thumb).toHaveAttribute('aria-describedby', 'hint');
  });

  // round-6 ui-theme #53: the Thumb is a <span>, so the `:disabled` pseudo never
  // matched — the disabled styling must ride Radix's data-disabled attribute.
  it('uses the data-disabled variant on the thumb, not the dead `disabled:` pseudo', () => {
    const { getByRole } = render(<Slider value={[10]} />);
    const tokens = getByRole('slider').className.split(/\s+/).filter(Boolean);
    expect(tokens).toContain('data-[disabled]:pointer-events-none');
    expect(tokens).not.toContain('disabled:pointer-events-none');
    expect(tokens).not.toContain('disabled:opacity-50');
  });
});
