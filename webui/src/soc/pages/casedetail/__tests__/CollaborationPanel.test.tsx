/**
 * CollaborationPanel — assignee Select value binding (Round-6 finding #11).
 *
 * The picker must reflect the ACTUAL assignee, not a false "Unassigned", when the case
 * is assigned to someone outside the pickable user list (a free-text / deleted / display
 * -name assignee). It must also normalise a case-mismatched known user to the canonical
 * username so the trigger matches a real SelectItem.
 */
import { describe, it, expect } from 'vitest';

import { assigneeSelectValue } from '../CollaborationPanel';
import type { PickableUser } from '@/soc/pages/CaseDetail.api';

const USERS: PickableUser[] = [{ username: 'alice' }, { username: 'bob' }];

describe('assigneeSelectValue (#11)', () => {
  it('preserves a free-text assignee not in the user list (not "__unassigned__")', () => {
    expect(assigneeSelectValue('carol', USERS)).toBe('carol');
  });

  it('normalises a case-mismatched known user to the canonical username', () => {
    expect(assigneeSelectValue('ALICE', USERS)).toBe('alice');
  });

  it('returns the unassigned sentinel only for an empty assignee', () => {
    expect(assigneeSelectValue('', USERS)).toBe('__unassigned__');
    expect(assigneeSelectValue('   ', USERS)).toBe('__unassigned__');
  });
});
