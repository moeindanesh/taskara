export type WorkspaceCachePersistence = 'local' | 'memory';

export function workspaceUserCacheKey(
   prefix: string,
   workspaceSlug: string,
   userId: string,
   persistence: WorkspaceCachePersistence = 'local'
): string | null {
   if (persistence === 'memory') return null;
   return `${prefix}${encodeURIComponent(workspaceSlug)}:${encodeURIComponent(userId)}`;
}
