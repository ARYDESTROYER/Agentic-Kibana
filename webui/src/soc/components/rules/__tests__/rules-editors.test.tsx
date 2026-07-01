/**
 * Rules editor components — net-new specs (G6 R4/R6).
 *
 * Covers the config-writer editors + shared threshold-UX primitives:
 *   - validateCidr sniff (accept/reject),
 *   - AssetCriticalityEditor add/edit/remove + NumberField clamp on criticality,
 *   - SlaPolicyEditor enable gate + target edit,
 *   - PriorityMatrixEditor cell edit + default,
 *   - SuppressionRuleBuilder add/edit/enable + delete confirm hook,
 *   - EffectiveConfigPreview below-floor copy (#4),
 *   - TunerSuggestionChip advisory apply.
 *
 * Every editor is a CONFIG WRITER — it emits config via `onChange` and never calls
 * `decide()` / sets a status / bills an LLM. Values render plain (#9).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';

import {
  AssetCriticalityEditor,
  validateCidr,
  SlaPolicyEditor,
  PriorityMatrixEditor,
  SuppressionRuleBuilder,
  EffectiveConfigPreview,
  TunerSuggestionChip,
} from '../index';

function wrap(ui: React.ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

/* ── validateCidr ──────────────────────────────────────────────────────── */
describe('validateCidr', () => {
  it('accepts a well-formed IPv4 CIDR', () => {
    expect(validateCidr('10.0.0.0/8')).toBeNull();
    expect(validateCidr('192.168.1.0/24')).toBeNull();
  });
  it('rejects a missing prefix / bad octet / bad prefix', () => {
    expect(validateCidr('10.0.0.0')).toBeTruthy();
    expect(validateCidr('999.0.0.0/8')).toBeTruthy();
    expect(validateCidr('10.0.0.0/40')).toBeTruthy();
    expect(validateCidr('')).toBeTruthy();
  });
  it('accepts an IPv6 CIDR', () => {
    expect(validateCidr('2001:db8::/32')).toBeNull();
    expect(validateCidr('fe80::/200')).toBeTruthy();
  });
});

/* ── AssetCriticalityEditor ────────────────────────────────────────────── */
describe('AssetCriticalityEditor', () => {
  function renderEditor(over: Partial<React.ComponentProps<typeof AssetCriticalityEditor>> = {}) {
    const onNetworksChange = vi.fn();
    const onExactChange = vi.fn();
    wrap(
      <AssetCriticalityEditor
        networks={over.networks ?? []}
        exact={over.exact ?? {}}
        onNetworksChange={over.onNetworksChange ?? onNetworksChange}
        onExactChange={over.onExactChange ?? onExactChange}
      />,
    );
    return { onNetworksChange, onExactChange };
  }

  it('adds a CIDR network with a default criticality', () => {
    const { onNetworksChange } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /add network/i }));
    expect(onNetworksChange).toHaveBeenCalledWith([{ cidr: '', criticality: 50 }]);
  });

  it('surfaces a validation error for a malformed CIDR (plain text, #9)', () => {
    renderEditor({ networks: [{ cidr: 'nope', criticality: 50 }] });
    // The row shows the inline validation message.
    expect(screen.getByText(/prefix length/i)).toBeInTheDocument();
  });

  it('clamps an over-max criticality on the network NumberField (blur)', () => {
    const onNetworksChange = vi.fn();
    renderEditor({ networks: [{ cidr: '10.0.0.0/8', criticality: 50 }], onNetworksChange });
    const input = screen.getAllByLabelText('Criticality')[0] as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '9999' } });
    fireEvent.blur(input, { target: { value: '9999' } });
    expect(onNetworksChange).toHaveBeenCalledWith([{ cidr: '10.0.0.0/8', criticality: 100 }]);
  });

  it('removes a network', () => {
    const onNetworksChange = vi.fn();
    renderEditor({ networks: [{ cidr: '10.0.0.0/8', criticality: 50 }], onNetworksChange });
    fireEvent.click(screen.getByRole('button', { name: /remove network/i }));
    expect(onNetworksChange).toHaveBeenCalledWith([]);
  });

  it('edits the exact-value criticality map without dropping the key', () => {
    const onExactChange = vi.fn();
    renderEditor({ exact: { 'db-prod-01': 80 }, onExactChange });
    const input = screen.getByDisplayValue('db-prod-01');
    fireEvent.change(input, { target: { value: 'db-prod-02' } });
    expect(onExactChange).toHaveBeenCalledWith({ 'db-prod-02': 80 });
  });
});

