// PROTOTYPE #26 seed — wipe me. Creates one workspace with a blocked task and a takeable one.
import { prisma } from '@taskara/db';
import { createUserSession } from '../../../../Users/hypermadar/Workspace/taskara/apps/api/src/services/auth';

const suffix = Math.random().toString(36).slice(2, 8);
const slug = `proto26-${suffix}`;

const workspace = await prisma.workspace.create({ data: { name: `Proto26 ${suffix}`, slug } });
const owner = await prisma.user.create({
  data: { email: `proto26-${suffix}@prototype.invalid`, name: 'مدیر نمونه' }
});
await prisma.workspaceMember.create({
  data: { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' }
});
const project = await prisma.project.create({
  data: { workspaceId: workspace.id, name: 'هستهٔ محصول', keyPrefix: 'CORE', nextTaskNumber: 5 }
});

const mk = (sequence: number, title: string, status: string) =>
  prisma.task.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      sequence,
      key: `CORE-${sequence}`,
      title,
      status: status as never,
      reporterId: owner.id
    }
  });

// The subject: two blockers, one still open and one finished, so the UI has to tell them apart.
const subject = await mk(1, 'راه‌اندازی خط لولهٔ گزارش روزانه', 'TODO');
const openBlocker = await mk(2, 'مهاجرت جدول کاربران به شناسهٔ یکتا', 'IN_PROGRESS');
const doneBlocker = await mk(3, 'افزودن ستون وضعیت به جدول وظیفه‌ها', 'DONE');
const downstream = await mk(4, 'نمایش گزارش روزانه در داشبورد مدیر', 'BACKLOG');

await prisma.taskDependency.createMany({
  data: [
    { taskId: subject.id, blockedByTaskId: openBlocker.id },
    { taskId: subject.id, blockedByTaskId: doneBlocker.id },
    { taskId: downstream.id, blockedByTaskId: subject.id }
  ]
});

const { token } = await createUserSession(owner.id);
const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

console.log(
  JSON.stringify(
    {
      slug,
      blockedTaskUrl: `/${slug}/issue/${subject.key}`,
      takeableTaskUrl: `/${slug}/issue/${openBlocker.key}`,
      session: { token, expiresAt, user: { id: owner.id, name: owner.name, email: owner.email } }
    },
    null,
    2
  )
);
await prisma.$disconnect();
