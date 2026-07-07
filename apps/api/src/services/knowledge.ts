import {
  prisma,
  type KnowledgePage,
  type KnowledgePageAttachment,
  type KnowledgeReferenceType,
  type KnowledgeSpace,
  type Prisma,
  type SyncEvent
} from '@taskara/db';
import type { z } from 'zod';
import type {
  createKnowledgeCommentSchema,
  createKnowledgePageSchema,
  createKnowledgeSpaceSchema,
  knowledgePageListQuerySchema,
  updateKnowledgeCommentSchema,
  updateKnowledgePageSchema,
  updateKnowledgeSpaceSchema,
  verifyKnowledgePageSchema
} from '@taskara/shared';
import type { RequestActor } from './actor';
import { isWorkspaceAdminRole } from './actor';
import { logActivity } from './audit';
import { buildMediaUrl, type UploadedMediaObject } from './media';
import { HttpError } from './http';
import { appendSyncEvent, publishSyncEvent } from './sync';
import { projectWhereForAccess, resolveWorkspaceAccess } from './team-access';

type CreateKnowledgeSpaceInput = z.infer<typeof createKnowledgeSpaceSchema>;
type UpdateKnowledgeSpaceInput = z.infer<typeof updateKnowledgeSpaceSchema>;
type CreateKnowledgePageInput = z.infer<typeof createKnowledgePageSchema>;
type UpdateKnowledgePageInput = z.infer<typeof updateKnowledgePageSchema>;
type KnowledgePageListQuery = z.infer<typeof knowledgePageListQuerySchema>;
type VerifyKnowledgePageInput = z.infer<typeof verifyKnowledgePageSchema>;
type CreateKnowledgeCommentInput = z.infer<typeof createKnowledgeCommentSchema>;
type UpdateKnowledgeCommentInput = z.infer<typeof updateKnowledgeCommentSchema>;

const userSelect = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true
} satisfies Prisma.UserSelect;

const knowledgeSpaceInclude = {
  team: { select: { id: true, name: true, slug: true } },
  project: { select: { id: true, name: true, keyPrefix: true, teamId: true } },
  createdBy: { select: userSelect },
  updatedBy: { select: userSelect },
  _count: { select: { pages: true } }
} satisfies Prisma.KnowledgeSpaceInclude;

const knowledgePageInclude = {
  space: { include: knowledgeSpaceInclude },
  parent: { select: { id: true, title: true, slug: true, path: true } },
  owner: { select: userSelect },
  createdBy: { select: userSelect },
  updatedBy: { select: userSelect },
  verifiedBy: { select: userSelect },
  labels: { include: { label: true } },
  attachments: { orderBy: { createdAt: 'asc' } },
  _count: { select: { children: true, comments: true, attachments: true, references: true } }
} satisfies Prisma.KnowledgePageInclude;

export const KNOWLEDGE_PAGE_MENTIONED_NOTIFICATION_TYPE = 'knowledge_page_mentioned';
export const KNOWLEDGE_PAGE_COMMENTED_NOTIFICATION_TYPE = 'knowledge_page_commented';
export const KNOWLEDGE_PAGE_UPDATED_NOTIFICATION_TYPE = 'knowledge_page_updated';
export const KNOWLEDGE_PAGE_VERIFICATION_EXPIRED_NOTIFICATION_TYPE = 'knowledge_page_verification_expired';
export const KNOWLEDGE_PAGE_OWNER_ASSIGNED_NOTIFICATION_TYPE = 'knowledge_page_owner_assigned';

export const emptyKnowledgeContent = {
  root: {
    children: [
      {
        children: [],
        direction: null,
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1
      }
    ],
    direction: null,
    format: '',
    indent: 0,
    type: 'root',
    version: 1
  }
};

export function serializeKnowledgeAttachment(attachment: KnowledgePageAttachment) {
  return {
    ...attachment,
    url: buildMediaUrl(attachment.object)
  };
}

export function serializeKnowledgeSpace(space: Prisma.KnowledgeSpaceGetPayload<{ include: typeof knowledgeSpaceInclude }>) {
  return space;
}

export function serializeKnowledgePage(page: Prisma.KnowledgePageGetPayload<{ include: typeof knowledgePageInclude }>) {
  return {
    ...page,
    attachments: page.attachments.map(serializeKnowledgeAttachment),
    verified:
      Boolean(page.verifiedAt) &&
      (!page.verificationExpiresAt || page.verificationExpiresAt.getTime() > Date.now())
  };
}

export async function listKnowledgeSpaces(actor: RequestActor) {
  const where = await knowledgeSpaceWhereForActor(actor);
  const spaces = await prisma.knowledgeSpace.findMany({
    where,
    include: knowledgeSpaceInclude,
    orderBy: [{ type: 'asc' }, { updatedAt: 'desc' }]
  });
  return spaces.map(serializeKnowledgeSpace);
}

