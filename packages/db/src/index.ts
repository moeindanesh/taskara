import { PrismaClient } from './generated/client';

const globalForPrisma = globalThis as unknown as { taskaraPrisma?: PrismaClient };

export const prisma = globalForPrisma.taskaraPrisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.taskaraPrisma = prisma;
}

export * from './generated/client';
