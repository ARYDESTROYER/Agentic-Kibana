import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TagInput } from '@/soc/components/TagInput';

describe('TagInput', () => {
  it('renders label', () => {
    render(<TagInput label="Tags" value={[]} onChange={vi.fn()} />);
    expect(screen.getByText('Tags')).toBeInTheDocument();
  });

  it('renders existing tags', () => {
    render(<TagInput label="Tags" value={['a', 'b']} onChange={vi.fn()} />);
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
  });

  it('calls onChange when adding a tag via Enter', () => {
    const onChange = vi.fn();
    render(<TagInput label="Tags" value={[]} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'newtag' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['newtag']);
  });

  it('deduplicates tags by default', () => {
    const onChange = vi.fn();
    render(<TagInput label="Tags" value={['dup']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'dup' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('respects max limit', () => {
    const onChange = vi.fn();
    render(<TagInput label="Tags" value={['a']} onChange={onChange} max={1} />);
    const input = screen.getByRole('textbox');
    expect(input).toBeDisabled();
  });

  it('removes last tag on Backspace when input is empty', () => {
    const onChange = vi.fn();
    render(<TagInput label="Tags" value={['first', 'second']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledWith(['first']);
  });
});
