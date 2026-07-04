/**
 * CountUp — Round-7 W0.1. Renders the integer (static on first mount), through the
 * formatter, in the requested element.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CountUp } from '../CountUp';

describe('CountUp', () => {
  it('renders the value statically on first mount', () => {
    render(<CountUp value={5} />);
    const node = screen.getByTestId('count-up');
    expect(node).toHaveTextContent('5');
  });

  it('applies the formatter', () => {
    render(<CountUp value={1234} format={(n) => n.toLocaleString('en-US')} />);
    expect(screen.getByTestId('count-up')).toHaveTextContent('1,234');
  });

  it('renders as the requested element', () => {
    render(<CountUp value={9} as="div" className="tabular-nums" />);
    const node = screen.getByTestId('count-up');
    expect(node.tagName).toBe('DIV');
    expect(node.className).toContain('tabular-nums');
  });
});