export async function createKnowledgeSpace(actor: RequestActor, input: CreateKnowledgeSpaceInput) {
  const resolved = await resolveKnowledgeSpaceInput(actor, input);
  assertActorCanEditResolvedSpace(actor, resolved);

  let syncEvent: SyncEvent | null = null;
  const space = await prisma.$transaction(async (tx) => {
    const space = await tx.knowledgeSpace.create({
      data: {
        workspaceId: actor.workspace.id,
        type: input.type,
        teamId: resolved.teamId,
        projectId: resolved.projectId,
        key: input.key || resolved.defaultKey,
        name: input.name,
        description: input.description,
        icon: input.icon,
        createdById: actor.user.id,
        updatedById: actor.user.id
      },
      include: knowledgeSpaceInclude
    });

    syncEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'knowledge_space',
      entityId: space.id,
      operation: 'created',
      actorId: actor.user.id,
      payload: { after: serializeKnowledgeSpace(space), changedFields: Object.keys(input) }
    });

    return space;
  });

  if (syncEvent) publishSyncEvent(syncEvent);
  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'knowledge_space',
    entityId: space.id,
    action: 'created',
    after: space,
    source: actor.source
  }).catch(() => undefined);

  return serializeKnowledgeSpace(space);
}

export async function findKnowledgeSpace(actor: RequestActor, idOrKey: string) {
  const where = await knowledgeSpaceWhereForActor(actor);
  const space = await prisma.knowledgeSpace.findFirst({
    where: {
      AND: [
        where,
        {
          OR: [
            isUuid(idOrKey) ? { id: idOrKey } : undefined,
            { key: idOrKey }
          ].filter(Boolean) as Prisma.KnowledgeSpaceWhereInput[]
        }
      ]
    },
    include: knowledgeSpaceInclude
  });
  return space ? serializeKnowledgeSpace(space) : null;
}

export async function updateKnowledgeSpace(actor: RequestActor, idOrKey: string, input: UpdateKnowledgeSpaceInput) {
  const existing = await requireKnowledgeSpace(actor, idOrKey);
  await assertActorCanEditKnowledgeSpace(actor, existing.id);

  let syncEvent: SyncEvent | null = null;
  const updated = await prisma.$transaction(async (tx) => {
    const updated = await tx.knowledgeSpace.update({
      where: { id: existing.id },
      data: {
        key: input.key,
        name: input.name,
        description: input.description === undefined ? undefined : input.description,
        icon: input.icon === undefined ? undefined : input.icon,
        updatedById: actor.user.id
      },
      include: knowledgeSpaceInclude
    });

    syncEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'knowledge_space',
      entityId: updated.id,
      operation: 'updated',
      actorId: actor.user.id,
      payload: { before: existing, after: serializeKnowledgeSpace(updated), changedFields: Object.keys(input) }
    });

    return updated;
  });

  if (syncEvent) publishSyncEvent(syncEvent);
  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'knowledge_space',
    entityId: updated.id,
    action: 'updated',
    before: existing,
    after: updated,
    source: actor.source
  }).catch(() => undefined);

  return serializeKnowledgeSpace(updated);
}

export async function listKnowledgePages(actor: RequestActor, query: KnowledgePageListQuery) {
  const where = await knowledgePageWhereForQuery(actor, query);
  const [items, total] = await Promise.all([
    prisma.knowledgePage.findMany({
      where,
      include: knowledgePageInclude,
      orderBy: [{ position: 'asc' }, { updatedAt: 'desc' }],
      take: query.limit,
      skip: query.offset
    }),
    prisma.knowledgePage.count({ where })
  ]);

  return {
    items: items.map(serializeKnowledgePage),
    total,
    limit: query.limit,
    offset: query.offset
  };
}

export async function searchKnowledgePages(actor: RequestActor, input: { q: string; limit: number; offset: number }) {
  const query = input.q.trim();
  const where = await knowledgePageWhereForQuery(actor, { q: query, limit: input.limit, offset: input.offset });
  const pages = await prisma.knowledgePage.findMany({
    where,
    include: knowledgePageInclude,
    take: Math.min(input.limit * 3, 100),
    skip: input.offset,
    orderBy: [{ updatedAt: 'desc' }]
  });

  const ranked = pages
    .map((page) => ({ page, score: knowledgeSearchScore(page, query) }))
    .sort((a, b) => b.score - a.score || b.page.updatedAt.getTime() - a.page.updatedAt.getTime())
    .slice(0, input.limit)
    .map(({ page }) => serializeKnowledgePage(page));

  return {
    items: ranked,
    total: ranked.length,
    limit: input.limit,
    offset: input.offset
  };
}

