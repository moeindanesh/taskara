import { prisma } from '@taskara/db';
import { HttpError } from './http';

export async function assertPhoneAvailable(phone: string | null | undefined, userId?: string): Promise<void> {
  if (!phone) return;
  const existing = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
  if (existing && existing.id !== userId) {
    throw new HttpError(409, 'Phone number is already linked to another user');
  }
}
