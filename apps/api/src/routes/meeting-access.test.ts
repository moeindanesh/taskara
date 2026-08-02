import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * The two widest gaps the #59 audit left open, closed in #60: everything project-walled that a
 * **meeting** carries with it.
 *
 * A meeting's readers are its participants, its owner, its creator and workspace admins. None of
 * that is a statement about which projects those people may open, and `MeetingTask` is not
 * constrained to a project at all — so an invitation was a way to read task rows, in full, from
 * anywhere in the workspace. The meeting's own project and team came along, and so did the linked
 * task and project on every meeting action item.
 *
 * **Both halves are asserted in every test**: the outsider stops being told, and the insider is
 * still told. #59 planted over-omission as heavily as under-omission because on a fix whose
 * mechanism is *withholding*, the failure nobody reports is the reader who was entitled to it.
 *
 * The count is asserted beside the list throughout. `_count.tasks` is a relation count that no
 * `where` narrows, which is half the reason this is a redaction rather than a filter: a list that
 * shrinks by reader under a heading that does not is a surface contradicting itself.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  /** Workspace OWNER: reads everything, and is the control for over-omission. */
  adminEmail: string;
  /** On the walled team, owns the meeting, may open both projects. */
  hostEmail: string;
  hostId: string;
  /** A participant on no team: may read the meeting, may not open the walled project. */
  guestEmail: string;
  guestId: string;
  meetingId: string;
  teamName: string;
  walledProjectId: string;
  walledProjectName: string;
  openProjectId: string;
  walledTaskId: string;
  walledTaskKey: string;
  walledTaskTitle: string;
  openTaskId: string;
  openTaskTitle: string;
}

interface RedactedRef {
  redacted?: true;
}

interface MeetingView {
  id: string;
  teamId: string | null;
  team: (RedactedRef & { name?: string }) | null;
  projectId: string | null;
  project: (RedactedRef & { name?: string; keyPrefix?: string }) | null;
  tasks: Array<{ taskId: string | null; task: RedactedRef & { id?: string; key?: string; title?: string } }>;
  _count: { tasks: number; participants: number };
}

