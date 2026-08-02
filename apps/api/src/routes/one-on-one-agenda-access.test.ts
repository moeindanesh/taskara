import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * Gap 3 of the #59 audit: `GET /one-on-ones/:id/agenda` generated talking points out of the
 * participant's whole working life, with no clause about who was reading.
 *
 * `requireOneOnOneAccess` admits the manager, the participant and workspace admins — and that is a
 * decision about the **series**. A manager running a 1:1 with somebody on another team got
 * `KEY: Title` for every open task assigned to them, the titles behind their attention items, and
 * the action items from meetings the manager is not on.
 *
 * Both halves throughout: the manager stops being told, and the participant (who is on the team)
 * and the admin still are. The candidate list is generated, so an over-eager filter here does not
 * fail loudly anywhere — it just produces an empty agenda that reads like a quiet fortnight.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  adminEmail: string;
  /** Runs the 1:1, is on no team, may not open the walled project. */
  managerEmail: string;
  /** The subject of the 1:1, on the walled team. */
  participantEmail: string;
  seriesId: string;
  walledTaskKey: string;
  walledTaskTitle: string;
  openTaskKey: string;
  openTaskTitle: string;
  walledAttentionTitle: string;
  openAttentionTitle: string;
  unplacedAttentionTitle: string;
  walledActionItemTitle: string;
  openActionItemTitle: string;
}

interface AgendaCandidate {
  sourceType: string;
  sourceId: string;
  title: string;
}

describe('1:1 agenda read access', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await prisma.user.deleteMany({
      where: { email: { in: [fixture.adminEmail, fixture.managerEmail, fixture.participantEmail] } }
    });
    await app.close();
  });

  test('a task behind a team wall is absent from the manager agenda and present for the participant', async () => {
    const managerAgenda = await readAgenda(fixture.managerEmail);
    expect(titles(managerAgenda)).not.toContain(`${fixture.walledTaskKey}: ${fixture.walledTaskTitle}`);
    expect(bodyOf(managerAgenda)).not.toContain(fixture.walledTaskKey);
    // The half that turns a fix into an outage: the readable one still arrives.
    expect(titles(managerAgenda)).toContain(`${fixture.openTaskKey}: ${fixture.openTaskTitle}`);

    const participantAgenda = await readAgenda(fixture.participantEmail);
    expect(titles(participantAgenda)).toContain(`${fixture.walledTaskKey}: ${fixture.walledTaskTitle}`);
    expect(titles(participantAgenda)).toContain(`${fixture.openTaskKey}: ${fixture.openTaskTitle}`);
  });

  test('a workspace admin sees the walled task on the agenda', async () => {
    const adminAgenda = await readAgenda(fixture.adminEmail);
    expect(titles(adminAgenda)).toContain(`${fixture.walledTaskKey}: ${fixture.walledTaskTitle}`);
  });

  /**
   * `AttentionItem` is a polymorphic pointer with no relation behind it, so the rule is a table with
   * a deny default — the same shape #59 met on the activity log.
   */
  test('attention items are placed by their entity, and an unplaced type is denied', async () => {
    const managerAgenda = await readAgenda(fixture.managerEmail);
    expect(titles(managerAgenda)).not.toContain(fixture.walledAttentionTitle);
    expect(titles(managerAgenda)).toContain(fixture.openAttentionTitle);
    expect(titles(managerAgenda)).not.toContain(fixture.unplacedAttentionTitle);

    const participantAgenda = await readAgenda(fixture.participantEmail);
    expect(titles(participantAgenda)).toContain(fixture.walledAttentionTitle);
    expect(titles(participantAgenda)).toContain(fixture.openAttentionTitle);
    // Deny by default is about the type, not about the reader: only an admin, who short-circuits
    // the whole table, gets a row nobody has placed.
    expect(titles(participantAgenda)).not.toContain(fixture.unplacedAttentionTitle);

    expect(titles(await readAgenda(fixture.adminEmail))).toContain(fixture.unplacedAttentionTitle);
  });

  /** An action item is walled by its meeting rather than by a project, so it asks the meeting rule. */
  test('an action item from a meeting the manager is not on is absent from the agenda', async () => {
    const managerAgenda = await readAgenda(fixture.managerEmail);
    expect(titles(managerAgenda)).not.toContain(fixture.walledActionItemTitle);
    expect(titles(managerAgenda)).toContain(fixture.openActionItemTitle);

    const participantAgenda = await readAgenda(fixture.participantEmail);
    expect(titles(participantAgenda)).toContain(fixture.walledActionItemTitle);
  });
});

function headers(email: string) {
  return { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email };
}

function bodyOf(value: unknown): string {
  return JSON.stringify(value);
}

function titles(candidates: AgendaCandidate[]): string[] {
  return candidates.map((candidate) => candidate.title);
}