export async function createKnowledgePage(actor: RequestActor, input: CreateKnowledgePageInput) {
  const space = await assertActorCanEditKnowledgeSpace(actor, input.spaceId);
  const ownerId = input.ownerId || actor.user.id;
  await assertUserInWorkspace(actor.workspace.id, ownerId, 'Page owner must belong to this workspace');
  const parent = input.parentId ? await requirePageInSpace(actor.workspace.id, input.spaceId, input.parentId) : null;
  const slug = await reserveKnowledgePageSlug(input.spaceId, parent?.path ?? null, input.slug || slugifyKnowledgeTitle(input.title));
  const path = buildKnowledgePagePath(parent?.path ?? null, slug);
  const content = normalizeKnowledgeContent(input.content);
  const contentText = extractKnowledgeContentText(content);
  let syncEvent: SyncEvent | null = null;

  const page = await prisma.$transaction(async (tx) => {
    const page = await tx.knowledgePage.create({
      data: {
        workspaceId: actor.workspace.id,
        spaceId: space.id,
        parentId: parent?.id,
        slug,
        path,
        title: input.title,
        summary: input.summary,
        icon: input.icon,
        content,
        contentText,
        status: input.status,
        ownerId,
        createdById: actor.user.id,
        updatedById: actor.user.id,
        position: input.position
      },
      include: knowledgePageInclude
    });

    await tx.knowledgePageVersion.create({
      data: {
        pageId: page.id,
        version: page.version,
        title: page.title,
        content: normalizeJson(page.content),
        contentText: page.contentText,
        authorId: actor.user.id,
        reason: 'created'
      }
    });
    await syncKnowledgeLabels(tx, actor.workspace.id, page.id, input.labels);
    await syncKnowledgeReferences(tx, actor.workspace.id, page.id, content);
    await subscribeUsersToKnowledgePage(tx, {
      workspaceId: actor.workspace.id,
      pageId: page.id,
      userIds: [actor.user.id, ownerId]
    });

    const fullPage = await tx.knowledgePage.findUniqueOrThrow({ where: { id: page.id }, include: knowledgePageInclude });
    syncEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'knowledge_page',
      entityId: fullPage.id,
      operation: 'created',
      entityVersion: fullPage.version,
      actorId: actor.user.id,
      payload: { after: serializeKnowledgePage(fullPage), changedFields: Object.keys(input) }
    });
    return fullPage;
  });

  if (syncEvent) publishSyncEvent(syncEvent);
  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'knowledge_page',
    entityId: page.id,
    action: 'created',
    after: page,
    source: actor.source
  }).catch(() => undefined);

  return serializeKnowledgePage(page);
}

export async function getKnowledgePage(actor: RequestActor, idOrPath: string) {
  const page = await findKnowledgePageForActor(actor, idOrPath);
  return page ? serializeKnowledgePage(page) : null;
}

export async function updateKnowledgePage(actor: RequestActor, pageId: string, input: UpdateKnowledgePageInput) {
  const existing = await requireKnowledgePageForEdit(actor, pageId);
  if (input.baseVersion && input.baseVersion !== existing.version) {
    throw new HttpError(409, 'Knowledge page has changed since it was loaded');
  }
  if (input.ownerId) await assertUserInWorkspace(actor.workspace.id, input.ownerId, 'Page owner must belong to this workspace');

  const nextParent = input.parentId === undefined
    ? existing.parent
    : input.parentId
      ? await requirePageInSpace(actor.workspace.id, existing.spaceId, input.parentId)
      : null;
  if (nextParent?.id === existing.id || nextParent?.path.startsWith(`${existing.path}/`)) {
    throw new HttpError(400, 'Knowledge page cannot be moved under itself');
  }

  const nextSlugBase = input.slug || existing.slug;
  const pathChanged = input.parentId !== undefined || input.slug !== undefined;
  const nextSlug = pathChanged
    ? await reserveKnowledgePageSlug(existing.spaceId, nextParent?.path ?? null, nextSlugBase, existing.id)
    : existing.slug;
  const nextPath = pathChanged ? buildKnowledgePagePath(nextParent?.path ?? null, nextSlug) : existing.path;
  const nextContent = input.content === undefined ? normalizeJson(existing.content) : normalizeKnowledgeContent(input.content);
  const nextContentText = input.content === undefined ? existing.contentText : extractKnowledgeContentText(nextContent);
  const nextVersion = existing.version + 1;
  let syncEvent: SyncEvent | null = null;

  const page = await prisma.$transaction(async (tx) => {
    const page = await tx.knowledgePage.update({
      where: { id: existing.id },
      data: {
        parentId: input.parentId === undefined ? undefined : nextParent?.id ?? null,
        slug: pathChanged ? nextSlug : undefined,
        path: pathChanged ? nextPath : undefined,
        title: input.title,
        summary: input.summary === undefined ? undefined : input.summary,
        icon: input.icon === undefined ? undefined : input.icon,
        content: input.content === undefined ? undefined : nextContent,
        contentText: input.content === undefined ? undefined : nextContentText,
        status: input.status,
        archivedAt: input.status === 'ARCHIVED' ? new Date() : input.status ? null : undefined,
        ownerId: input.ownerId === undefined ? undefined : input.ownerId,
        updatedById: actor.user.id,
        position: input.position,
        version: { increment: 1 }
      },
      include: knowledgePageInclude
    });

    await tx.knowledgePageVersion.create({
      data: {
        pageId: page.id,
        version: nextVersion,
        title: page.title,
        content: normalizeJson(page.content),
        contentText: page.contentText,
        authorId: actor.user.id,
        reason: 'updated'
      }
    });
    if (input.labels) await syncKnowledgeLabels(tx, actor.workspace.id, page.id, input.labels);
    if (input.content !== undefined) await syncKnowledgeReferences(tx, actor.workspace.id, page.id, nextContent);
    if (pathChanged) await updateDescendantPaths(tx, existing.id, existing.path, nextPath);

    const fullPage = await tx.knowledgePage.findUniqueOrThrow({ where: { id: page.id }, include: knowledgePageInclude });
    syncEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'knowledge_page',
      entityId: page.id,
      operation: page.status === 'ARCHIVED' ? 'archived' : 'updated',
      entityVersion: page.version,
      actorId: actor.user.id,
      payload: { before: serializeKnowledgePage(existing), after: serializeKnowledgePage(fullPage), changedFields: Object.keys(input) }
    });
    return fullPage;
  });

  if (syncEvent) publishSyncEvent(syncEvent);
  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'knowledge_page',
    entityId: page.id,
    action: page.status === 'ARCHIVED' ? 'archived' : 'updated',
    before: existing,
    after: page,
    source: actor.source
  }).catch(() => undefined);

  return serializeKnowledgePage(page);
}

