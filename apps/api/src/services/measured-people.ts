import type { Prisma, UserKind, WorkspaceRole } from '@taskara/db';

/**
 * Who counts as a person being measured.
 *
 * Agents are teammates: they appear in the directory, on the graph and in every picker. They are
 * never *measured*, because every people metric in Taskara — participation, workload, capacity,
 * the leaderboard, the missing-report nudges — exists to judge how humans are doing. Counting a
 * tireless process alongside them makes each of those numbers mean something else.
 *
 * BOTH clauses are load-bearing, and neither implies the other:
 *   - Dropping `role` re-admits GUEST humans to every metric. Guests are outside contributors who
 *     were never asked for a daily report, so they would arrive as permanent non-participants.
 *   - Dropping `user.kind` misses every agent whose membership role is not literally AGENT. An
 *     agent may hold MEMBER or ADMIN — WorkspaceRole.AGENT is a *permission* role, not a species —
 *     so role alone cannot answer "is this a person".
 *
 * This is deliberately NOT in team-access.ts. That module answers an authorization question ("what
 * may this actor read"); this one answers a measurement question ("whose behaviour counts"). Using
 * a measurement predicate on a read path would make agents invisible, which is the opposite half of
 * the same mistake.
 */
export const measuredMemberWhere = {
  role: { not: 'GUEST' },
  user: { kind: 'HUMAN' }
} satisfies Prisma.WorkspaceMemberWhereInput;

/**
 * The same population expressed from the subject's side, for rows that hang off User rather than
 * WorkspaceMember (CheckInResponse.user). A CheckInResponse carries no role of its own, so a query
 * over report rows has to reach the membership through the person who filed it.
 *
 * Keep this in step with measuredMemberWhere: a numerator drawn with one and a denominator drawn
 * with the other must describe exactly the same set of people, or the ratio is meaningless.
 */
export function measuredSubjectWhere(workspaceId: string): Prisma.UserWhereInput {
  return {
    kind: 'HUMAN',
    workspaces: { some: { workspaceId, role: { not: 'GUEST' } } }
  };
}

/**
 * In-memory form, for candidate lists that are materialised in full and then filtered with
 * per-reason counters the caller reports back to the user. Filtering those at the query would
 * silently zero the counters instead of explaining the exclusion.
 */
export function isMeasuredMember(member: { role: WorkspaceRole; userKind: UserKind }): boolean {
  return member.role !== 'GUEST' && member.userKind === 'HUMAN';
}
