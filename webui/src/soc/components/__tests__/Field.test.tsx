/**
 * Field — a11y wiring spec (W0-B1). Pins the load-bearing contract:
 *   - the label is associated with the control (clicking the label focuses it /
 *     `getByLabelText` finds the control);
 *   - description + error are wired via `aria-describedby`;
 *   - `error` sets `aria-invalid` and renders a `role="alert"`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Field } from '../Field';
import { Input } from '@/ui/input';

describe('Field', () => {
  it('associates the label with an auto-injected single child control', () => {
    render(
      <Field label="Correlation window">
        <Input />
      </Field>,
    );
    // getByLabelText only resolves when htmlFor/id are correctly wired.
    const control = screen.getByLabelText('Correlation window');
    expect(control).toBeInTheDocument();
    expect(control.tagName).toBe('INPUT');
  });

  it('wires description + error into aria-describedby and marks invalid', () => {
    render(
      <Field label="Threshold" description="Minutes" error="Too high">
        <Input />
      </Field>,
    );
    const control = screen.getByLabelText('Threshold');
    const describedBy = control.getAttribute('aria-describedby') ?? '';
    // both the description and error node ids are referenced
    const descNode = screen.getByText('Minutes');
    const errNode = screen.getByRole('alert');
    expect(errNode).toHaveTextContent('Too high');
    expect(describedBy.split(' ')).toContain(descNode.id);
    expect(describedBy.split(' ')).toContain(errNode.id);
    expect(control).toHaveAttribute('aria-invalid', 'true');
  });

  it('supports the render-prop form, passing ids to the control', () => {
    render(
      <Field label="Name" error="req">
        {({ id, describedBy, invalid }) => (
          <input id={id} aria-describedby={describedBy} aria-invalid={invalid} />
        )}
      </Field>,
    );
    const control = screen.getByLabelText('Name');
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control.getAttribute('aria-describedby')).toBeTruthy();
  });
});