async function readAgenda(email: string): Promise<AgendaCandidate[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/one-on-ones/${fixture.seriesId}/agenda`,
    headers: headers(email)
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { generated: AgendaCandidate[] }).generated;
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const adminEmail = `oa-admin-${suffix}@example.test`;
  const managerEmail = `oa-manager-${suffix}@example.test`;
  const participantEmail = `oa-part-${suffix}@example.test`;

  const admin = await prisma.user.create({ data: { email: adminEmail, name: 'Admin' } });
  const manager = await prisma.user.create({ data: { email: managerEmail, name: 'Manager' } });
  const participant = await prisma.user.create({ data: { email: participantEmail, name: 'Participant' } });
  const workspace = await prisma.workspace.create({
    data: { name: '1:1 agenda workspace', slug: `oa-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: admin.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: manager.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: participant.id, role: 'MEMBER' }
    ]
  });

  const team = await prisma.team.create({
    data: { workspaceId: workspace.id, name: `Walled ${suffix}`, slug: `oa-walled-${suffix}` }
  });
  await prisma.teamMember.create({ data: { teamId: team.id, userId: participant.id, role: 'MEMBER' } });

  const prefix = suffix.slice(0, 3).toUpperCase();
  const walledProject = await prisma.project.create({
    data: { workspaceId: workspace.id, name: `Walled ${suffix}`, keyPrefix: `OW${prefix}`, teamId: team.id }
  });
  const openProject = await prisma.project.create({
    data: { workspaceId: workspace.id, name: `Open ${suffix}`, keyPrefix: `OO${prefix}` }
  });

  const walledTaskTitle = `walled work ${suffix}`;
  const openTaskTitle = `open work ${suffix}`;
  // Overdue, because the generator only proposes a task that is blocked or past its due date.
  const overdue = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const walledTask = await createTask(workspace.slug, adminEmail, {
    projectId: walledProject.id,
    title: walledTaskTitle,
    assigneeId: participant.id,
    dueAt: overdue
  });
  const openTask = await createTask(workspace.slug, adminEmail, {
    projectId: openProject.id,
    title: openTaskTitle,
    assigneeId: participant.id,
    dueAt: overdue
  });

  const series = await prisma.oneOnOneSeries.create({
    data: {
      workspaceId: workspace.id,
      managerId: manager.id,
      participantId: participant.id,
      title: 'Fortnightly'
    }
  });

  const walledAttentionTitle = `walled attention ${suffix}`;
  const openAttentionTitle = `open attention ${suffix}`;
  const unplacedAttentionTitle = `unplaced attention ${suffix}`;
  await prisma.attentionItem.createMany({
    data: [
      {
        workspaceId: workspace.id,
        assigneeId: participant.id,
        entityType: 'task',
        entityId: walledTask.id,
        reason: 'review_waiting',
        severity: 'HIGH',
        payload: { title: walledAttentionTitle }
      },
      {
        workspaceId: workspace.id,
        assigneeId: participant.id,
        entityType: 'task',
        entityId: openTask.id,
        reason: 'backlog_triage',
        severity: 'MEDIUM',
        payload: { title: openAttentionTitle }
      },
      // A type nobody has placed in the table. Written straight to the row, which is the only way
      // one can exist, and exactly how a legacy row or a future ticket's entity would arrive.
      {
        workspaceId: workspace.id,
        assigneeId: participant.id,
        entityType: 'brand_new_thing',
        entityId: walledTask.id,
        reason: 'something_new',
        severity: 'HIGH',
        payload: { title: unplacedAttentionTitle }
      }
    ]
  });

  // Two meetings: one the manager is on, one they are not.
  const walledMeeting = await prisma.meeting.create({
    data: {
      workspaceId: workspace.id,
      ownerId: participant.id,
      createdById: participant.id,
      title: `walled meeting ${suffix}`
    }
  });
  await prisma.meetingParticipant.create({
    data: { workspaceId: workspace.id, meetingId: walledMeeting.id, userId: participant.id, role: 'OWNER' }
  });
  const sharedMeeting = await prisma.meeting.create({
    data: {
      workspaceId: workspace.id,
      ownerId: manager.id,
      createdById: manager.id,
      title: `shared meeting ${suffix}`
    }
  });
  await prisma.meetingParticipant.createMany({
    data: [
      { workspaceId: workspace.id, meetingId: sharedMeeting.id, userId: manager.id, role: 'OWNER' },
      { workspaceId: workspace.id, meetingId: sharedMeeting.id, userId: participant.id, role: 'PARTICIPANT' }
    ]
  });

  const walledActionItemTitle = `walled action ${suffix}`;
  const openActionItemTitle = `shared action ${suffix}`;
  await prisma.meetingActionItem.createMany({
    data: [
      {
        workspaceId: workspace.id,
        meetingId: walledMeeting.id,
        assigneeId: participant.id,
        createdById: participant.id,
        title: walledActionItemTitle
      },
      {
        workspaceId: workspace.id,
        meetingId: sharedMeeting.id,
        assigneeId: participant.id,
        createdById: manager.id,
        title: openActionItemTitle
      }
    ]
  });

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    adminEmail,
    managerEmail,
    participantEmail,
    seriesId: series.id,
    walledTaskKey: walledTask.key,
    walledTaskTitle,
    openTaskKey: openTask.key,
    openTaskTitle,
    walledAttentionTitle,
    openAttentionTitle,
    unplacedAttentionTitle,
    walledActionItemTitle,
    openActionItemTitle
  };
}

async function createTask(
  workspaceSlug: string,
  email: string,
  payload: { projectId: string; title: string; assigneeId?: string; dueAt?: string }
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