describe('meeting read access', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await prisma.user.deleteMany({
      where: { email: { in: [fixture.adminEmail, fixture.hostEmail, fixture.guestEmail] } }
    });
    await app.close();
  });

  /**
   * The whole gap in one assertion: the linked task row, description and all, reaching a participant
   * who cannot open the project it lives in.
   */
  test('a task behind a team wall is blanked for a meeting guest, and whole for the host', async () => {
    const guestView = await readMeeting(fixture.guestEmail);
    expect(taskIds(guestView)).toEqual([null, fixture.openTaskId]);
    expect(guestView.tasks[0].task).toEqual({ redacted: true });
    expect(bodyOf(guestView)).not.toContain(fixture.walledTaskTitle);
    expect(bodyOf(guestView)).not.toContain(fixture.walledTaskKey);
    expect(bodyOf(guestView)).not.toContain('the description nobody outside the team may read');

    const hostView = await readMeeting(fixture.hostEmail);
    expect(taskIds(hostView)).toEqual([fixture.walledTaskId, fixture.openTaskId]);
    expect(bodyOf(hostView)).toContain(fixture.walledTaskTitle);
    expect(bodyOf(hostView)).toContain('the description nobody outside the team may read');
  });

  /**
   * Redacted rather than dropped, and this is the assertion that says why. `_count.tasks` is a
   * relation count: no `where` on the include narrows it, so filtering the list would leave the two
   * disagreeing for exactly the reader who cannot check.
   */
  test('the task count matches the list for both readers', async () => {
    for (const email of [fixture.guestEmail, fixture.hostEmail, fixture.adminEmail]) {
      const view = await readMeeting(email);
      expect(view.tasks).toHaveLength(2);
      expect(view._count.tasks).toBe(2);
    }
  });

  /** A meeting names a project and a team, and neither is a participant's to read either. */
  test('the meeting project and team are blanked for a guest and named for the host', async () => {
    const guestView = await readMeeting(fixture.guestEmail);
    expect(guestView.project).toEqual({ redacted: true });
    expect(guestView.projectId).toBeNull();
    expect(guestView.team).toEqual({ redacted: true });
    expect(guestView.teamId).toBeNull();
    expect(bodyOf(guestView)).not.toContain(fixture.walledProjectName);
    expect(bodyOf(guestView)).not.toContain(fixture.teamName);

    const hostView = await readMeeting(fixture.hostEmail);
    expect(hostView.project?.name).toBe(fixture.walledProjectName);
    expect(hostView.projectId).toBe(fixture.walledProjectId);
    expect(hostView.team?.name).toBe(fixture.teamName);
  });

  /** A workspace admin reads everything, which is the branch an over-eager filter takes out first. */
  test('a workspace admin sees the walled task, project and team', async () => {
    const adminView = await readMeeting(fixture.adminEmail);
    expect(taskIds(adminView)).toEqual([fixture.walledTaskId, fixture.openTaskId]);
    expect(adminView.project?.name).toBe(fixture.walledProjectName);
    expect(adminView.team?.name).toBe(fixture.teamName);
  });

  /**
   * Four handlers return a meeting and each one is its own way to forget. The list and the two
   * writes are checked separately from the detail read above, because three of the four were
   * written in a different file from the fourth.
   */
  test('the meeting list redacts for a guest and does not for the host', async () => {
    const guestList = await listMeetings(fixture.guestEmail);
    expect(guestList.tasks[0].task).toEqual({ redacted: true });
    expect(guestList.project).toEqual({ redacted: true });
    expect(guestList._count.tasks).toBe(2);

    const hostList = await listMeetings(fixture.hostEmail);
    expect(hostList.tasks[0].task.id).toBe(fixture.walledTaskId);
    expect(hostList.project?.name).toBe(fixture.walledProjectName);
  });

  test('a guest editing the meeting gets the redacted meeting back, and the host does not', async () => {
    const guestPatch = await patchMeeting(fixture.guestEmail, 'Retro, renamed by the guest');
    expect(guestPatch.tasks[0].task).toEqual({ redacted: true });
    expect(guestPatch.project).toEqual({ redacted: true });
    expect(guestPatch._count.tasks).toBe(2);

    const hostPatch = await patchMeeting(fixture.hostEmail, 'Retro');
    expect(hostPatch.tasks[0].task.id).toBe(fixture.walledTaskId);
    expect(hostPatch.project?.name).toBe(fixture.walledProjectName);
  });

  test('creating a meeting returns the project the creator may read', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/meetings',
      headers: headers(fixture.hostEmail),
      payload: { title: 'Kickoff', projectId: fixture.walledProjectId, participantIds: [fixture.guestId] }
    });
    expect(response.statusCode).toBe(201);
    const created = response.json() as MeetingView;
    expect(created.project?.name).toBe(fixture.walledProjectName);
    expect(created.tasks).toEqual([]);
  });

  /** A meeting with no project and no team is nobody's wall, so nothing is withheld from anybody. */
  test('a project on no team is readable by a guest', async () => {
    const guestView = await readMeeting(fixture.guestEmail);
    const openLink = guestView.tasks[1];
    expect(openLink.taskId).toBe(fixture.openTaskId);
    expect(openLink.task.title).toBe(fixture.openTaskTitle);
  });
});

function headers(email: string) {
  return { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email };
}

function taskIds(meeting: MeetingView): Array<string | null> {
  return meeting.tasks.map((link) => link.taskId);
}

function bodyOf(value: unknown): string {
  return JSON.stringify(value);
}

async function readMeeting(email: string): Promise<MeetingView> {
  const response = await app.inject({
    method: 'GET',
    url: `/meetings/${fixture.meetingId}`,
    headers: headers(email)
  });
  expect(response.statusCode).toBe(200);
  return response.json() as MeetingView;
}

