import { describe, expect, test } from 'bun:test';
import { normalizeWorkspaceMode, resolveWorkspaceCapabilities, workspaceProviderPolicy } from './workspace-mode';

describe('workspace mode contract', () => {
   test('keeps missing legacy mode Team-compatible but rejects unknown modes', () => {
      expect(normalizeWorkspaceMode(undefined)).toBe('TEAM');
      expect(normalizeWorkspaceMode(null)).toBe('TEAM');
      expect(normalizeWorkspaceMode('TEAM')).toBe('TEAM');
      expect(normalizeWorkspaceMode('SUPPORT')).toBe('SUPPORT');
      expect(normalizeWorkspaceMode('FUTURE')).toBeNull();
   });

   test('derives defaults only when capabilities are omitted', () => {
      expect(resolveWorkspaceCapabilities('TEAM', undefined).has('team.tasks')).toBeTrue();
      expect(resolveWorkspaceCapabilities('SUPPORT', undefined).has('support.cases')).toBeTrue();
      expect(resolveWorkspaceCapabilities('SUPPORT', undefined).has('team.tasks')).toBeFalse();
      expect(resolveWorkspaceCapabilities('TEAM', []).size).toBe(0);
   });

   test('drops unknown server capability names instead of enabling a surface', () => {
      const capabilities = resolveWorkspaceCapabilities('SUPPORT', ['future.super-admin']);
      expect(capabilities.size).toBe(0);
   });

   test('keeps Team local-first sync out of the Support provider tree', () => {
      expect(workspaceProviderPolicy('TEAM')).toEqual({
         taskSync: true,
         supportMemoryStore: false,
         inboxPersistence: 'local',
      });
      expect(workspaceProviderPolicy('SUPPORT')).toEqual({
         taskSync: false,
         supportMemoryStore: true,
         inboxPersistence: 'memory',
      });
   });
});