/* ── SlaPolicyEditor ───────────────────────────────────────────────────── */
describe('SlaPolicyEditor', () => {
  it('toggles enabled and disables the target fields when off', () => {
    const onChange = vi.fn();
    wrap(<SlaPolicyEditor policy={{ enabled: false }} onChange={onChange} />);
    // The enable switch flips enabled.
    fireEvent.click(screen.getByLabelText(/enable sla tracking/i));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    // While disabled, a response-target input is disabled.
    const responseInputs = screen.getAllByLabelText('Response target');
    expect((responseInputs[0] as HTMLInputElement).disabled).toBe(true);
  });

  it('edits a P1 response target when enabled', () => {
    const onChange = vi.fn();
    wrap(<SlaPolicyEditor policy={{ enabled: true, targets: { P1: { response_minutes: 15 } } }} onChange={onChange} />);
    const input = screen.getAllByLabelText('Response target')[0] as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.blur(input, { target: { value: '20' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: expect.objectContaining({ P1: expect.objectContaining({ response_minutes: 20 }) }),
      }),
    );
  });
});

/* ── PriorityMatrixEditor ──────────────────────────────────────────────── */
describe('PriorityMatrixEditor', () => {
  it('renders a labelled cell for every impact/urgency pair', () => {
    wrap(<PriorityMatrixEditor matrix={{ enabled: true }} onChange={vi.fn()} />);
    // 3x3 default grid → 9 cell selects, all labelled for a11y.
    expect(
      screen.getByRole('combobox', { name: /high impact, high urgency/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: /low impact, low urgency/i }),
    ).toBeInTheDocument();
  });

  it('toggles enable', () => {
    const onChange = vi.fn();
    wrap(<PriorityMatrixEditor matrix={{ enabled: false }} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/enable priority derivation/i));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });
});

/* ── SuppressionRuleBuilder ────────────────────────────────────────────── */
describe('SuppressionRuleBuilder', () => {
  it('adds an operator-stamped rule', () => {
    const onChange = vi.fn();
    wrap(<SuppressionRuleBuilder rules={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /add rule/i }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ field: '', value: '', enabled: true, created_by: 'operator' }),
    ]);
  });

  it('routes a live-rule delete through onRequestRemove (host confirm)', () => {
    const onChange = vi.fn();
    const onRequestRemove = vi.fn();
    wrap(
      <SuppressionRuleBuilder
        rules={[{ field: 'rule.name', value: 'scanner', enabled: true }]}
        onChange={onChange}
        onRequestRemove={onRequestRemove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove suppression rule/i }));
    // A live rule is NOT removed directly — it asks the host to confirm.
    expect(onRequestRemove).toHaveBeenCalledWith(0, expect.objectContaining({ value: 'scanner' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes a disabled rule directly (no confirm needed)', () => {
    const onChange = vi.fn();
    const onRequestRemove = vi.fn();
    wrap(
      <SuppressionRuleBuilder
        rules={[{ field: 'rule.name', value: 'x', enabled: false }]}
        onChange={onChange}
        onRequestRemove={onRequestRemove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove suppression rule/i }));
    expect(onChange).toHaveBeenCalledWith([]);
    expect(onRequestRemove).not.toHaveBeenCalled();
  });

  it('renders an agent-drafted rule value as plain text (#9)', () => {
    wrap(
      <SuppressionRuleBuilder
        rules={[{ field: 'user.name', value: '<script>alert(1)</script>', created_by: 'agent', enabled: true }]}
        onChange={vi.fn()}
      />,
    );
    // The attacker-influenceable value is rendered inertly as an input value, not markup.
    expect(screen.getByDisplayValue('<script>alert(1)</script>')).toBeInTheDocument();
    expect(screen.getByText(/agent-drafted/i)).toBeInTheDocument();
  });
});

/* ── EffectiveConfigPreview ────────────────────────────────────────────── */
describe('EffectiveConfigPreview', () => {
  it('renders the #4 non-destructive below-floor note by default', () => {
    wrap(<EffectiveConfigPreview summary="Auto-forward clusters of >= 5 events" />);
    expect(screen.getByText(/candidate only — never dropped/i)).toBeInTheDocument();
  });

  it('omits the note when belowFloorNote is false', () => {
    wrap(<EffectiveConfigPreview summary="hi" belowFloorNote={false} />);
    expect(screen.queryByText(/never dropped/i)).not.toBeInTheDocument();
  });
});

/* ── TunerSuggestionChip ───────────────────────────────────────────────── */
describe('TunerSuggestionChip', () => {
  it('applies the suggestion locally (advisory only)', () => {
    const onApply = vi.fn();
    wrap(<TunerSuggestionChip current={3} suggested={4} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: /apply tuner suggestion 4/i }));
    expect(onApply).toHaveBeenCalledWith(4);
  });

  it('renders nothing when the suggestion equals the current value', () => {
    const { container } = wrap(<TunerSuggestionChip current={4} suggested={4} onApply={vi.fn()} />);
    expect(within(container).queryByText(/tuner suggests/i)).not.toBeInTheDocument();
  });

  it('renders nothing when there is no suggestion', () => {
    const { container } = wrap(<TunerSuggestionChip current={4} suggested={null} onApply={vi.fn()} />);
    expect(within(container).queryByText(/tuner suggests/i)).not.toBeInTheDocument();
  });
});
