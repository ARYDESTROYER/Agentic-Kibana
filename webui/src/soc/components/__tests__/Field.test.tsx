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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';

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

  it('keeps the label associated when the single child sets its own id', () => {
    render(
      <Field label="Custom id field">
        <Input id="my-own-id" />
      </Field>,
    );
    // The auto-inject path preserves the caller's id; the <Label htmlFor> must point
    // at that same id so clicking the label focuses the control and AT keeps the name.
    const control = screen.getByLabelText('Custom id field');
    expect(control).toHaveAttribute('id', 'my-own-id');
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

  // ── H4 — the visible label must have a stable id the render-prop can point at ──────
  it('exposes a labelledBy id that resolves to the visible label text', () => {
    let captured: { labelledBy: string } | null = null;
    render(
      <Field label="Group by">
        {(props) => {
          captured = props;
          return <input id={props.id} aria-labelledby={props.labelledBy} />;
        }}
      </Field>,
    );
    expect(captured).not.toBeNull();
    const labelledBy = captured!.labelledBy;
    expect(labelledBy).toBeTruthy();
    // The id must resolve to a DOM node carrying the visible label text.
    const labelNode = document.getElementById(labelledBy);
    expect(labelNode).not.toBeNull();
    expect(labelNode?.textContent).toContain('Group by');
  });

  // ── H4 regression — a Field-wrapped Radix Select trigger gets an accessible name ──
  // BEFORE the fix, Field cloned its id onto the DOM-less <Select> Root, so the real
  // role="combobox" trigger was nameless. The render-prop forwards id + aria-labelledby
  // to <SelectTrigger>, so the trigger now resolves via the label.
  it('names a Field-wrapped Radix Select trigger (the H4 bug)', () => {
    render(
      <Field label="Group by">
        {({ id, labelledBy }) => (
          <Select defaultValue="ip">
            <SelectTrigger id={id} aria-labelledby={labelledBy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ip">Source IP</SelectItem>
              <SelectItem value="host">Host</SelectItem>
            </SelectContent>
          </Select>
        )}
      </Field>,
    );
    // getByRole with an accessible name only resolves when the trigger is truly named.
    const trigger = screen.getByRole('combobox', { name: 'Group by' });
    expect(trigger).toBeInTheDocument();
  });
});
