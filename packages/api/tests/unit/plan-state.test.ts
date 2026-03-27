import { describe, it, expect } from 'vitest';

type PlanStatus = 'draft' | 'proposed' | 'active' | 'superseded';

interface StateTransition {
  from: PlanStatus;
  action: string;
  to: PlanStatus;
  valid: boolean;
}

const VALID_TRANSITIONS: StateTransition[] = [
  { from: 'draft', action: 'propose', to: 'proposed', valid: true },
  { from: 'draft', action: 'activate', to: 'active', valid: true },
  { from: 'proposed', action: 'activate', to: 'active', valid: true },
  { from: 'active', action: 'supersede', to: 'superseded', valid: true },
  { from: 'superseded', action: 'reactivate', to: 'active', valid: true },
];

const INVALID_TRANSITIONS: StateTransition[] = [
  { from: 'proposed', action: 'propose', to: 'proposed', valid: false },
  { from: 'active', action: 'propose', to: 'proposed', valid: false },
  { from: 'active', action: 'activate', to: 'active', valid: false },
  { from: 'superseded', action: 'activate', to: 'active', valid: false },
  { from: 'draft', action: 'reactivate', to: 'active', valid: false },
  { from: 'proposed', action: 'reactivate', to: 'active', valid: false },
  { from: 'active', action: 'reactivate', to: 'active', valid: false },
];

function canTransition(from: PlanStatus, action: string): boolean {
  switch (action) {
    case 'propose':
      return from === 'draft';
    case 'activate':
      return from === 'draft' || from === 'proposed';
    case 'supersede':
      return from === 'active';
    case 'reactivate':
      return from === 'superseded';
    default:
      return false;
  }
}

function canEditDraft(status: PlanStatus, role: 'owner' | 'developer'): boolean {
  return status === 'draft' && role === 'owner';
}

describe('Plan State Machine - Valid Transitions', () => {
  VALID_TRANSITIONS.forEach(({ from, action, to, valid }) => {
    it(`should allow ${from} → ${action} → ${to}`, () => {
      expect(canTransition(from, action)).toBe(valid);
    });
  });
});

describe('Plan State Machine - Invalid Transitions', () => {
  INVALID_TRANSITIONS.forEach(({ from, action }) => {
    it(`should reject ${from} → ${action}`, () => {
      expect(canTransition(from, action)).toBe(false);
    });
  });
});

describe('Plan Draft Editing', () => {
  it('owner can edit draft', () => {
    expect(canEditDraft('draft', 'owner')).toBe(true);
  });

  it('developer cannot edit draft', () => {
    expect(canEditDraft('draft', 'developer')).toBe(false);
  });

  it('owner cannot edit proposed plan', () => {
    expect(canEditDraft('proposed', 'owner')).toBe(false);
  });

  it('owner cannot edit active plan', () => {
    expect(canEditDraft('active', 'owner')).toBe(false);
  });

  it('owner cannot edit superseded plan', () => {
    expect(canEditDraft('superseded', 'owner')).toBe(false);
  });
});
