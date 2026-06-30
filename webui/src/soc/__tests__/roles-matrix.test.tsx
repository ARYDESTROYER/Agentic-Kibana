/**
 * RBAC role matrix editor + preview-diff tests (Round 3 / Feature 6).
 *
 * Covers the PURE tri-state cell logic (cellState/cycleCell — the heart of the grants/
 * denies grid) and the PreviewDiff render that shows the resolved effective grants +
 * the per-resource added/removed action diff. No network: everything here is offline.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';
import {
  cellState,
  cycleCell,
  type RoleDraft,
} from '../components/RoleMatrixEditor';
import { PreviewDiff } from '../pages/Roles';
import type { RolePreviewResponse } from '../pages/Roles.api';

function draft(): RoleDraft {
  return { name: 'tier1_plus', description: '', inherits: [], grants: {}, denies: {} };
}

describe('RoleMatrixEditor cell logic', () => {
  it('cycles a cell neutral → grant → deny → neutral', () => {
    let d = draft();
    expect(cellState(d, 'cases', 'read')).toBe('neutral');

    d = cycleCell(d, 'cases', 'read');
    expect(cellState(d, 'cases', 'read')).toBe('grant');
    expect(d.grants.cases).toEqual(['read']);

    d = cycleCell(d, 'cases', 'read');
    expect(cellState(d, 'cases', 'read')).toBe('deny');
    expect(d.denies.cases).toEqual(['read']);
    // The grant must have been removed when it became a deny.
    expect(d.grants.cases).toBeUndefined();

    d = cycleCell(d, 'cases', 'read');
    expect(cellState(d, 'cases', 'read')).toBe('neutral');
    expect(d.grants.cases).toBeUndefined();
    expect(d.denies.cases).toBeUndefined();
  });

  it('treats a wildcard grant as granting every action', () => {
    const d: RoleDraft = { ...draft(), grants: { cases: ['*'] } };
    expect(cellState(d, 'cases', 'read')).toBe('grant');
    expect(cellState(d, 'cases', 'close')).toBe('grant');
  });

  it('keeps other actions on the same resource intact when one toggles', () => {
    let d: RoleDraft = { ...draft(), grants: { cases: ['read', 'write'] } };
    d = cycleCell(d, 'cases', 'read'); // read: grant → deny
    expect(d.grants.cases).toEqual(['write']);
    expect(d.denies.cases).toEqual(['read']);
  });
});

describe('PreviewDiff render', () => {
  const preview: RolePreviewResponse = {
    name: 'tier1_plus',
    resolved: { cases: ['read', 'write', 'close'], proposals: ['read'] },
    effective: { cases: ['read', 'write', 'close'], proposals: ['read'] },
    diff: {
      cases: { added: ['close'], removed: [] },
      proposals: { added: [], removed: ['approve'] },
    },
    is_new: true,
  };

  it('renders added (+) and removed (−) action chips per resource', () => {
    render(
      <TooltipProvider>
        <PreviewDiff preview={preview} />
      </TooltipProvider>,
    );
    expect(screen.getByText('New role')).toBeInTheDocument();
    // The diff badges.
    expect(screen.getByText('+close')).toBeInTheDocument();
    expect(screen.getByText('−approve')).toBeInTheDocument();
    // Effective grants rendered in a (fenced) code block as plain text.
    expect(screen.getByText(/cases: read, write, close/)).toBeInTheDocument();
  });

  it('shows a no-change message when the diff is empty', () => {
    render(
      <TooltipProvider>
        <PreviewDiff
          preview={{ ...preview, diff: {}, is_new: false }}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText(/No change vs the current matrix/i)).toBeInTheDocument();
    expect(screen.getByText('Existing')).toBeInTheDocument();
  });
});
