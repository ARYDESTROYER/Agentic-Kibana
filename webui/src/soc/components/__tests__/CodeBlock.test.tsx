/**
 * CodeBlock / InlineCode — UNTRUSTED-safe rendering + design-token conformance.
 *   - arbitrary content renders EXCLUSIVELY as text (no HTML injection, #9);
 *   - shared primitives use the `text-sm` type token (not an arbitrary text-[..] size);
 *   - the copy control uses the shared `focus-visible` focus ring (not a bare `focus:`
 *     ring that flashes on mouse click).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CodeBlock, InlineCode } from '../CodeBlock';

describe('CodeBlock', () => {
  it('renders untrusted content as plain text, never as markup', () => {
    render(<CodeBlock value={'<script>alert(1)</script>'} />);
    // The literal text is present; no <script> element leaked into the DOM.
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });

  it('uses the text-sm token rather than an arbitrary text-[..] size', () => {
    const { container } = render(<CodeBlock value="hello" copyable={false} />);
    const pre = container.querySelector('pre')!;
    expect(pre.className).toContain('text-sm');
    expect(pre.className).not.toMatch(/text-\[/);
  });

  it('gives the copy button the shared focus-visible ring (not a bare focus: ring)', () => {
    render(<CodeBlock value="hello" />);
    const copy = screen.getByRole('button', { name: /copy to clipboard/i });
    expect(copy.className).toContain('focus-visible:ring-2');
    // A bare `focus:ring-2` (no `-visible`) would flash on ordinary mouse clicks.
    expect(copy.className).not.toMatch(/(^|\s)focus:ring-2/);
  });
});

describe('InlineCode', () => {
  it('uses the text-sm token rather than an arbitrary text-[..] size', () => {
    render(<InlineCode value="10.0.0.1" />);
    const code = screen.getByText('10.0.0.1');
    expect(code.className).toContain('text-sm');
    expect(code.className).not.toMatch(/text-\[/);
  });
});
