import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from '@/soc/components/EmptyState';
import { Inbox } from 'lucide-react';

describe('EmptyState', () => {
  it('renders title', () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<EmptyState title="Empty" description="No items match your filter." />);
    expect(screen.getByText('No items match your filter.')).toBeInTheDocument();
  });

  it('renders action prop', () => {
    render(
      <EmptyState title="No data" action={<button>Create item</button>} />,
    );
    expect(screen.getByRole('button', { name: 'Create item' })).toBeInTheDocument();
  });

  it('error variant has role alert', () => {
    const { container } = render(<EmptyState title="Error" variant="error" />);
    expect(container.querySelector('[role="alert"]')).toBeInTheDocument();
  });

  it('uses the Inbox icon by default', () => {
    const { container } = render(<EmptyState title="Default icon" />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('accepts a custom icon', () => {
    const { container } = render(<EmptyState title="Custom" icon={Inbox} />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
});