export async function archiveKnowledgePage(actor: RequestActor, pageId: string) {
  return updateKnowledgePage(actor, pageId, { status: 'ARCHIVED' });
}

export async function verifyKnowledgePage(actor: RequestActor, pageId: string, input: VerifyKnowledgePageInput) {
  const existing = await requireKnowledgePageForEdit(actor, pageId);
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new HttpError(400, 'Invalid verification expiry');

  const page = await prisma.knowledgePage.update({
    where: { id: existing.id },
    data: {
      verifiedById: actor.user.id,
      verifiedAt: new Date(),
      verificationExpiresAt: expiresAt,
      updatedById: actor.user.id
    },
    include: knowledgePageInclude
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'knowledge_page',
    entityId: page.id,
    action: 'verified',
    before: existing,
    after: page,
    source: actor.source
  }).catch(() => undefined);

  return serializeKnowledgePage(page);
}

export async function removeKnowledgePageVerification(actor: RequestActor, pageId: string) {
  const existing = await requireKnowledgePageForEdit(actor, pageId);
  const page = await prisma.knowledgePage.update({
    where: { id: existing.id },
    data: {
      verifiedById: null,
      verifiedAt: null,
      verificationExpiresAt: null,
      updatedById: actor.user.id
    },
    include: knowledgePageInclude
  });

  return serializeKnowledgePage(page);
}

export async function listKnowledgePageVersions(actor: RequestActor, pageId: string) {
  const page = await requireKnowledgePageForView(actor, pageId);
  return prisma.knowledgePageVersion.findMany({
    where: { pageId: page.id },
    orderBy: { version: 'desc' },
    include: { author: { select: userSelect } },
    take: 100
  });
}

export async function revertKnowledgePageVersion(actor: RequestActor, pageId: string, version: number) {
  const existing = await requireKnowledgePageForEdit(actor, pageId);
  const target = await prisma.knowledgePageVersion.findUnique({
    where: { pageId_version: { pageId: existing.id, version } }
  });
  if (!target) throw new HttpError(404, 'Knowledge page version not found');

  return updateKnowledgePage(actor, existing.id, {
    title: target.title,
    content: target.content,
    baseVersion: existing.version
  });
}

export async function listKnowledgePageComments(actor: RequestActor, pageId: string) {
  const page = await requireKnowledgePageForView(actor, pageId);
  return prisma.knowledgePageComment.findMany({
    where: { pageId: page.id },
    include: {
      author: { select: userSelect },
      resolvedBy: { select: userSelect },
      attachments: { orderBy: { createdAt: 'asc' } }
    },
    orderBy: { createdAt: 'asc' }
  });
}

