/**
 * DialogContent — the built-in close (X) and its opt-out (round-6 #14).
 *
 * The fixed top-right X overlaps a command palette's search input (which sits in the
 * dialog's top row). `hideClose` suppresses it for those surfaces without removing it
 * from every other dialog.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Dialog, DialogContent, DialogTitle } from '../dialog';

describe('DialogContent — hideClose', () => {
  it('renders the built-in close (X) by default', () => {
    const { getByText } = render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          body
        </DialogContent>
      </Dialog>,
    );
    // The close button carries an sr-only "Close" label.
    expect(getByText('Close')).toBeInTheDocument();
  });

  it('suppresses the built-in close when hideClose is set', () => {
    const { queryByText } = render(
      <Dialog open>
        <DialogContent hideClose>
          <DialogTitle>Title</DialogTitle>
          body
        </DialogContent>
      </Dialog>,
    );
    expect(queryByText('Close')).toBeNull();
  });
});
