import type { Prisma } from '@taskara/db';
import { canReadProject, canReadTeam, type WorkspaceAccess } from './team-access';
import { taskInclude } from './tasks';

/**
 * What a reader sees of the project-walled things a **meeting** carries.
 *
 * Issue #60, closing the two widest gaps the #59 audit enumerated. A meeting is not a project-walled
 * entity: its readers are its participants, its owner, its creator and workspace admins, and none of
 * that says anything about which projects those people may open. But `meetingInclude` hung the whole
 * task row off every `MeetingTask` edge with **no `where` at all**, and `MeetingTask` is not
 * constrained to a project (`schema.prisma:995`) — so inviting somebody to a meeting handed them the
 * key, title, description, assignee and labels of every task linked to it, from anywhere in the
 * workspace. The meeting's own project and team came with it: name, key prefix, slug.
 *
 * That is shape **A** from the audit — *gate the container, forget the contents* — and the rule it
 * yields is written down there: **any include that crosses from a non-project-walled entity into a
 * project-walled one is a wall crossing, and the reader's right to the container implies nothing
 * about the contents.** A meeting, and the action items hanging off it, are two such containers.
 *
 * ## Redacted, not omitted — #58's answer, not #59's
 *
 * The two prior tickets in this chain reached opposite conclusions and both were right, so the
 * choice has to be argued per surface rather than inherited:
 *
 * - #59 **dropped** unreadable rows from the workspace activity feed, because a feed is already a
 *   window on an unbounded stream and nobody decides anything from a missing row.
 * - #58 **redacted** the far end of an unreadable dependency edge, because a blocker list that
 *   shrinks by reader makes a blocked task read as *takeable* — the list is load-bearing.
 *
 * A meeting's task list is the second kind. Its length is published beside it as `_count.tasks`,
 * which no `where` on the relation narrows (audit shape **D**), so dropping edges would put a list
 * of two under a heading that says three — and "this meeting produced no follow-up" is a claim
 * somebody acts on. Every edge therefore survives with its far end replaced by {@link RedactedRef},
 * and the count stays honest for free because the list length never changes.
 *
 * **No handle of any kind**, on #58's reasoning: no id, no key, no title, and the foreign key on the
 * edge row is nulled too, because a redaction that ships the hidden task's primary key is cosmetic —
 * the id is what correlates the same hidden task across every surface that mentions it.
 *
 * **And no `open` bit**, unlike #58's placeholder. That bit exists because takeability is computed
 * from the live edge list; nothing computes anything from a meeting's task list, so the bit would be
 * a disclosure with no reader. Same call #59 made for the activity timeline.
 */

/** A relation this reader may not open: the fact that it is there, and nothing else. */
export interface RedactedRef {
  redacted: true;
}

const REDACTED: RedactedRef = { redacted: true };

/** Whether {@link visibleMeeting} or {@link visibleMeetingActionItem} blanked this one. */
export function isRedactedRef(value: unknown): value is RedactedRef {
  return typeof value === 'object' && value !== null && (value as Partial<RedactedRef>).redacted === true;
}

/** The project facts `canReadProject` asks about. */
type ProjectRef = { id: string; teamId: string | null; leadId: string | null };

/**
 * The facts the decision needs, pulled along with whatever carries the project.
 *
 * Spread into a select that already has the display fields, exactly as #58's
 * `relatedTaskAccessInclude` does. {@link withoutProjectAccessFacts} strips them back off wherever
 * they were not already on the wire, so a reader who may open the far end gets the row they got
 * before this module existed.
 */
const projectAccessFacts = { id: true, teamId: true, leadId: true } as const;

/**
 * The task hanging off a `MeetingTask` edge, plus the facts needed to decide whether to show it.
 *
 * `taskInclude.project` already selects `team: { id }`, which would answer the team branch — but not
 * `leadId`, and a project lead who is on neither the team nor the member list is one of the four
 * ways `canReadProject` admits a reader. Guessing from the two branches that happen to be present is
 * how an access fix turns into an outage three weeks later, so the real facts are fetched.
 */
export const meetingTaskInclude = {
  task: {
    include: {
      ...taskInclude,
      project: { select: { ...taskInclude.project.select, ...projectAccessFacts } }
    }
  }
} satisfies Prisma.MeetingTaskInclude;

