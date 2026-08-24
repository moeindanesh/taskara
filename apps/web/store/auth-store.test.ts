import { describe, expect, test } from 'bun:test';
import { authSessionsEqual } from './auth-store';
import type { TaskaraAuthSession } from '@/lib/taskara-types';

describe('auth session equality', () => {
   test('compares workspace mode, capabilities, permissions, and Support access epoch', () => {
      const base = session();
      expect(authSessionsEqual(base, { ...base })).toBeTrue();
      expect(authSessionsEqual(base, session({ workspace: { ...base.workspace!, mode: 'SUPPORT' } }))).toBeFalse();
      expect(authSessionsEqual(base, session({ capabilities: ['team.tasks'] }))).toBeFalse();
      expect(authSessionsEqual(base, session({ permissions: ['support.triage.read'] }))).toBeFalse();
      expect(authSessionsEqual(base, session({ supportAccessEpoch: 2 }))).toBeFalse();
      expect(authSessionsEqual(base, session({ support: { needsSetup: false } }))).toBeFalse();
   });

   test('treats capability and permission ordering as irrelevant', () => {
      const left = session({
         capabilities: ['team.tasks', 'common.inbox'],
         permissions: ['b', 'a'],
      });
      const right = session({
         capabilities: ['common.inbox', 'team.tasks'],
         permissions: ['a', 'b'],
      });
      expect(authSessionsEqual(left, right)).toBeTrue();
   });
});

function session(overrides: Partial<TaskaraAuthSession> = {}): TaskaraAuthSession {
   return {
      token: 'token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      role: 'MEMBER',
      workspace: {
         id: 'workspace-1',
         name: 'Acme',
         slug: 'acme',
         mode: 'TEAM',
      },
      user: {
         id: 'user-1',
         name: 'Alice',
         email: 'alice@example.test',
      },
      capabilities: ['common.inbox', 'team.tasks'],
      permissions: [],
      supportAccessEpoch: 1,
      ...overrides,
   };
}
