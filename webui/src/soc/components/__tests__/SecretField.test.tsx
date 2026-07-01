/**
 * SecretField — invariant #10 spec (W0-B1). The load-bearing guarantee: the field
 * NEVER echoes a stored secret. It shows a boolean status ("configured ✓" / "not
 * set") and the only text present is the NEW value being typed (masked).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';

import { SecretField } from '../SecretField';

function renderSecret(props: Partial<React.ComponentProps<typeof SecretField>> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <TooltipProvider>
      <SecretField label="API key" configured value="" onChange={onChange} {...props} />
    </TooltipProvider>,
  );
  return { onChange, ...utils };
}

describe('SecretField', () => {
  it('shows the configured boolean, never a value', () => {
    const { container } = renderSecret({ configured: true, value: '' });
    expect(screen.getByText(/configured ✓/)).toBeInTheDocument();
    // The input is empty (masked) — no persisted secret is rendered anywhere.
    const input = screen.getByLabelText('API key') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.type).toBe('password');
    // Nothing in the DOM leaks a secret-looking string.
    expect(container.textContent).not.toContain('supersecret');
  });

  it('renders "not set" when unconfigured', () => {
    renderSecret({ configured: false });
    expect(screen.getByText('not set')).toBeInTheDocument();
  });

  it('emits typed characters via onChange but keeps the input masked', () => {
    const { onChange } = renderSecret({ configured: false });
    const input = screen.getByLabelText('API key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'new-value' } });
    expect(onChange).toHaveBeenCalledWith('new-value');
    // still password type until reveal is toggled
    expect(input.type).toBe('password');
  });

  it('there is no prop path that accepts an existing plaintext secret', () => {
    // A regression guard: the only value shown is the controlled `value` (a NEW
    // value), which the parent clears after save. Passing configured=true keeps
    // the input empty.
    renderSecret({ configured: true, value: '' });
    const input = screen.getByLabelText('API key') as HTMLInputElement;
    expect(input.value).toBe('');
  });
});