export async function createKnowledgePageComment(actor: RequestActor, pageId: string, input: CreateKnowledgeCommentInput) {
  const page = await requireKnowledgePageForView(actor, pageId);
  const comment = await prisma.$transaction(async (tx) => {
    await subscribeUsersToKnowledgePage(tx, {
      workspaceId: actor.workspace.id,
      pageId: page.id,
      userIds: [actor.user.id]
    });
    const comment = await tx.knowledgePageComment.create({
      data: {
        workspaceId: actor.workspace.id,
        pageId: page.id,
        authorId: actor.user.id,
        body: input.body,
        anchor: input.anchor === undefined ? undefined : normalizeJson(input.anchor)
      },
      include: {
        author: { select: userSelect },
        resolvedBy: { select: userSelect },
        attachments: { orderBy: { createdAt: 'asc' } }
      }
    });
    await createKnowledgePageSubscriberNotifications(tx, {
      workspaceId: actor.workspace.id,
      actorUserId: actor.user.id,
      page,
      type: KNOWLEDGE_PAGE_COMMENTED_NOTIFICATION_TYPE,
      body: `${actor.user.name} دیدگاهی روی این صفحه گذاشت.`
    });
    return comment;
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'knowledge_page',
    entityId: page.id,
    action: 'commented',
    after: comment,
    source: actor.source
  }).catch(() => undefined);

  return comment;
}

export async function updateKnowledgePageComment(
  actor: RequestActor,
  pageId: string,
  commentId: string,
  input: UpdateKnowledgeCommentInput
) {
  await requireKnowledgePageForView(actor, pageId);
  const existing = await prisma.knowledgePageComment.findFirst({ where: { id: commentId, pageId } });
  if (!existing) throw new HttpError(404, 'Knowledge page comment not found');
  if (existing.authorId !== actor.user.id && !isWorkspaceAdminRole(actor.role)) {
    throw new HttpError(403, 'Comment author or workspace admin access required');
  }

  return prisma.knowledgePageComment.update({
    where: { id: commentId },
    data: {
      body: input.body,
      resolvedAt: input.resolved === undefined ? undefined : input.resolved ? new Date() : null,
      resolvedById: input.resolved === undefined ? undefined : input.resolved ? actor.user.id : null
    },
    include: {
      author: { select: userSelect },
      resolvedBy: { select: userSelect },
      attachments: { orderBy: { createdAt: 'asc' } }
    }
  });
}

export async function createKnowledgePageAttachment(
  actor: RequestActor,
  pageId: string,
  media: UploadedMediaObject,
  commentId?: string
) {
  const page = await requireKnowledgePageForView(actor, pageId);
  if (commentId) {
    const comment = await prisma.knowledgePageComment.findFirst({ where: { id: commentId, pageId: page.id } });
    if (!comment) throw new HttpError(404, 'Knowledge page comment not found');
  }

  const attachment = await prisma.knowledgePageAttachment.create({
    data: {
      pageId: page.id,
      commentId,
      name: media.name,
      documentId: media.documentId,
      object: media.object,
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes
    }
  });
  return serializeKnowledgeAttachment(attachment);
}

export async function subscribeKnowledgePage(actor: RequestActor, pageId: string) {
  const page = await requireKnowledgePageForView(actor, pageId);
  await prisma.knowledgePageSubscription.create({
    data: {
      workspaceId: actor.workspace.id,
      pageId: page.id,
      userId: actor.user.id
    }
  }).catch((error) => {
    if (!isUniqueConstraintError(error)) throw error;
  });
  return { subscribed: true };
}

export async function unsubscribeKnowledgePage(actor: RequestActor, pageId: string) {
  const page = await requireKnowledgePageForView(actor, pageId);
  await prisma.knowledgePageSubscription.deleteMany({
    where: {
      workspaceId: actor.workspace.id,
      pageId: page.id,
      userId: actor.user.id
    }
  });
  return { subscribed: false };
}

export async function listKnowledgeReferencesForTarget(
  actor: RequestActor,
  input: { type: KnowledgeReferenceType; targetId?: string; url?: string }
) {
  const visibleSpaceIds = await listAccessibleKnowledgeSpaceIds(actor);
  const references = await prisma.knowledgePageReference.findMany({
    where: {
      workspaceId: actor.workspace.id,
      type: input.type,
      targetId: input.targetId,
      url: input.url,
      page: { spaceId: { in: visibleSpaceIds }, status: { not: 'ARCHIVED' } }
    },
    include: { page: { include: knowledgePageInclude } },
    orderBy: { createdAt: 'desc' },
    take: 100
  });
  return references.map((reference) => ({
    ...reference,
    page: serializeKnowledgePage(reference.page)
  }));
}

export async function listAccessibleKnowledgeSpaceIds(actor: RequestActor): Promise<string[]> {
  const where = await knowledgeSpaceWhereForActor(actor);
  const spaces = await prisma.knowledgeSpace.findMany({ where, select: { id: true } });
  return spaces.map((space) => space.id);
}

export async function assertActorCanViewKnowledgeSpace(actor: RequestActor, spaceId: string): Promise<KnowledgeSpace> {
  const where = await knowledgeSpaceWhereForActor(actor);
  const space = await prisma.knowledgeSpace.findFirst({ where: { AND: [where, { id: spaceId }] } });
  if (!space) throw new HttpError(404, 'Knowledge space not found');
  return space;
}

