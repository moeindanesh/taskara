import type { ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import MainLayout from '@/components/layout/main-layout';
import { AcceptInvitePage, LoginPage, OnboardingPage, SignupPage } from '@/components/taskara/auth-pages';
import { HeartbeatView } from '@/components/taskara/heartbeat-view';
import { InboxView } from '@/components/taskara/inbox-view';
import { IssuePage } from '@/components/taskara/issue-page';
import { LeaderboardView } from '@/components/taskara/leaderboard-view';
import { MembersView } from '@/components/taskara/members-view';
import { PageHeader } from '@/components/taskara/page-header';
import { ProjectsView } from '@/components/taskara/projects-view';
import { SettingsView } from '@/components/taskara/settings-view';
import { TasksView } from '@/components/taskara/tasks-view';
import { TeamsView } from '@/components/taskara/teams-view';
import { fa } from '@/lib/fa-copy';
import { WorkspaceTaskSyncProvider } from '@/lib/task-sync-provider';
import { useAuthSession } from '@/store/auth-store';

const pageMetaByRoute = {
  inbox: {
    title: fa.nav.inbox,
    description: fa.pages.inboxDescription,
  },
  tasks: {
    title: fa.nav.allTasks,
    description: fa.pages.allTasksDescription,
  },
  members: {
    title: fa.nav.members,
    description: fa.pages.membersDescription,
  },
  leaderboard: {
    title: fa.nav.leaderboard,
    description: fa.pages.leaderboardDescription,
  },
  heartbeat: {
    title: fa.nav.heartbeat,
    description: fa.pages.heartbeatDescription,
  },
  projects: {
    title: fa.nav.projects,
    description: fa.pages.projectsDescription,
  },
  settings: {
    title: fa.nav.settings,
    description: fa.pages.settingsDescription,
  },
  team: {
    title: fa.nav.issues,
    description: fa.pages.issuesDescription,
  },
  teams: {
    title: fa.nav.teams,
    description: fa.pages.teamsDescription,
  },
} as const;

function WorkspaceShell() {
  const location = useLocation();
  const pathParts = location.pathname.split('/').filter(Boolean);
  const routeKey = pathParts[1] || 'team';
  const isSettingsRoute = routeKey === 'settings';
  const pageMeta =
    routeKey === 'team' && pathParts[3] === 'projects'
      ? pageMetaByRoute.projects
      : pageMetaByRoute[routeKey as keyof typeof pageMetaByRoute] || pageMetaByRoute.team;
  const header =
    routeKey === 'issue' || isSettingsRoute ? null : (
      <PageHeader title={pageMeta.title} description={pageMeta.description} compact />
    );

  return (
    <MainLayout header={header} headersNumber={1} showSidebar={!isSettingsRoute}>
      <Outlet />
    </MainLayout>
  );
}

function AuthenticatedWorkspaceShell() {
  const { session } = useAuthSession();
  const location = useLocation();
  const { orgId } = useParams();

  if (!session) {
    return <Navigate replace to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} />;
  }

  if (!session.workspace?.slug && orgId) {
    return <Navigate replace to="/onboarding" />;
  }

  return (
    <WorkspaceTaskSyncProvider workspaceSlug={orgId || session.workspace?.slug || 'taskara'}>
      <WorkspaceShell />
    </WorkspaceTaskSyncProvider>
  );
}

function RootRedirect() {
  const { session } = useAuthSession();

  if (!session) return <Navigate replace to="/login" />;
  if (!session.workspace?.slug) return <Navigate replace to="/onboarding" />;
  return <Navigate replace to={`/${session.workspace.slug}/team/all/all`} />;
}

function WorkspacePage({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route path="/accept-invite/:token" element={<AcceptInvitePage />} />
      <Route path="/" element={<RootRedirect />} />
      <Route path="/:orgId" element={<AuthenticatedWorkspaceShell />}>
        <Route index element={<WorkspaceRedirect />} />
        <Route path="inbox" element={<WorkspacePage><InboxView /></WorkspacePage>} />
        <Route path="leaderboard" element={<WorkspacePage><LeaderboardView /></WorkspacePage>} />
        <Route path="heartbeat" element={<WorkspacePage><HeartbeatView /></WorkspacePage>} />
        <Route path="members" element={<WorkspacePage><MembersView /></WorkspacePage>} />
        <Route path="projects" element={<WorkspacePage><ProjectsView /></WorkspacePage>} />
        <Route path="settings/*" element={<WorkspacePage><SettingsView /></WorkspacePage>} />
        <Route path="tasks" element={<WorkspacePage><TasksView defaultSystemView="all" personalOnly={false} /></WorkspacePage>} />
        <Route path="team/:teamId/all" element={<WorkspacePage><TasksView /></WorkspacePage>} />
        <Route path="team/:teamId/projects" element={<WorkspacePage><ProjectsView /></WorkspacePage>} />
        <Route path="issue/:taskKey" element={<WorkspacePage><IssuePage /></WorkspacePage>} />
        <Route path="teams" element={<WorkspacePage><TeamsView /></WorkspacePage>} />
        <Route path="*" element={<WorkspaceRedirect />} />
      </Route>
      <Route path="*" element={<Navigate replace to="/" />} />
    </Routes>
  );
}

function WorkspaceRedirect() {
  const { orgId } = useParams();
  if (!orgId) return <Navigate replace to="/onboarding" />;
  return <Navigate replace to={`/${orgId}/team/all/all`} />;
}
