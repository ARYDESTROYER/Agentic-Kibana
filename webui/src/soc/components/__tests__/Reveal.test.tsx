/**
 * Reveal — Round-7 W0.1. A pure-CSS one-shot enter wrapper (reduced motion is handled
 * globally by the theme.css reset, so there is no JS branch to test — only the class +
 * delay + element wiring).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Reveal } from '../Reveal';

describe('Reveal', () => {
  it('defaults to the fade-in keyframe', () => {
    render(<Reveal>hello</Reveal>);
    const el = screen.getByText('hello');
    expect(el.className).toContain('animate-fade-in');
  });

  it('maps variant → keyframe (rise / scale)', () => {
    const { rerender } = render(<Reveal variant="rise">x</Reveal>);
    expect(screen.getByText('x').className).toContain('animate-rise-in');
    rerender(<Reveal variant="scale">x</Reveal>);
    expect(screen.getByText('x').className).toContain('animate-scale-in');
  });

  it('applies an animation-delay when `delay` is set', () => {
    render(<Reveal delay={120}>d</Reveal>);
    const el = screen.getByText('d');
    expect(el.style.animationDelay).toBe('120ms');
  });

  it('renders as the requested element and forwards extra props', () => {
    render(
      <Reveal as="section" aria-label="panel">
        s
      </Reveal>,
    );
    const el = screen.getByText('s');
    expect(el.tagName).toBe('SECTION');
    expect(el.getAttribute('aria-label')).toBe('panel');
  });
});
