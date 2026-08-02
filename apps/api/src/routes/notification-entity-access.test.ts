import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * Gap 4 of the #59 audit: the three inbox branches #57 did not reach.
 *
 * #57 gated the `taskId` branch, and the argument it used was never about tasks — **a notification
 * row outlives the reach it was written under**. The recipient is resolved once, at write time, and
 * the entity moves afterwards. The other three branches have the same drift and had no gate at all:
 *
 * - a **meeting** the recipient was removed from,
 * - a **knowledge page** in a PROJECT space whose project's team was reassigned,
 * - an **announcement** whose recipient list was replaced.
 *
 * Each row goes on delivering a title into an inbox and hydrating the entity beside it, which is
 * the disclosure #57 established a delivered row to be.
 *
 * Both halves everywhere: the person who lost reach stops being told, and the person who still has
 * it still is. A notification pointing at nothing — a daily-report reminder — has to survive all of
 * it, because that is the branch an over-eager `OR` takes out first and nobody notices.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  adminEmail: string;
  adminId: string;
  /** Still on the meeting, still on the team, still a recipient. The control. */
  insiderEmail: string;
  insiderId: string;
  /** Held all three once and holds none now. Every row below is still in their table. */
  outsiderEmail: string;
  outsiderId: string;
  meetingTitle: string;
  pageTitle: string;
  announcementTitle: string;
  reminderTitle: string;
}

describe('inbox access for the non-task branches', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await prisma.user.deleteMany({
      where: { email: { in: [fixture.adminEmail, fixture.insiderEmail, fixture.outsiderEmail] } }
    });
    await app.close();
  });

  test('a meeting the recipient was removed from stops being delivered, and still reaches a participant', async () => {
    expect(await inboxTitles(fixture.outsiderEmail)).not.toContain(fixture.meetingTitle);
    expect(await inboxTitles(fixture.insiderEmail)).toContain(fixture.meetingTitle);
    expect(await inboxTitles(fixture.adminEmail)).toContain(fixture.meetingTitle);
  });

  test('a knowledge page whose project moved behind a team wall stops being delivered', async () => {
    expect(await inboxTitles(fixture.outsiderEmail)).not.toContain(fixture.pageTitle);
    expect(await inboxTitles(fixture.insiderEmail)).toContain(fixture.pageTitle);
    expect(await inboxTitles(fixture.adminEmail)).toContain(fixture.pageTitle);
  });

  test('an announcement the recipient was dropped from stops being delivered', async () => {
    expect(await inboxTitles(fixture.outsiderEmail)).not.toContain(fixture.announcementTitle);
    expect(await inboxTitles(fixture.insiderEmail)).toContain(fixture.announcementTitle);
    expect(await inboxTitles(fixture.adminEmail)).toContain(fixture.announcementTitle);
  });

  /**
   * The row that points at nothing. It matched the catch-all branch before and has to still, or the
   * fix reads as "the inbox went quiet" three weeks later.
   */
  test('a notification with no entity behind it still reaches everybody', async () => {
    for (const email of [fixture.outsiderEmail, fixture.insiderEmail, fixture.adminEmail]) {
      expect(await inboxTitles(email)).toContain(fixture.reminderTitle);
    }
  });

  /** The badge reads the same predicate, so it has to agree with the list it is counting. */
  test('the unread badge counts what the inbox shows', async () => {
    expect(await unreadBadge(fixture.outsiderEmail)).toBe((await inboxTitles(fixture.outsiderEmail)).length);
    expect(await unreadBadge(fixture.insiderEmail)).toBe((await inboxTitles(fixture.insiderEmail)).length);
  });
});

function headers(email: string) {
  return { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email };
}

async function inboxTitles(email: string): Promise<string[]> {
  const response = await app.inject({ method: 'GET', url: '/notifications?limit=100', headers: headers(email) });
  expect(response.statusCode).toBe(200);
  return (response.json() as { items: Array<{ title: string }> }).items.map((item) => item.title);
}