export async function assertActorCanEditKnowledgeSpace(actor: RequestActor, spaceId: string): Promise<KnowledgeSpace> {
  const space = await assertActorCanViewKnowledgeSpace(actor, spaceId);
  if (isWorkspaceAdminRole(actor.role)) return space;
  if (actor.role === 'GUEST' || actor.role === 'AGENT') throw new HttpError(403, 'Knowledge edit access denied');
  if (space.type === 'WORKSPACE') return space;
  if (space.teamId) {
    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: space.teamId, userId: actor.user.id } },
      select: { role: true }
    });
    if (membership && membership.role !== 'GUEST' && membership.role !== 'AGENT') return space;
  }
  if (space.type === 'PROJECT' && !space.teamId) return space;
  throw new HttpError(403, 'Knowledge edit access denied');
}

export async function requireKnowledgePageForView(
  actor: RequestActor,
  pageId: string
): Promise<Prisma.KnowledgePageGetPayload<{ include: typeof knowledgePageInclude }>> {
  const page = await findKnowledgePageForActor(actor, pageId);
  if (!page) throw new HttpError(404, 'Knowledge page not found');
  return page;
}

export async function requireKnowledgePageForEdit(
  actor: RequestActor,
  pageId: string
): Promise<Prisma.KnowledgePageGetPayload<{ include: typeof knowledgePageInclude }>> {
  const page = await requireKnowledgePageForView(actor, pageId);
  await assertActorCanEditKnowledgeSpace(actor, page.spaceId);
  return page;
}

export function slugifyKnowledgeTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'page';
}

export function buildKnowledgePagePath(parentPath: string | null, slug: string): string {
  return parentPath ? `${parentPath}/${slug}` : slug;
}

export function extractKnowledgeContentText(content: unknown): string {
  const parts: string[] = [];
  collectKnowledgeText(content, parts);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function extractKnowledgeReferences(content: unknown) {
  const references = new Map<string, { type: KnowledgeReferenceType; targetId?: string; url?: string; title?: string }>();
  collectKnowledgeReferences(content, references);
  return [...references.values()];
}

async function requireKnowledgeSpace(actor: RequestActor, idOrKey: string) {
  const space = await findKnowledgeSpace(actor, idOrKey);
  if (!space) throw new HttpError(404, 'Knowledge space not found');
  return space;
}

async function findKnowledgePageForActor(
  actor: RequestActor,
  idOrPath: string
): Promise<Prisma.KnowledgePageGetPayload<{ include: typeof knowledgePageInclude }> | null> {
  const spaceIds = await listAccessibleKnowledgeSpaceIds(actor);
  if (!spaceIds.length) return null;
  return prisma.knowledgePage.findFirst({
    where: {
      workspaceId: actor.workspace.id,
      spaceId: { in: spaceIds },
      OR: [
        isUuid(idOrPath) ? { id: idOrPath } : undefined,
        { path: idOrPath },
        { slug: idOrPath }
      ].filter(Boolean) as Prisma.KnowledgePageWhereInput[]
    },
    include: knowledgePageInclude
  });
}

async function knowledgeSpaceWhereForActor(actor: RequestActor): Promise<Prisma.KnowledgeSpaceWhereInput> {
  if (isWorkspaceAdminRole(actor.role)) {
    return { workspaceId: actor.workspace.id };
  }

  const access = await resolveWorkspaceAccess(actor);
  return {
    workspaceId: actor.workspace.id,
    OR: [
      { type: 'WORKSPACE' },
      { teamId: { in: access.teamIds } },
      {
        type: 'PROJECT',
        project: projectWhereForAccess(access)
      }
    ]
  };
}

async function knowledgePageWhereForQuery(actor: RequestActor, query: Partial<KnowledgePageListQuery>) {
  const spaceIds = await listAccessibleKnowledgeSpaceIds(actor);
  const now = new Date();
  const where: Prisma.KnowledgePageWhereInput = {
    workspaceId: actor.workspace.id,
    status: query.status ?? { not: 'ARCHIVED' },
    ownerId: query.mine ? actor.user.id : query.ownerId,
    parentId: query.parentId === undefined ? undefined : query.parentId,
    spaceId: query.spaceId ? { in: spaceIds.filter((spaceId) => spaceId === query.spaceId) } : { in: spaceIds },
    labels: query.label ? { some: { label: { name: query.label } } } : undefined
  };

  if (query.verified === true) {
    where.verifiedAt = { not: null };
    where.OR = [{ verificationExpiresAt: null }, { verificationExpiresAt: { gt: now } }];
  } else if (query.verified === false) {
    where.verifiedAt = null;
  }

  if (query.expired) {
    where.verificationExpiresAt = { lte: now };
  }

  if (query.q) {
    const searchWhere: Prisma.KnowledgePageWhereInput[] = [
      { title: { contains: query.q, mode: 'insensitive' } },
      { summary: { contains: query.q, mode: 'insensitive' } },
      { contentText: { contains: query.q, mode: 'insensitive' } }
    ];
    where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { OR: searchWhere }];
  }

  return where;
}

