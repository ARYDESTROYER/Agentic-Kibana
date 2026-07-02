/**
 * ConfirmDialog — gating spec (W0-B1). The load-bearing behavior: the destructive
 * action only fires when the operator explicitly confirms, and Cancel does not
 * fire it. Also covers the imperative promise API resolving true/false.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ConfirmDialog, ConfirmProvider, useConfirm } from '../ConfirmDialog';

describe('ConfirmDialog (controlled)', () => {
  it('runs onConfirm only when Confirm is clicked', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        onConfirm={onConfirm}
        onCancel={onCancel}
        title="Delete role?"
        confirmLabel="Delete"
        destructive
      />,
    );
    expect(screen.getByText('Delete role?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('runs onCancel (and not onConfirm) when Cancel is clicked', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open onOpenChange={() => {}} onConfirm={onConfirm} onCancel={onCancel} title="Sure?" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // The destructive dismiss-guard is now delegated to AlertDialogContent's
  // `dismissible` switch (dismissible={!destructive}) — the single source of truth —
  // rather than hand-rolled onEscapeKeyDown/onPointerDownOutside handlers.
  it('does NOT dismiss a destructive gate on Escape', () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog open onOpenChange={onOpenChange} onConfirm={() => {}} title="Delete role?" destructive />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('DOES dismiss a non-destructive dialog on Escape', () => {
    const onOpenChange = vi.fn();
    render(<ConfirmDialog open onOpenChange={onOpenChange} onConfirm={() => {}} title="Sure?" />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('useConfirm (imperative)', () => {
  function Harness({ onResult }: { onResult: (v: boolean) => void }) {
    const confirm = useConfirm();
    return (
      <button
        onClick={async () => {
          const ok = await confirm({ title: 'Proceed?', confirmLabel: 'Yes' });
          onResult(ok);
        }}
      >
        ask
      </button>
    );
  }

  it('resolves true when confirmed', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Harness onResult={onResult} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await screen.findByText('Proceed?');
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  it('resolves false when cancelled', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Harness onResult={onResult} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await screen.findByText('Proceed?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });
});
