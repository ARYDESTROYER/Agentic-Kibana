/**
 * Markdown — the shared, injection-safe renderer. Verifies numbered + bullet lists,
 * inline bold/code, and that no raw HTML is ever produced.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Markdown } from '../Markdown';

describe('Markdown', () => {
  it('renders a numbered list as an <ol>', () => {
    const { container } = render(<Markdown text={'Summary.\n1. First\n2. Second\n3. Third'} />);
    const ol = container.querySelector('ol');
    expect(ol).not.toBeNull();
    expect(ol!.querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByText('First')).toBeInTheDocument();
  });

  it('renders a bullet list as a <ul> and supports `1)` numbering', () => {
    const { container } = render(<Markdown text={'- a\n- b'} />);
    expect(container.querySelector('ul')?.querySelectorAll('li')).toHaveLength(2);
    const { container: c2 } = render(<Markdown text={'1) one\n2) two'} />);
    expect(c2.querySelector('ol')?.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders inline bold and code, never raw HTML', () => {
    const { container } = render(<Markdown text={'a **bold** and `code` and <b>x</b>'} />);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('code')?.textContent).toBe('code');
    // The literal HTML is rendered as TEXT, not an element.
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText(/<b>x<\/b>/)).toBeInTheDocument();
  });
});
