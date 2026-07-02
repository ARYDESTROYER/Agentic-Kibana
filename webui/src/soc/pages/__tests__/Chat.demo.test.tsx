/**
 * Chat page — Demo Mode height coverage (R6 fix).
 *
 * The full-height chat frame is anchored to the viewport (`calc(100vh - offset)`).
 * When the demo tenant is active the AppShell injects the amber DemoBanner + a 16px
 * `mt-4` spacer ABOVE the page inside the SAME content wrapper, so the frame must
 * subtract that band (~88px) too or the composer is pushed below the fold. These
 * tests assert the offset switches with `useDemo().active` in both the standalone and
 * embedded (Workspace) layouts.
 *
 * ChatPanel is mocked to a trivial stub so no chat engine / network is pulled in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const { demoActiveRef } = vi.hoisted(() => ({ demoActiveRef: { current: false } }));

vi.mock('@/soc/demo', () => ({
  useDemo: () => ({
    status: { mode: demoActiveRef.current ? 'seeded' : 'off', active: demoActiveRef.current, run_id: null },
    active: demoActiveRef.current,
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/soc/components/ChatPanel', async () => {
  const React = await import('react');
  return {
    ChatPanel: React.forwardRef((_props, ref) =>
      React.createElement('div', { ref, 'data-testid': 'chat-panel' }),
    ),
  };
});

import Chat from '../Chat';

/** The outer full-height frame is the render container's first element child. */
function frameClass(container: HTMLElement): string {
  return (container.firstElementChild as HTMLElement).className;
}

describe('Chat page — Demo Mode height', () => {
  beforeEach(() => {
    demoActiveRef.current = false;
  });

  it('anchors to the standard viewport offset when demo is off', () => {
    const { container } = render(<Chat />);
    expect(frameClass(container)).toContain('h-[calc(100vh-104px)]');
  });

  it('subtracts the DemoBanner band when demo is active', () => {
    demoActiveRef.current = true;
    const { container } = render(<Chat />);
    const cls = frameClass(container);
    expect(cls).toContain('h-[calc(100vh-192px)]');
    expect(cls).not.toContain('h-[calc(100vh-104px)]');
  });

  it('uses the embedded offsets inside the Workspace scaffold', () => {
    const { container } = render(<Chat embedded />);
    expect(frameClass(container)).toContain('h-[calc(100vh-220px)]');
  });

  it('subtracts the DemoBanner band in the embedded layout too', () => {
    demoActiveRef.current = true;
    const { container } = render(<Chat embedded />);
    expect(frameClass(container)).toContain('h-[calc(100vh-308px)]');
  });
});
