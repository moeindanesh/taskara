import { prisma } from '@taskara/db';
import { createUserSession } from './apps/api/src/services/auth';
const user = await prisma.user.findUniqueOrThrow({ where: { email: 'operator@wayfinder.taskara' } });
const { token } = await createUserSession(user.id);
console.log(JSON.stringify({ token, expiresAt: new Date(Date.now() + 6.048e8).toISOString(), user: { id: user.id, name: user.name, email: user.email } }));
await prisma.$disconnect();
