/**
 * Alert — ARIA role is derived from the variant (round-6 ui-theme).
 *
 * success/info are non-urgent → role="status" (a POLITE live region that does NOT
 * interrupt the screen reader); destructive/warning/default stay role="alert"
 * (assertive), per WAI-ARIA. A caller-supplied `role` still wins.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Alert } from '../alert';

describe('Alert role derivation', () => {
  it('uses role="status" for the non-urgent success variant', () => {
    const { getByText } = render(<Alert variant="success">Saved</Alert>);
    expect(getByText('Saved').getAttribute('role')).toBe('status');
  });

  it('uses role="status" for the non-urgent info variant', () => {
    const { getByText } = render(<Alert variant="info">Heads up</Alert>);
    expect(getByText('Heads up').getAttribute('role')).toBe('status');
  });

  it('keeps role="alert" for the destructive variant', () => {
    const { getByText } = render(<Alert variant="destructive">Failed</Alert>);
    expect(getByText('Failed').getAttribute('role')).toBe('alert');
  });

  it('keeps role="alert" for the warning variant', () => {
    const { getByText } = render(<Alert variant="warning">Careful</Alert>);
    expect(getByText('Careful').getAttribute('role')).toBe('alert');
  });

  it('defaults to role="alert" when no variant is given', () => {
    const { getByText } = render(<Alert>Note</Alert>);
    expect(getByText('Note').getAttribute('role')).toBe('alert');
  });

  it('honours an explicit caller-supplied role over the variant default', () => {
    const { getByText } = render(
      <Alert variant="success" role="alert">
        Urgent success
      </Alert>,
    );
    expect(getByText('Urgent success').getAttribute('role')).toBe('alert');
  });

  it.each([
    ['success', 'text-success-text'],
    ['info', 'text-info-text'],
    ['warning', 'text-warning-text'],
    ['destructive', 'text-critical-text'],
  ] as const)('uses the AA standalone text token for %s copy', (variant, tokenClass) => {
    const { getByText } = render(<Alert variant={variant}>Message</Alert>);
    expect(getByText('Message')).toHaveClass(tokenClass);
  });
});
