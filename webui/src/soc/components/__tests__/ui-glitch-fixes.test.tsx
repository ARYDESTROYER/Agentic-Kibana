/**
 * Wave-0 UI glitch fixes — regression coverage.
 *
 * 1) HoverCardContent must pass a non-zero `collisionPadding` to the Radix
 *    Content so the fixed-width (w-80) card no longer clips at the right viewport
 *    edge (Radix defaults collisionPadding to 0). We capture the props Radix
 *    Content receives (it does NOT surface collisionPadding as a DOM attribute)
 *    via a light Radix module mock.
 * 2) SettingsCard's inner text container must carry `flex-1` and its description
 *    `<p>` must carry `break-words`, so a long single-token description wraps
 *    normally instead of one-word-per-line.
 */
import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Capture the props Radix HoverCard Content receives. `collisionPadding` is a
// layout hint consumed by Radix internally (not reflected to the DOM), so we
// intercept it at the primitive boundary.
const contentProps: Record<string, unknown>[] = [];
vi.mock('@radix-ui/react-hover-card', () => {
  const Content = React.forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => {
    contentProps.push(props);
    return React.createElement(
      'div',
      { ref, 'data-testid': 'hc-content' },
      props.children as React.ReactNode,
    );
  });
  Content.displayName = 'HoverCardContent';
  return {
    Root: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Trigger: ({ children }: { children?: React.ReactNode }) =>
      React.createElement('button', null, children),
    Portal: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Content,
  };
});

import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/ui/hover-card';
import { SettingsCard } from '@/soc/components/SettingsGrid';

describe('Wave-0 glitch fix — HoverCardContent collisionPadding', () => {
  it('applies a non-zero collisionPadding by default (viewport-edge clipping fix)', () => {
    contentProps.length = 0;
    render(
      <HoverCard>
        <HoverCardTrigger>open</HoverCardTrigger>
        <HoverCardContent>body</HoverCardContent>
      </HoverCard>,
    );
    const props = contentProps.at(-1)!;
    expect(props.collisionPadding).toBeDefined();
    expect(props.collisionPadding).toBe(8);
    expect(props.collisionPadding).not.toBe(0);
  });

  it('lets callers override collisionPadding', () => {
    contentProps.length = 0;
    render(
      <HoverCard>
        <HoverCardTrigger>open</HoverCardTrigger>
        <HoverCardContent collisionPadding={24}>body</HoverCardContent>
      </HoverCard>,
    );
    expect(contentProps.at(-1)!.collisionPadding).toBe(24);
  });
});

describe('Wave-0 glitch fix — SettingsCard description wrapping', () => {
  it('gives the text container flex-1 and the description break-words', () => {
    const desc =
      'supercalifragilisticexpialidocious-antidisestablishmentarianism-pneumonoultramicroscopic';
    render(<SettingsCard title="A section" description={desc} />);

    // The inner text column is the parent <div> of the title <h3>; it must carry
    // BOTH min-w-0 (already present) and the newly-added flex-1.
    const textCol = screen.getByText('A section').parentElement!;
    expect(textCol.className).toContain('min-w-0');
    expect(textCol.className).toContain('flex-1');

    // The description <p> must break long tokens instead of one-word-per-line.
    const p = screen.getByText(desc);
    expect(p.tagName.toLowerCase()).toBe('p');
    expect(p.className).toContain('break-words');
  });
});