async function resolveKnowledgeSpaceInput(actor: RequestActor, input: CreateKnowledgeSpaceInput) {
  if (input.type === 'WORKSPACE') {
    if (input.teamId || input.projectId) throw new HttpError(400, 'Workspace knowledge spaces cannot target teams or projects');
    return { teamId: null, projectId: null, defaultKey: 'workspace', teamRole: null };
  }

  if (input.type === 'TEAM') {
    if (!input.teamId || input.projectId) throw new HttpError(400, 'Team knowledge spaces require a team');
    const team = await prisma.team.findFirst({
      where: { id: input.teamId, workspaceId: actor.workspace.id },
      select: { id: true, slug: true }
    });
    if (!team) throw new HttpError(404, 'Team not found in this workspace');
    return { teamId: team.id, projectId: null, defaultKey: `team-${team.slug}`, teamRole: await actorTeamRole(actor, team.id) };
  }

  if (!input.projectId || input.teamId) throw new HttpError(400, 'Project knowledge spaces require a project');
  const project = await prisma.project.findFirst({
    where: { id: input.projectId, workspaceId: actor.workspace.id },
    select: { id: true, keyPrefix: true, teamId: true }
  });
  if (!project) throw new HttpError(404, 'Project not found in this workspace');
  return {
    teamId: project.teamId,
    projectId: project.id,
    defaultKey: `project-${project.keyPrefix.toLowerCase()}`,
    teamRole: project.teamId ? await actorTeamRole(actor, project.teamId) : null
  };
}

function assertActorCanEditResolvedSpace(
  actor: RequestActor,
  resolved: { teamId: string | null; projectId: string | null; teamRole: string | null }
): void {
  if (isWorkspaceAdminRole(actor.role)) return;
  if (actor.role === 'GUEST' || actor.role === 'AGENT') throw new HttpError(403, 'Knowledge space create access denied');
  if (!resolved.teamId) return;
  if (resolved.teamRole && resolved.teamRole !== 'GUEST' && resolved.teamRole !== 'AGENT') return;
  throw new HttpError(403, 'Knowledge space create access denied');
}

async function actorTeamRole(actor: RequestActor, teamId: string): Promise<string | null> {
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId: actor.user.id } },
    select: { role: true }
  });
  return membership?.role ?? null;
}

async function assertUserInWorkspace(workspaceId: string, userId: string, message: string): Promise<void> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true }
  });
  if (!member) throw new HttpError(400, message);
}

async function requirePageInSpace(workspaceId: string, spaceId: string, pageId: string): Promise<KnowledgePage> {
  const page = await prisma.knowledgePage.findFirst({ where: { id: pageId, workspaceId, spaceId } });
  if (!page) throw new HttpError(400, 'Parent page not found in this knowledge space');
  return page;
}

async function reserveKnowledgePageSlug(
  spaceId: string,
  parentPath: string | null,
  requestedSlug: string,
  existingPageId?: string
): Promise<string> {
  const baseSlug = slugifyKnowledgeTitle(requestedSlug);
  let slug = baseSlug;
  let suffix = 2;

  while (true) {
    const path = buildKnowledgePagePath(parentPath, slug);
    const existing = await prisma.knowledgePage.findFirst({
      where: {
        spaceId,
        path,
        id: existingPageId ? { not: existingPageId } : undefined
      },
      select: { id: true }
    });
    if (!existing) return slug;
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
}

async function syncKnowledgeLabels(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  pageId: string,
  names: string[]
): Promise<void> {
  const uniqueNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  await tx.knowledgePageLabel.deleteMany({ where: { pageId } });
  for (const name of uniqueNames) {
    const label = await tx.knowledgeLabel.upsert({
      where: { workspaceId_name: { workspaceId, name } },
      update: {},
      create: { workspaceId, name }
    });
    await tx.knowledgePageLabel.create({ data: { pageId, labelId: label.id } });
  }
}

async function syncKnowledgeReferences(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  pageId: string,
  content: unknown
): Promise<void> {
  const references = extractKnowledgeReferences(content);
  await tx.knowledgePageReference.deleteMany({ where: { pageId } });
  if (!references.length) return;
  await tx.knowledgePageReference.createMany({
    data: references.map((reference) => ({
      workspaceId,
      pageId,
      type: reference.type,
      targetId: reference.targetId,
      url: reference.url,
      title: reference.title
    }))
  });
}

async function subscribeUsersToKnowledgePage(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; pageId: string; userIds: Array<string | null | undefined> }
): Promise<void> {
  const requestedUserIds = [...new Set(input.userIds.filter((userId): userId is string => Boolean(userId)))];
  if (!requestedUserIds.length) return;
  const members = await tx.workspaceMember.findMany({
    where: { workspaceId: input.workspaceId, userId: { in: requestedUserIds } },
    select: { userId: true }
  });
  await tx.knowledgePageSubscription.createMany({
    data: members.map((member) => ({
      workspaceId: input.workspaceId,
      pageId: input.pageId,
      userId: member.userId
    })),
    skipDuplicates: true
  });
}

