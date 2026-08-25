import { describe, expect, test } from 'bun:test';
import { workspaceUserCacheKey } from './workspace-cache';

describe('common workspace cache keys', () => {
   test('partitions persistent data by workspace and authenticated user', () => {
      const alice = workspaceUserCacheKey('taskara.inbox.v2:', 'support', 'alice');
      const bob = workspaceUserCacheKey('taskara.inbox.v2:', 'support', 'bob');
      const otherWorkspace = workspaceUserCacheKey('taskara.inbox.v2:', 'team', 'alice');

      expect(alice).not.toBe(bob);
      expect(alice).not.toBe(otherWorkspace);
      expect(alice).toBe('taskara.inbox.v2:support:alice');
   });

   test('returns no storage key for a memory-only Support projection', () => {
      expect(workspaceUserCacheKey('taskara.inbox.v2:', 'support', 'alice', 'memory')).toBeNull();
   });
});
