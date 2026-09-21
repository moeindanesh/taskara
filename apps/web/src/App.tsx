import type { ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import MainLayout from '@/components/layout/main-layout';
import { SupportMainLayout } from '@/components/layout/support-main-layout';
import { AcceptInvitePage, LoginPage, OnboardingPage, SignupPage, destinationFor } from '@/components/taskara/auth-pages';
import { CommunicationsView } from '@/components/taskara/communications-view';
import { HeartbeatView } from '@/components/taskara/heartbeat-view';
import { InboxView } from '@/components/taskara/inbox-view';
import { IssueRouteDialog } from '@/components/taskara/issue-route-dialog';
import { KnowledgeView } from '@/components/taskara/knowledge-view';
import { CapacitySettingsView } from '@/components/taskara/capacity-settings-view';
import { DecisionQueuesView } from '@/components/taskara/decision-queues-view';
import { ManagerCockpitView } from '@/components/taskara/manager-cockpit-view';
import { MembersView } from '@/components/taskara/members-view';
import { MilestonesView } from '@/components/taskara/milestones/milestones-view';
import { PageHeader } from '@/components/taskara/page-header';
import { PeopleWorkloadView } from '@/components/taskara/people-workload-view';
import { ProjectsView } from '@/components/taskara/projects-view';
import { ReviewsView } from '@/components/taskara/reviews-view';
import { SettingsView } from '@/components/taskara/settings-view';
import { TasksView } from '@/components/taskara/tasks-view';
import { TaskReportsView } from '@/components/taskara/task-reports-view';
import { TeamHealthView } from '@/components/taskara/team-health-view';
import { TeamOverviewView } from '@/components/taskara/team-overview/team-overview-view';
import { TeamsView } from '@/components/taskara/teams-view';
import { SupportNoAccessView, SupportSetupView } from '@/components/taskara/support-workspace-placeholder';
import { SupportCaseQueueView } from '@/components/taskara/support-case-queue-view';
import { SupportCaseDetailView } from '@/components/taskara/support-case-detail-view';
import { SupportDepartmentsView } from '@/components/taskara/support-departments-view';
import { SupportOperationsView } from '@/components/taskara/support-operations-view';
import { SupportIntakeAdminView } from '@/components/taskara/support-intake-admin-view';
import { SupportReportsView } from '@/components/taskara/support-reports-view';
import { SupportRoutingView } from '@/components/taskara/support-routing-view';
import { SupportSavedQueuesView } from '@/components/taskara/support-saved-queues-view';
import { SupportMaturityView } from '@/components/taskara/support-maturity-view';
import { WorkspaceInboxSyncProvider } from '@/lib/inbox-sync';
import { WorkspaceKnowledgeSyncProvider } from '@/lib/knowledge-sync';
import { SupportWorkspaceProvider } from '@/lib/support-workspace-provider';
import { WorkspaceTaskSyncProvider } from '@/lib/task-sync-provider';
import {
  defaultWorkspacePath,
  workspacePathIsAvailable,
  workspaceRouteForPath,
} from '@/lib/workspace-navigation';
import {
  WorkspaceRuntimeBoundary,
  useWorkspaceNavigationRuntime,
  useWorkspaceRuntime,
} from '@/lib/workspace-runtime';
import { useAuthSession } from '@/store/auth-store';
import { workspaceProviderPolicy } from '@/lib/workspace-mode';

function WorkspaceShell() {
  const location = useLocation();
  const runtime = useWorkspaceRuntime();
  const navigationRuntime = useWorkspaceNavigationRuntime();
  const route = workspaceRouteForPath(location.pathname, runtime.workspaceSlug);
  if (!route || !workspacePathIsAvailable(location.pathname, runtime.workspaceSlug, navigationRuntime)) {
    return <Navigate replace to={defaultWorkspacePath(runtime.workspaceSlug, navigationRuntime)} />;
  }

  const isSettingsRoute = route.id === 'settings';
  const isKnowledgeRoute = route.id === 'knowledge';
  const isTaskRoute = route.id === 'all-tasks' || route.id === 'my-tasks';
  const header =
    route.id === 'task-detail' || route.id === 'support-case-detail' || route.id === 'inbox' || route.id === 'communications' || isSettingsRoute ? null : (
      <PageHeader
        title={route.label}
        description={route.id === 'milestones' ? undefined : route.description}
        compact
        showViewControls={isTaskRoute}
      />
    );

  const content = runtime.mode === 'TEAM' ? (
    <MainLayout header={header} headersNumber={1} showSidebar={!isSettingsRoute && !isKnowledgeRoute}>
      <Outlet />
    </MainLayout>
  ) : (
    <SupportMainLayout header={header} showSidebar={!isSettingsRoute && !isKnowledgeRoute}>
      <Outlet />
    </SupportMainLayout>
  );

  return content;
}

function AuthenticatedWorkspaceShell() {
  const { session } = useAuthSession();
  const location = useLocation();
  const { orgId } = useParams();

  if (!session) {
    return <Navigate replace to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} />;
  }

  if (!orgId) return <Navigate replace to="/onboarding" />;

  return (
    <WorkspaceRuntimeBoundary
      key={`${orgId}:${session.user.id}:${session.token}`}
      workspaceSlug={orgId}
    >
      <WorkspaceProviders />
    </WorkspaceRuntimeBoundary>
  );
}

