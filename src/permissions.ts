import { HttpError, forbidden, notFound } from './errors';
import { getRule, type Rule } from './workflow';

export const ROLE_RANK = { viewer: 0, member: 1, lead: 2, admin: 3 } as const;
export type Role = keyof typeof ROLE_RANK;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roles: Map<string, Role>; // teamId -> role
}

export type Action =
  | 'item:read'
  | 'item:create'
  | 'item:update'
  | 'item:claim'
  | 'item:comment'
  | 'item:transition';

/**
 * Role x action matrix (minimum role per team).
 *
 *               viewer  member  lead  admin
 *  read           x       x      x      x
 *  create                 x      x      x
 *  update                 x      x      x
 *  claim                  x      x      x
 *  comment                x      x      x
 *  transition             x      x      x    (per-transition rules in workflow.ts)
 */
const MIN_ROLE: Record<Action, Role> = {
  'item:read': 'viewer',
  'item:create': 'member',
  'item:update': 'member',
  'item:claim': 'member',
  'item:comment': 'member',
  'item:transition': 'member',
};

export const roleAtLeast = (role: Role | undefined, min: Role) =>
  role !== undefined && ROLE_RANK[role] >= ROLE_RANK[min];

export const can = (user: AuthUser, teamId: string, action: Action) =>
  roleAtLeast(user.roles.get(teamId), MIN_ROLE[action]);

/**
 * THE permission check. Every item endpoint goes through this (via items.ts).
 * - Not a member of the team: 404 when `conceal` (we don't reveal that the item exists), else 403.
 * - Member with too low a role: 403.
 */
export function assertCan(
  user: AuthUser,
  teamId: string,
  action: Action,
  opts: { conceal?: boolean } = {},
): Role {
  const role = user.roles.get(teamId);
  if (!role) throw opts.conceal ? notFound() : forbidden('You are not a member of this team');
  if (!can(user, teamId, action)) {
    throw forbidden(`Your role (${role}) cannot perform ${action}`);
  }
  return role;
}

export type TransitionCheck = 'ok' | 'forbidden_role' | 'forbidden_not_assignee' | 'assignee_required';

/** Shared by the enforcing code and by the "what can I do" hints sent to the UI. */
export function checkTransition(
  user: AuthUser,
  item: { team_id: string; assignee_id: string | null },
  rule: Rule,
): TransitionCheck {
  const role = user.roles.get(item.team_id);
  if (!roleAtLeast(role, rule.minRole)) return 'forbidden_role';
  // Check "unassigned" before "not the assignee" so the user is told to claim first.
  if (rule.requiresAssignee && !item.assignee_id) return 'assignee_required';
  const isLeadPlus = roleAtLeast(role, 'lead');
  if (rule.memberMustBeAssignee && !isLeadPlus && item.assignee_id !== user.id) {
    return 'forbidden_not_assignee';
  }
  return 'ok';
}

export function assertCanTransition(
  user: AuthUser,
  item: { team_id: string; status: string; assignee_id: string | null },
  to: string,
): void {
  const rule = getRule(item.status, to);
  if (!rule) {
    throw new HttpError(422, 'invalid_transition', `Cannot move from ${item.status} to ${to}`);
  }
  switch (checkTransition(user, item, rule)) {
    case 'forbidden_role':
      throw forbidden(`Only ${rule.minRole}s (or above) can move an item from ${item.status} to ${to}`);
    case 'forbidden_not_assignee':
      throw forbidden('Only the assignee or a lead can make this change');
    case 'assignee_required':
      throw new HttpError(422, 'assignee_required', 'Claim the item before starting work on it');
    default:
  }
}
