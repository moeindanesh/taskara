import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * Today's answer to "who may see a saved view", pinned so that changing it is deliberate.
 *
 * This is the one carried-over item from the #59 audit that #60 was asked to **surface rather than
 * settle**, and it is worth stating precisely. `viewWhereForAccess` exists in the shared access
 * module, is tested, and is called from nowhere, while `GET /views` and `/sync/bootstrap` spelled
 * the same predicate by hand. The one clause that differs is its admin short-circuit: adopting the
 * shared rule would show a workspace admin **other people's private views**.
 *
 * That is a product decision — a saved filter is arguably a private working note rather than
 * workspace data — and today's behaviour is *narrower* than the shared rule, not wider, so nothing
 * is leaking while it stays open. These tests describe what happens now. If a later ticket adopts
 * the shared rule, the second one fails, and whoever reads the failure reads this.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  adminEmail: string;
  ownerEmail: string;
  otherEmail: string;
  privateViewId: string;
  sharedViewId: string;
}

describe('saved view visibility', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await prisma.user.deleteMany({
      where: { email: { in: [fixture.adminEmail, fixture.ownerEmail, fixture.otherEmail] } }
    });
    await app.close();
  });

  test('a shared view reaches everybody and a private one reaches only its owner', async () => {
    expect(await viewIds(fixture.ownerEmail)).toEqual(
      expect.arrayContaining([fixture.privateViewId, fixture.sharedViewId])
    );

    const otherViews = await viewIds(fixture.otherEmail);
    expect(otherViews).toContain(fixture.sharedViewId);
    expect(otherViews).not.toContain(fixture.privateViewId);
  });

  /**
   * The open question, pinned. `viewWhereForAccess` would make this contain the private view.
   * Neither answer is wrong on the evidence; the point is that nobody has chosen.
   */
  test('a workspace admin does not currently see somebody else private view', async () => {
    const adminViews = await viewIds(fixture.adminEmail);
    expect(adminViews).toContain(fixture.sharedViewId);
    expect(adminViews).not.toContain(fixture.privateViewId);
  });

  /** The offline copy has to answer the same way, which is why both now call one predicate. */
  test('the bootstrap payload agrees with the list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/sync/bootstrap',
      headers: headers(fixture.otherEmail)
    });
    expect(response.statusCode).toBe(200);
    const ids = (response.json() as { views: Array<{ id: string }> }).views.map((view) => view.id);
    expect(ids).toContain(fixture.sharedViewId);
    expect(ids).not.toContain(fixture.privateViewId);
  });
});

function headers(email: string) {
  return { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email };
}

async function viewIds(email: string): Promise<string[]> {
  const response = await app.inject({ method: 'GET', url: '/views?scope=tasks', headers: headers(email) });
  expect(response.statusCode).toBe(200);
  return (response.json() as Array<{ id: string }>).map((view) => view.id);
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const adminEmail = `vw-admin-${suffix}@example.test`;
  const ownerEmail = `vw-owner-${suffix}@example.test`;
  const otherEmail = `vw-other-${suffix}@example.test`;

  const admin = await prisma.user.create({ data: { email: adminEmail, name: 'Admin' } });
  const owner = await prisma.user.create({ data: { email: ownerEmail, name: 'Owner' } });
  const other = await prisma.user.create({ data: { email: otherEmail, name: 'Other' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'View access workspace', slug: `vw-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: admin.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: owner.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: other.id, role: 'MEMBER' }
    ]
  });

  const filters = { scope: 'tasks', teamId: 'all' };
  const privateView = await prisma.view.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      name: `private ${suffix}`,
      isShared: false,
      filters
    }
  });
  const sharedView = await prisma.view.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      name: `shared ${suffix}`,
      isShared: true,
      filters
    }
  });

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    adminEmail,
    ownerEmail,
    otherEmail,
    privateViewId: privateView.id,
    sharedViewId: sharedView.id
  };
}