function WorkspaceProviders() {
  const runtime = useWorkspaceRuntime();
  const providerPolicy = workspaceProviderPolicy(runtime.mode);
  const sensitivePartitionKey = runtime.mode === 'SUPPORT'
    ? `${runtime.identityKey}:${runtime.me.supportAccessEpoch || 0}`
    : runtime.identityKey;
  let content: ReactNode = <WorkspaceShell />;

  if (runtime.capabilities.has('common.knowledge')) {
    content = (
      <WorkspaceKnowledgeSyncProvider
        key={`knowledge:${runtime.identityKey}`}
        mode={runtime.mode}
        userId={runtime.me.user.id}
        workspaceSlug={runtime.workspaceSlug}
      >
        {content}
      </WorkspaceKnowledgeSyncProvider>
    );
  }

  if (runtime.capabilities.has('common.inbox')) {
    content = (
      <WorkspaceInboxSyncProvider
        key={`inbox:${sensitivePartitionKey}`}
        persistence={providerPolicy.inboxPersistence}
        userId={runtime.me.user.id}
        workspaceSlug={runtime.workspaceSlug}
      >
        {content}
      </WorkspaceInboxSyncProvider>
    );
  }

  if (providerPolicy.taskSync) {
    return (
      <WorkspaceTaskSyncProvider key={`tasks:${runtime.identityKey}`} workspaceSlug={runtime.workspaceSlug}>
        {content}
      </WorkspaceTaskSyncProvider>
    );
  }

  return <SupportWorkspaceProvider key={`support:${sensitivePartitionKey}`}>{content}</SupportWorkspaceProvider>;
}

