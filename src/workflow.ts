import type { Role } from './permissions';

export const STATUSES = ['open', 'in_progress', 'awaiting_approval', 'resolved', 'closed'] as const;
export type Status = (typeof STATUSES)[number];
export const ACTIVE_STATUSES: Status[] = ['open', 'in_progress', 'awaiting_approval'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'] as const;

export interface Rule {
  label: string;
  minRole: Role;
  /** members may only do this on items assigned to them (leads/admins are exempt) */
  memberMustBeAssignee?: boolean;
  requiresAssignee?: boolean;
}

/**
 * Allowed transitions (server-enforced):
 *
 *   open --> in_progress --> awaiting_approval --> resolved --> closed
 *               ^   ^______________|  (lead rejects)   |
 *               |__________________________________ (reopen)
 *
 * The approval step (awaiting_approval -> resolved / back to in_progress) is Lead-only.
 */
export const TRANSITIONS: Record<Status, Partial<Record<Status, Rule>>> = {
  open: {
    in_progress: { label: 'Start work', minRole: 'member', memberMustBeAssignee: true, requiresAssignee: true },
  },
  in_progress: {
    awaiting_approval: { label: 'Request approval', minRole: 'member', memberMustBeAssignee: true },
  },
  awaiting_approval: {
    resolved: { label: 'Approve & resolve', minRole: 'lead' },
    in_progress: { label: 'Reject (back to work)', minRole: 'lead' },
  },
  resolved: {
    closed: { label: 'Close', minRole: 'lead' },
    in_progress: { label: 'Reopen', minRole: 'member' },
  },
  closed: {},
};

export function getRule(from: string, to: string): Rule | undefined {
  return TRANSITIONS[from as Status]?.[to as Status];
}
