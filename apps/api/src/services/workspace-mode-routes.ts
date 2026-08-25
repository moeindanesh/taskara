import type { FastifyRequest } from 'fastify';
import type { WorkspaceModeValue } from '@taskara/shared';
import { getRequestActor } from './actor';
import { HttpError } from './http';
import { assertWorkspaceMode } from './workspace-mode';

export type WorkspaceRouteMode =
  | 'PUBLIC'
  | 'COMMON'
  | WorkspaceModeValue
  | 'TEAM_INTEGRATION'
  | 'SUPPORT_INTAKE'
  | 'UNCLASSIFIED';

const publicRoutePrefixes = ['/auth'];
const commonRoutePrefixes = ['/users', '/notifications', '/knowledge', '/media', '/workspace-connections'];
const teamRoutePrefixes = [
  '/agent',
  '/agent-credentials',
  '/ai',
  '/announcements',
  '/assignment',
  '/attention',
  '/capacity',
  '/check-ins',
  '/leaderboard',
  '/meeting-action-items',
  '/meetings',
  '/milestones',
  '/one-on-ones',
  '/projects',
  '/raycast',
  '/reports/tasks',
  '/reviews',
  '/sync',
  '/tasks',
  '/teams',
  '/triage/tasks',
  '/views',
  '/work-health'
];

/**
 * Every workspace route belongs to one coherent product surface. Unknown routes fail closed in the
 * hook below so a newly registered Team endpoint cannot accidentally become available to Support.
 */
export function workspaceRouteMode(routeUrl: string): WorkspaceRouteMode {
  if (
    routeUrl === '/health'
    || routeUrl === '/support/csat/respond'
    || publicRoutePrefixes.some((prefix) => matchesRoutePrefix(routeUrl, prefix))
  ) {
    return 'PUBLIC';
  }
  if (routeUrl === '/workspaces' || routeUrl === '/me' || routeUrl === '/activity') return 'COMMON';
  if (commonRoutePrefixes.some((prefix) => matchesRoutePrefix(routeUrl, prefix))) return 'COMMON';
  if (
    routeUrl === '/support/intake/:lookupId/events'
    || routeUrl === '/support/intake/:lookupId/receipts/:receiptId'
  ) return 'SUPPORT_INTAKE';
  if (matchesRoutePrefix(routeUrl, '/support')) return 'SUPPORT';
  if (routeUrl === '/integrations/mattermost/command') return 'TEAM_INTEGRATION';
  if (teamRoutePrefixes.some((prefix) => matchesRoutePrefix(routeUrl, prefix))) return 'TEAM';
  return 'UNCLASSIFIED';
}

export async function enforceWorkspaceRouteMode(request: FastifyRequest): Promise<void> {
  const routeUrl = request.routeOptions.url ?? request.url.split('?')[0] ?? '';
  const classification = workspaceRouteMode(routeUrl);
  if (
    classification === 'PUBLIC'
    || classification === 'COMMON'
    || classification === 'TEAM_INTEGRATION'
    || classification === 'SUPPORT_INTAKE'
  ) return;
  if (classification === 'UNCLASSIFIED') {
    throw new HttpError(500, `Workspace route mode is not classified: ${routeUrl}`);
  }

  const actor = await getRequestActor(request);
  assertWorkspaceMode(actor.workspace, classification);
}

function matchesRoutePrefix(routeUrl: string, prefix: string): boolean {
  return routeUrl === prefix || routeUrl.startsWith(`${prefix}/`);
}