async function unreadBadge(email: string): Promise<number> {
  const response = await app.inject({ method: 'GET', url: '/me', headers: headers(email) });
  expect(response.statusCode).toBe(200);
  return (response.json() as { unreadNotifications: number }).unreadNotifications;
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const adminEmail = `ne-admin-${suffix}@example.test`;
  const insiderEmail = `ne-insider-${suffix}@example.test`;
  const outsiderEmail = `ne-outsider-${suffix}@example.test`;

  const admin = await prisma.user.create({ data: { email: adminEmail, name: 'Admin' } });
  const insider = await prisma.user.create({ data: { email: insiderEmail, name: 'Insider' } });
  const outsider = await prisma.user.create({ data: { email: outsiderEmail, name: 'Outsider' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'Inbox entity workspace', slug: `ne-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: admin.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: insider.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: outsider.id, role: 'MEMBER' }
    ]
  });

  const team = await prisma.team.create({
    data: { workspaceId: workspace.id, name: `Walled ${suffix}`, slug: `ne-walled-${suffix}` }
  });
  await prisma.teamMember.create({ data: { teamId: team.id, userId: insider.id, role: 'MEMBER' } });

  // ── A meeting the outsider is not on ────────────────────────────────────────────────────────
  const meetingTitle = `retro ${suffix}`;
  const meeting = await prisma.meeting.create({
    data: {
      workspaceId: workspace.id,
      ownerId: insider.id,
      createdById: insider.id,
      title: meetingTitle
    }
  });
  await prisma.meetingParticipant.create({
    data: { workspaceId: workspace.id, meetingId: meeting.id, userId: insider.id, role: 'OWNER' }
  });

  // ── A knowledge page in a PROJECT space, on the walled team ─────────────────────────────────
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: `Walled ${suffix}`,
      keyPrefix: `NE${suffix.slice(0, 3).toUpperCase()}`,
      teamId: team.id
    }
  });
  const space = await prisma.knowledgeSpace.create({
    data: {
      workspaceId: workspace.id,
      type: 'PROJECT',
      projectId: project.id,
      key: `ne-space-${suffix}`,
      name: `Walled space ${suffix}`
    }
  });
  const pageTitle = `runbook ${suffix}`;
  const page = await prisma.knowledgePage.create({
    data: {
      workspaceId: workspace.id,
      spaceId: space.id,
      slug: `runbook-${suffix}`,
      path: `/runbook-${suffix}`,
      title: pageTitle,
      content: {},
      contentText: 'walled runbook',
      status: 'PUBLISHED'
    }
  });

  // ── An announcement the outsider is no longer a recipient of ────────────────────────────────
  const announcementTitle = `notice ${suffix}`;
  const announcement = await prisma.announcement.create({
    data: {
      workspaceId: workspace.id,
      creatorId: admin.id,
      title: announcementTitle,
      body: 'published to a list that has since changed',
      status: 'PUBLISHED',
      publishedAt: new Date()
    }
  });
  await prisma.announcementRecipient.create({
    data: { workspaceId: workspace.id, announcementId: announcement.id, userId: insider.id }
  });

  // Every row below is the one the write side left behind: written when the recipient was still on
  // the meeting, still on the team, still on the list.
  const reminderTitle = `daily report reminder ${suffix}`;
  const recipients = [admin.id, insider.id, outsider.id];
  await prisma.notification.createMany({
    data: recipients.flatMap((userId) => [
      {
        workspaceId: workspace.id,
        userId,
        actorId: admin.id,
        actorType: 'USER' as const,
        meetingId: meeting.id,
        type: 'meeting_assigned',
        title: meetingTitle
      },
      {
        workspaceId: workspace.id,
        userId,
        actorId: admin.id,
        actorType: 'USER' as const,
        knowledgePageId: page.id,
        type: 'knowledge_page_published',
        title: pageTitle
      },
      {
        workspaceId: workspace.id,
        userId,
        actorId: admin.id,
        actorType: 'USER' as const,
        announcementId: announcement.id,
        type: 'announcement_published',
        title: announcementTitle
      },
      // Points at nothing at all, which is its own branch and its own way to break.
      {
        workspaceId: workspace.id,
        userId,
        actorId: null,
        actorType: 'SYSTEM' as const,
        type: 'daily_report_requested',
        title: reminderTitle
      }
    ])
  });

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    adminEmail,
    adminId: admin.id,
    insiderEmail,
    insiderId: insider.id,
    outsiderEmail,
    outsiderId: outsider.id,
    meetingTitle,
    pageTitle,
    announcementTitle,
    reminderTitle
  };
}