async function createKnowledgePageSubscriberNotifications(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    actorUserId: string;
    page: Pick<KnowledgePage, 'id' | 'title'>;
    type: string;
    body: string;
    excludeUserIds?: string[];
  }
): Promise<void> {
  const excludedUserIds = [...new Set([input.actorUserId, ...(input.excludeUserIds || [])])];
  const subscriptions = await tx.knowledgePageSubscription.findMany({
    where: {
      workspaceId: input.workspaceId,
      pageId: input.page.id,
      userId: { notIn: excludedUserIds }
    },
    select: { userId: true }
  });
  const recipientIds = [...new Set(subscriptions.map((subscription) => subscription.userId))];
  if (!recipientIds.length) return;
  await tx.notification.createMany({
    data: recipientIds.map((userId) => ({
      workspaceId: input.workspaceId,
      userId,
      knowledgePageId: input.page.id,
      type: input.type,
      title: input.page.title,
      body: input.body
    }))
  });
}

async function updateDescendantPaths(
  tx: Prisma.TransactionClient,
  pageId: string,
  previousPath: string,
  nextPath: string
): Promise<void> {
  const descendants = await tx.knowledgePage.findMany({
    where: { id: { not: pageId }, path: { startsWith: `${previousPath}/` } },
    select: { id: true, path: true }
  });
  for (const descendant of descendants) {
    await tx.knowledgePage.update({
      where: { id: descendant.id },
      data: { path: descendant.path.replace(`${previousPath}/`, `${nextPath}/`) }
    });
  }
}

function normalizeKnowledgeContent(content: unknown): Prisma.InputJsonValue {
  return normalizeJson(content === undefined || content === null || content === '' ? emptyKnowledgeContent : content);
}

function normalizeJson(value: unknown): Prisma.InputJsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    throw new HttpError(400, 'Content must be valid JSON');
  }
}

function collectKnowledgeText(value: unknown, parts: string[], key?: string): void {
  if (typeof value === 'string') {
    if (!key || ['text', 'title', 'mentionName', 'url'].includes(key)) parts.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectKnowledgeText(item, parts);
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    collectKnowledgeText(childValue, parts, childKey);
  }
}

function collectKnowledgeReferences(
  value: unknown,
  references: Map<string, { type: KnowledgeReferenceType; targetId?: string; url?: string; title?: string }>
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectKnowledgeReferences(item, references);
    return;
  }

  const record = value as Record<string, unknown>;
  addReferenceFromRecord(references, record, 'PAGE', 'pageId');
  addReferenceFromRecord(references, record, 'TASK', 'taskId');
  addReferenceFromRecord(references, record, 'PROJECT', 'projectId');
  addReferenceFromRecord(references, record, 'MEETING', 'meetingId');
  addReferenceFromRecord(references, record, 'ANNOUNCEMENT', 'announcementId');
  if (typeof record.url === 'string' && /^https?:\/\//i.test(record.url)) {
    const key = `EXTERNAL_URL:${record.url}`;
    references.set(key, {
      type: 'EXTERNAL_URL',
      url: record.url,
      title: typeof record.title === 'string' ? record.title : undefined
    });
  }

  for (const childValue of Object.values(record)) {
    collectKnowledgeReferences(childValue, references);
  }
}

function addReferenceFromRecord(
  references: Map<string, { type: KnowledgeReferenceType; targetId?: string; url?: string; title?: string }>,
  record: Record<string, unknown>,
  type: KnowledgeReferenceType,
  field: string
): void {
  const targetId = record[field];
  if (typeof targetId !== 'string' || !targetId.trim()) return;
  const key = `${type}:${targetId}`;
  references.set(key, {
    type,
    targetId,
    title: typeof record.title === 'string' ? record.title : undefined
  });
}

function knowledgeSearchScore(page: Pick<KnowledgePage, 'title' | 'summary' | 'contentText' | 'verifiedAt' | 'verificationExpiresAt' | 'updatedAt'>, q: string): number {
  const query = q.toLocaleLowerCase('en-US');
  const title = page.title.toLocaleLowerCase('en-US');
  const summary = (page.summary || '').toLocaleLowerCase('en-US');
  const content = page.contentText.toLocaleLowerCase('en-US');
  let score = 0;
  if (title === query) score += 100;
  if (title.startsWith(query)) score += 60;
  if (title.includes(query)) score += 40;
  if (summary.includes(query)) score += 20;
  if (content.includes(query)) score += 10;
  if (page.verifiedAt && (!page.verificationExpiresAt || page.verificationExpiresAt.getTime() > Date.now())) score += 15;
  score += Math.max(0, 5 - (Date.now() - page.updatedAt.getTime()) / (1000 * 60 * 60 * 24 * 30));
  return score;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