function RootRedirect() {
  const { session } = useAuthSession();

  if (!session) return <Navigate replace to="/login" />;
  if (!session.workspace?.slug) return <Navigate replace to="/onboarding" />;
  return <Navigate replace to={destinationFor(session)} />;
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
        <Route path="overview" element={<WorkspacePage><TeamOverviewView /></WorkspacePage>} />
        <Route path="cockpit" element={<WorkspacePage><ManagerCockpitView /></WorkspacePage>} />
        <Route path="queues" element={<WorkspacePage><DecisionQueuesView /></WorkspacePage>} />
        <Route path="reviews" element={<WorkspacePage><ReviewsView /></WorkspacePage>} />
        <Route path="people" element={<WorkspacePage><PeopleWorkloadView /></WorkspacePage>} />
        <Route path="today" element={<WorkspacePage><WorkspaceRedirect /></WorkspacePage>} />
        <Route path="daily-reports" element={<WorkspacePage><WorkspaceRedirect /></WorkspacePage>} />
        <Route path="capacity" element={<WorkspacePage><CapacitySettingsView /></WorkspacePage>} />
        <Route path="inbox" element={<WorkspacePage><InboxView /></WorkspacePage>} />
        <Route path="communications" element={<WorkspacePage><CommunicationsView /></WorkspacePage>} />
        <Route path="communications/announcements/:announcementId" element={<WorkspacePage><CommunicationsView /></WorkspacePage>} />
        <Route path="communications/meetings/:meetingId" element={<WorkspacePage><CommunicationsView /></WorkspacePage>} />
        <Route path="announcements" element={<WorkspacePage><CommunicationsView /></WorkspacePage>} />
        <Route path="announcements/:announcementId" element={<WorkspacePage><CommunicationsView /></WorkspacePage>} />
        <Route path="meetings" element={<WorkspacePage><CommunicationsView /></WorkspacePage>} />
        <Route path="meetings/:meetingId" element={<WorkspacePage><CommunicationsView /></WorkspacePage>} />
        <Route path="wiki" element={<WorkspacePage><KnowledgeView /></WorkspacePage>} />
        <Route path="wiki/:spaceKey" element={<WorkspacePage><KnowledgeView /></WorkspacePage>} />
        <Route path="wiki/:spaceKey/:pageId" element={<WorkspacePage><KnowledgeView /></WorkspacePage>} />
        <Route path="team-health" element={<WorkspacePage><TeamHealthView /></WorkspacePage>} />
        <Route path="leaderboard" element={<WorkspacePage><TeamHealthView /></WorkspacePage>} />
        <Route path="heartbeat" element={<WorkspacePage><HeartbeatView /></WorkspacePage>} />
        <Route path="members" element={<WorkspacePage><MembersView /></WorkspacePage>} />
        <Route path="projects" element={<WorkspacePage><ProjectsView /></WorkspacePage>} />
        <Route path="milestones" element={<WorkspacePage><MilestonesView /></WorkspacePage>} />
        <Route path="milestones/:milestoneId" element={<WorkspacePage><MilestonesView /></WorkspacePage>} />
        <Route path="settings/*" element={<WorkspacePage><SettingsView /></WorkspacePage>} />
        <Route path="reports" element={<WorkspacePage><TaskReportsView /></WorkspacePage>} />
        <Route path="tasks" element={<WorkspacePage><TasksView defaultSystemView="all" personalOnly={false} /></WorkspacePage>} />
        <Route path="team/:teamId/all" element={<WorkspacePage><TasksView /></WorkspacePage>} />
        <Route path="team/:teamId/projects" element={<WorkspacePage><ProjectsView /></WorkspacePage>} />
        <Route path="issue/:taskKey" element={<WorkspacePage><IssueRouteDialog /></WorkspacePage>} />
        <Route path="teams" element={<WorkspacePage><TeamsView /></WorkspacePage>} />
        <Route path="support/setup" element={<WorkspacePage><SupportSetupView /></WorkspacePage>} />
        <Route path="support/no-access" element={<WorkspacePage><SupportNoAccessView /></WorkspacePage>} />
        <Route path="support/triage" element={<WorkspacePage><SupportCaseQueueView queue="TRIAGE" /></WorkspacePage>} />
        <Route path="support/my-cases" element={<WorkspacePage><SupportCaseQueueView queue="MY_CASES" /></WorkspacePage>} />
        <Route path="support/department-inbox" element={<WorkspacePage><SupportCaseQueueView queue="DEPARTMENT_INBOX" /></WorkspacePage>} />
        <Route path="support/attention" element={<WorkspacePage><SupportCaseQueueView queue="NEEDS_ATTENTION" /></WorkspacePage>} />
        <Route path="support/departments" element={<WorkspacePage><SupportDepartmentsView /></WorkspacePage>} />
        <Route path="support/routing" element={<WorkspacePage><SupportRoutingView /></WorkspacePage>} />
        <Route path="support/saved-queues" element={<WorkspacePage><SupportSavedQueuesView /></WorkspacePage>} />
        <Route path="support/maturity" element={<WorkspacePage><SupportMaturityView /></WorkspacePage>} />
        <Route path="support/cases/:caseKey" element={<WorkspacePage><SupportCaseDetailView /></WorkspacePage>} />
        <Route path="support/reports" element={<WorkspacePage><SupportReportsView /></WorkspacePage>} />
        <Route path="support/operations" element={<WorkspacePage><SupportOperationsView /></WorkspacePage>} />
        <Route path="support/intake-admin" element={<WorkspacePage><SupportIntakeAdminView /></WorkspacePage>} />
        <Route path="*" element={<WorkspaceRedirect />} />
      </Route>
      <Route path="*" element={<Navigate replace to="/" />} />
    </Routes>
  );
}

function WorkspaceRedirect() {
  const navigationRuntime = useWorkspaceNavigationRuntime();
  const { orgId } = useParams();
  if (!orgId) return <Navigate replace to="/onboarding" />;
  return <Navigate replace to={defaultWorkspacePath(orgId, navigationRuntime)} />;
}