/** The meeting's own project, which a participant is no more entitled to than to its tasks. */
export const meetingProjectSelect = {
  ...projectAccessFacts,
  name: true,
  keyPrefix: true
} satisfies Prisma.ProjectSelect;

type TaskWithProject = { project: ProjectRef };
type MeetingTaskLink = { taskId: string; task: TaskWithProject };

type MeetingForReader = {
  teamId: string | null;
  team: unknown;
  projectId: string | null;
  project: ProjectRef | null;
  tasks: MeetingTaskLink[];
};

/**
 * A meeting as this reader may see it: the meeting itself untouched, its walled contents blanked.
 *
 * **The decision is `canReadProject` / `canReadTeam`**, called once per thing carried. Nothing here
 * restates either rule — the includes above only gather the facts to ask them with, which is the
 * discipline #37 asked for and #57's `filterUsersWithTaskAccess` and #58's `visibleRelatedTask`
 * established.
 *
 * The meeting row itself is never withheld: who may read a meeting is already decided, correctly and
 * by a different rule, before this is called.
 */
export function visibleMeeting<T extends MeetingForReader>(access: WorkspaceAccess, meeting: T) {
  const projectReadable = !meeting.project || canReadProject(access, meeting.project);
  const teamReadable = canReadTeam(access, meeting.teamId);

  return {
    ...meeting,
    // A team id and a project id are handles like any other, so they go with the row they name.
    teamId: teamReadable ? meeting.teamId : null,
    team: teamReadable ? meeting.team : meeting.team ? REDACTED : null,
    projectId: projectReadable ? meeting.projectId : null,
    project: projectReadable ? meeting.project : REDACTED,
    tasks: meeting.tasks.map((link) => visibleMeetingTaskLink(access, link))
  };
}

function visibleMeetingTaskLink<T extends MeetingTaskLink>(access: WorkspaceAccess, link: T) {
  if (!canReadProject(access, link.task.project)) {
    return { ...link, taskId: null, task: REDACTED };
  }
  return { ...link, task: withoutProjectAccessFacts(link.task) };
}

/**
 * The task an action item was converted into, plus the facts to decide whether to name it.
 *
 * The project is not otherwise on this shape and is stripped whole by
 * {@link visibleMeetingActionItem}, so nothing new reaches a reader who may open the task.
 */
export const actionItemTaskSelect = {
  id: true,
  key: true,
  title: true,
  status: true,
  project: { select: projectAccessFacts }
} satisfies Prisma.TaskSelect;

/**
 * A meeting action item as this reader may see it.
 *
 * Two crossings in one row, and they are independent. The **linked task** may live in any project —
 * `createTaskFromMeetingActionItem` takes a `projectId` from the caller — so it is redacted on its
 * own project. The **meeting's project** is redacted on its own, which also covers the action item
 * belonging to a meeting whose project the reader cannot open.
 *
 * The action item's own fields (title, notes, assignee, due date) stay: they belong to the meeting,
 * which this reader is already entitled to.
 */
export function visibleMeetingActionItem<
  T extends {
    taskId: string | null;
    task: TaskWithProject | null;
    meeting: { projectId: string | null; project: ProjectRef | null } | null;
  }
>(access: WorkspaceAccess, item: T) {
  const taskReadable = !item.task || canReadProject(access, item.task.project);
  const meeting = item.meeting;
  const meetingProjectReadable = !meeting?.project || canReadProject(access, meeting.project);

  return {
    ...item,
    taskId: taskReadable ? item.taskId : null,
    task: taskReadable ? (item.task && withoutProject(item.task)) : REDACTED,
    meeting: !meeting
      ? meeting
      : {
          ...meeting,
          projectId: meetingProjectReadable ? meeting.projectId : null,
          project: meetingProjectReadable ? meeting.project : REDACTED
        }
  };
}

/**
 * The access facts taken back off, so the readable case is byte-for-byte what it was before.
 *
 * Only where they were not already published: the meeting's own project has carried `teamId` and
 * `leadId` since long before this, and `visibleMeeting` leaves it alone.
 */
function withoutProjectAccessFacts<P extends ProjectRef, T extends { project: P }>(row: T) {
  const { teamId: _teamId, leadId: _leadId, ...project } = row.project;
  return { ...row, project };
}

/** The same, where the project was fetched only to ask the question and was never on the wire. */
function withoutProject<T extends { project: unknown }>(row: T): Omit<T, 'project'> {
  const { project: _project, ...rest } = row;
  return rest;
}