async function listMeetings(email: string): Promise<MeetingView> {
  const response = await app.inject({ method: 'GET', url: '/meetings', headers: headers(email) });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { items: MeetingView[] };
  const meeting = body.items.find((item) => item.id === fixture.meetingId);
  expect(meeting).toBeDefined();
  return meeting as MeetingView;
}

async function patchMeeting(email: string, title: string): Promise<MeetingView> {
  const response = await app.inject({
    method: 'PATCH',
    url: `/meetings/${fixture.meetingId}`,
    headers: headers(email),
    payload: { title }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as MeetingView;
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const adminEmail = `ma-admin-${suffix}@example.test`;
  const hostEmail = `ma-host-${suffix}@example.test`;
  const guestEmail = `ma-guest-${suffix}@example.test`;

  const admin = await prisma.user.create({ data: { email: adminEmail, name: 'Admin' } });
  const host = await prisma.user.create({ data: { email: hostEmail, name: 'Host' } });
  const guest = await prisma.user.create({ data: { email: guestEmail, name: 'Guest' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'Meeting access workspace', slug: `ma-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: admin.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: host.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: guest.id, role: 'MEMBER' }
    ]
  });

  const teamName = `Walled ${suffix}`;
  const team = await prisma.team.create({
    data: { workspaceId: workspace.id, name: teamName, slug: `ma-walled-${suffix}` }
  });
  await prisma.teamMember.create({ data: { teamId: team.id, userId: host.id, role: 'MEMBER' } });

  const prefix = suffix.slice(0, 3).toUpperCase();
  const walledProjectName = `Walled project ${suffix}`;
  const walledProject = await prisma.project.create({
    data: { workspaceId: workspace.id, name: walledProjectName, keyPrefix: `MW${prefix}`, teamId: team.id }
  });
  // No team of its own, so `canReadProject` admits everybody — the positive control.
  const openProject = await prisma.project.create({
    data: { workspaceId: workspace.id, name: `Open project ${suffix}`, keyPrefix: `MO${prefix}` }
  });

  const walledTaskTitle = `walled follow-up ${suffix}`;
  const openTaskTitle = `open follow-up ${suffix}`;
  const walledTask = await createTask(workspace.slug, hostEmail, {
    projectId: walledProject.id,
    title: walledTaskTitle,
    description: 'the description nobody outside the team may read'
  });
  const openTask = await createTask(workspace.slug, hostEmail, {
    projectId: openProject.id,
    title: openTaskTitle
  });

  const meeting = await prisma.meeting.create({
    data: {
      workspaceId: workspace.id,
      teamId: team.id,
      projectId: walledProject.id,
      ownerId: host.id,
      createdById: host.id,
      title: 'Retro'
    }
  });
  await prisma.meetingParticipant.createMany({
    data: [
      { workspaceId: workspace.id, meetingId: meeting.id, userId: host.id, role: 'OWNER' },
      { workspaceId: workspace.id, meetingId: meeting.id, userId: guest.id, role: 'PARTICIPANT' }
    ]
  });
  // `createdAt: desc` orders the include, so the walled link has to be written last to sit first.
  await prisma.meetingTask.create({
    data: { meetingId: meeting.id, taskId: openTask.id, createdById: host.id }
  });
  await prisma.meetingTask.create({
    data: { meetingId: meeting.id, taskId: walledTask.id, createdById: host.id }
  });

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    adminEmail,
    hostEmail,
    hostId: host.id,
    guestEmail,
    guestId: guest.id,
    meetingId: meeting.id,
    teamName,
    walledProjectId: walledProject.id,
    walledProjectName,
    openProjectId: openProject.id,
    walledTaskId: walledTask.id,
    walledTaskKey: walledTask.key,
    walledTaskTitle,
    openTaskId: openTask.id,
    openTaskTitle
  };
}

async function createTask(
  workspaceSlug: string,
  email: string,
  payload: { projectId: string; title: string; description?: string }
): Promise<{ id: string; key: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-workspace-slug': workspaceSlug, 'x-user-email': email },
    payload
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { id: string; key: string };
  return { id: body.id, key: body.key };
}
