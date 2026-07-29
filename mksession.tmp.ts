import { prisma } from '@taskara/db';
import { createUserSession } from './apps/api/src/services/auth';

const member = await prisma.workspaceMember.findFirst({
  where: { role: { in: ['OWNER', 'ADMIN'] } },
  include: { user: true, workspace: true },
  orderBy: { createdAt: "asc" }
});
if (!member) throw new Error('no workspace member found in local db');

const session = await createUserSession(member.userId);
console.log(JSON.stringify({
  token: session.token,
  expiresAt: session.expiresAt,
  user: { id: member.user.id, name: member.user.name, email: member.user.email, avatarUrl: member.user.avatarUrl },
  workspace: { id: member.workspace.id, name: member.workspace.name, slug: member.workspace.slug },
  role: member.role
}));
