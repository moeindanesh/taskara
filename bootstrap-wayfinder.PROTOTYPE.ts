// #31 bootstrap — creates the workspace, the operator, the agent User and its credential.
// Out-of-band on purpose: minting the first credential is an admin act, and the CLI is what has to
// prove itself on everything after this point.
import { prisma } from '@taskara/db';
import { mintAgentCredentialToken } from './apps/api/src/services/agent-credential';

const SLUG = 'wayfinder';

await prisma.workspace.deleteMany({ where: { slug: SLUG } });
await prisma.user.deleteMany({ where: { email: { endsWith: '@wayfinder.taskara' } } });

const workspace = await prisma.workspace.create({ data: { name: 'Wayfinder', slug: SLUG } });
const operator = await prisma.user.create({
  data: { email: 'operator@wayfinder.taskara', name: 'Moein' }
});
await prisma.workspaceMember.create({
  data: { workspaceId: workspace.id, userId: operator.id, role: 'OWNER' }
});

const agent = await prisma.user.create({
  data: { email: 'claude@wayfinder.taskara', name: 'Claude', kind: 'AGENT', operatorId: operator.id }
});
await prisma.workspaceMember.create({
  data: { workspaceId: workspace.id, userId: agent.id, role: 'MEMBER' }
});

const minted = mintAgentCredentialToken();
await prisma.agentCredential.create({
  data: {
    workspaceId: workspace.id,
    userId: agent.id,
    name: 'wayfinder migration',
    lookupId: minted.lookupId,
    tokenHash: minted.tokenHash,
    scope: 'READ_WRITE'
  }
});

const project = await prisma.project.create({
  data: { workspaceId: workspace.id, name: 'Taskara', keyPrefix: 'TKR', nextTaskNumber: 1 }
});

console.log(JSON.stringify({ slug: SLUG, projectId: project.id, token: minted.token }, null, 2));
await prisma.$disconnect();
