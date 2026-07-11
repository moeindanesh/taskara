'use client';

import type { FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Activity, AlertTriangle, BookOpen, ChevronDown, Diamond, Loader2, Plus, Send } from 'lucide-react';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
   LinearEmptyState,
   LinearPill,
   LinearSelectPill,
   ProjectGlyph,
   ProjectStatusIcon,
   linearProjectStatusMeta,
} from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate } from '@/lib/jalali';
import { useLiveRefresh, workspaceRefreshSourceMatches, type WorkspaceRefreshDetail } from '@/lib/live-refresh';
import { isRetryableTaskSyncError, loadPendingTaskSyncMutations, sendTaskSyncMutation } from '@/lib/task-sync';
import { taskaraRequest } from '@/lib/taskara-client';
import { applyPendingProjectHealthMutations } from '@/lib/workspace-data/pending';
import type {
   TaskaraKnowledgeSpace,
   TaskaraProject,
   TaskaraProjectHealthUpdate,
   TaskaraProjectUpdateHealth,
   TaskaraTeam,
} from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import { EMPTY_SELECT_VALUE, fromSelectValue, toSelectValue } from '@/lib/select-utils';
import { openMilestoneCreate } from '@/components/taskara/milestones/milestone-dialog-host';

const initialProjectForm = {
   name: '',
   keyPrefix: '',
   description: '',
   teamId: '',
};

const initialHealthForm: ProjectHealthForm = {
   health: 'ON_TRACK',
   summary: '',
   progress: '',
   risks: '',
   decisionsNeeded: '',
   nextUpdateDueAt: '',
};

interface ProjectHealthForm {
   health: TaskaraProjectUpdateHealth;
   summary: string;
   progress: string;
   risks: string;
   decisionsNeeded: string;
   nextUpdateDueAt: string;
}

export function ProjectsView() {
   const navigate = useNavigate();
   const { orgId, teamId } = useParams();
   const workspaceSlug = orgId || 'taskara';
   const activeTeamSlug = teamId && teamId !== 'all' ? teamId : null;
   const [projects, setProjects] = useState<TaskaraProject[]>([]);
   const [teams, setTeams] = useState<TaskaraTeam[]>([]);
   const [knowledgeSpaces, setKnowledgeSpaces] = useState<TaskaraKnowledgeSpace[]>([]);
   const [form, setForm] = useState(initialProjectForm);
   const [modalOpen, setModalOpen] = useState(false);
   const [healthProject, setHealthProject] = useState<TaskaraProject | null>(null);
   const [healthForm, setHealthForm] = useState<ProjectHealthForm>(initialHealthForm);
   const [filter, setFilter] = useState<'all' | 'active'>('all');
   const [error, setError] = useState('');
   const [loading, setLoading] = useState(true);
   const [creatingDocsProjectId, setCreatingDocsProjectId] = useState<string | null>(null);
   const [submittingHealth, setSubmittingHealth] = useState(false);
   const [publishingHealthId, setPublishingHealthId] = useState<string | null>(null);
   const [isPending, startTransition] = useTransition();
   const loadRequestRef = useRef(0);
   const activeTeam = useMemo(
      () => (activeTeamSlug ? teams.find((team) => team.slug === activeTeamSlug) || null : null),
      [activeTeamSlug, teams]
   );

   const load = useCallback(async () => {
      const requestId = ++loadRequestRef.current;
      setError('');
      try {
         const [projectData, teamData, knowledgeSpaceData] = await Promise.all([
            taskaraRequest<TaskaraProject[]>('/projects'),
            taskaraRequest<TaskaraTeam[]>('/teams'),
            taskaraRequest<TaskaraKnowledgeSpace[]>('/knowledge/spaces').catch(() => []),
         ]);
         const pendingMutations = await loadPendingTaskSyncMutations();
         if (requestId !== loadRequestRef.current) return;
         setProjects(applyPendingProjectHealthMutations(projectData, pendingMutations));
         setTeams(teamData);
         setKnowledgeSpaces(knowledgeSpaceData);
         const activeTeam = activeTeamSlug ? teamData.find((team) => team.slug === activeTeamSlug) : null;
         setForm((current) => ({
            ...current,
            teamId: activeTeam?.id || current.teamId,
         }));
      } catch (err) {
         if (requestId === loadRequestRef.current) {
            setError(err instanceof Error ? err.message : fa.project.loadFailed);
         }
      } finally {
         if (requestId === loadRequestRef.current) setLoading(false);
      }
   }, [activeTeamSlug]);

   useEffect(() => {
      void load();
   }, [load]);

   useLiveRefresh(load, {
      fireOnMount: false,
      workspaceEventFilter: projectRefreshSourceMatches,
   });

   useEffect(() => {
      const openProjectModal = () => setModalOpen(true);
      window.addEventListener('taskara:create-project', openProjectModal);
      return () => window.removeEventListener('taskara:create-project', openProjectModal);
   }, []);

   const scopedProjects = useMemo(
      () => (activeTeamSlug ? projects.filter((project) => project.team?.slug === activeTeamSlug) : projects),
      [activeTeamSlug, projects]
   );

   const projectPool = useMemo(() => {
      if (!activeTeamSlug) return projects;
      return [
         ...scopedProjects,
         ...projects.filter((project) => !project.team?.id),
      ];
   }, [activeTeamSlug, projects, scopedProjects]);

   const visibleProjects = useMemo(
      () => (filter === 'active' ? projectPool.filter((project) => project.status === 'ACTIVE') : projectPool),
      [filter, projectPool]
   );

   async function updateProjectTeam(project: TaskaraProject, teamId: string) {
      try {
         await taskaraRequest(`/projects/${project.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ teamId: teamId || null }),
         });
         toast.success(fa.project.teamUpdated);
         startTransition(() => {
            void load();
         });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.project.teamUpdateFailed);
      }
   }

   async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!form.name.trim() || !form.keyPrefix.trim()) {
         toast.error(fa.project.nameRequired);
         return;
      }

      try {
         await taskaraRequest('/projects', {
            method: 'POST',
            body: JSON.stringify({
               name: form.name.trim(),
               keyPrefix: form.keyPrefix.trim().toUpperCase(),
               description: form.description.trim() || undefined,
               teamId: form.teamId || undefined,
            }),
         });
         toast.success(fa.project.created);
         setForm({ ...initialProjectForm, teamId: activeTeamSlug ? form.teamId : '' });
         setModalOpen(false);
         startTransition(() => {
            void load();
         });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.project.createFailed);
      }
   }

   async function createProjectDocs(project: TaskaraProject) {
      const existing = knowledgeSpaces.find((space) => space.projectId === project.id);
      if (existing) {
         navigate(`/${workspaceSlug}/wiki/${existing.key}`);
         return;
      }

      setCreatingDocsProjectId(project.id);
      try {
         const created = await taskaraRequest<TaskaraKnowledgeSpace>('/knowledge/spaces', {
            method: 'POST',
            body: JSON.stringify({
               type: 'PROJECT',
               projectId: project.id,
               name: `${project.name} ${fa.project.docs}`,
            }),
         });
         setKnowledgeSpaces((items) => [created, ...items.filter((item) => item.id !== created.id)]);
         toast.success(fa.project.docsCreated);
         navigate(`/${workspaceSlug}/wiki/${created.key}`);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.project.docsCreateFailed);
      } finally {
         setCreatingDocsProjectId(null);
      }
   }

   function openHealthUpdate(project: TaskaraProject) {
      const latest = project.healthUpdates?.[0];
      setHealthProject(project);
      setHealthForm({
         ...initialHealthForm,
         health: latest?.health || 'ON_TRACK',
      });
   }

   async function handleCreateProjectHealthUpdate(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!healthProject) return;
      if (!healthForm.summary.trim()) {
         toast.error(fa.project.healthSummaryRequired);
         return;
      }

      setSubmittingHealth(true);
      try {
         await sendTaskSyncMutation<TaskaraProjectHealthUpdate>('project_health_update.create', {
            projectId: healthProject.id,
            update: {
               health: healthForm.health,
               summary: healthForm.summary.trim(),
               progress: healthForm.progress.trim() || undefined,
               risks: healthForm.risks.trim() || undefined,
               decisionsNeeded: healthForm.decisionsNeeded.trim() || undefined,
               nextUpdateDueAt: healthForm.nextUpdateDueAt ? new Date(healthForm.nextUpdateDueAt).toISOString() : undefined,
            },
         }, undefined, undefined, {
            keepPendingOnRetryable: true,
         });
         toast.success(fa.project.healthUpdateCreated);
         setHealthProject(null);
         setHealthForm(initialHealthForm);
         startTransition(() => {
            void load();
         });
      } catch (err) {
         if (isRetryableTaskSyncError(err)) {
            toast.message(fa.project.healthUpdateQueued);
            setHealthProject(null);
            setHealthForm(initialHealthForm);
            return;
         }
         toast.error(err instanceof Error ? err.message : fa.project.healthUpdateFailed);
      } finally {
         setSubmittingHealth(false);
      }
   }

   async function publishLatestProjectUpdate(project: TaskaraProject) {
      const latest = project.healthUpdates?.[0];
      if (!latest) {
         toast.error(fa.project.noHealthUpdateToPublish);
         return;
      }

      setPublishingHealthId(latest.id);
      try {
         const result = await taskaraRequest<{
            update: TaskaraProjectHealthUpdate;
            published: boolean;
            reason?: 'missing_binding' | 'missing_config';
         }>(`/projects/${project.id}/updates/${latest.id}/publish-mattermost`, { method: 'POST' });
         if (result.published) {
            toast.success(fa.project.healthUpdatePublished);
         } else {
            toast.info(result.reason === 'missing_binding' ? fa.project.healthPublishNoBinding : fa.project.healthPublishNoConfig);
         }
         startTransition(() => {
            void load();
         });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.project.healthPublishFailed);
      } finally {
         setPublishingHealthId(null);
      }
   }

   return (
      <div className="h-full bg-[#101011]" data-testid="projects-screen">
         {error ? (
            <p className="mx-4 mt-4 rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
               {error}
            </p>
         ) : null}

         <div className="flex h-10 items-center justify-between border-b border-white/6 px-3">
            <div className="flex items-center gap-2">
               <ViewChip active={filter === 'all'} onClick={() => setFilter('all')}>
                  {fa.project.all}
                  <span>{projectPool.length.toLocaleString('fa-IR')}</span>
               </ViewChip>
               <ViewChip active={filter === 'active'} onClick={() => setFilter('active')}>
                  {fa.project.active}
                  <span>{projectPool.filter((project) => project.status === 'ACTIVE').length.toLocaleString('fa-IR')}</span>
               </ViewChip>
            </div>
            <Button
               size="xs"
               variant="secondary"
               className="h-7 rounded-full border border-white/8 bg-white/5 text-zinc-300 hover:bg-white/10"
               onClick={() => setModalOpen(true)}
            >
               <Plus className="size-3.5" />
               {fa.project.newProject}
            </Button>
         </div>

         <div className="h-[calc(100%-40px)] overflow-auto">
            {loading ? (
               <div className="p-4 text-sm text-zinc-500">{fa.app.loading}</div>
            ) : visibleProjects.length === 0 ? (
               <div className="p-5">
                  <LinearEmptyState>{fa.project.noProjects}</LinearEmptyState>
               </div>
            ) : (
               <div className="divide-y divide-white/5">
                  {visibleProjects.map((project) => (
                     <ProjectRow
                        key={project.id}
                        activeTeamId={activeTeam?.id || null}
                        creatingDocs={creatingDocsProjectId === project.id}
                        orgId={workspaceSlug}
                        project={project}
                        projectSpace={knowledgeSpaces.find((space) => space.projectId === project.id) || null}
                        teams={teams}
                        onCreateDocs={(item) => void createProjectDocs(item)}
                        onHealthUpdate={openHealthUpdate}
                        onPublishUpdate={(item) => void publishLatestProjectUpdate(item)}
                        onTeamChange={(teamId) => void updateProjectTeam(project, teamId)}
                        publishingHealth={publishingHealthId === project.healthUpdates?.[0]?.id}
                     />
                  ))}
               </div>
            )}
         </div>

         <Dialog open={modalOpen} onOpenChange={setModalOpen}>
            <DialogContent
               aria-label={fa.project.newProject}
               className="max-w-[980px] gap-0 overflow-hidden border-white/10 bg-[#1d1d20] p-0 shadow-2xl"
            >
               <DialogHeader className="border-b border-white/7 px-5 py-4">
                  <DialogTitle className="flex items-center gap-2 text-sm">
                     <LinearPill>
                        <ProjectGlyph
                           name={form.name || fa.project.newProject}
                           className="size-5 rounded-md"
                           iconClassName="size-3.5"
                        />
                        {fa.nav.projects}
                     </LinearPill>
                     <ChevronDown className="size-4 text-zinc-600" />
                     <span>{fa.project.newProject}</span>
                  </DialogTitle>
                  <DialogDescription className="sr-only">{fa.project.createProject}</DialogDescription>
               </DialogHeader>

               <form onSubmit={handleCreateProject}>
                  <div className="space-y-3 px-5 py-4">
                     <ProjectGlyph name={form.name || fa.project.newProject} />
                     <Input
                        autoFocus
                        className="h-auto border-none bg-transparent px-0 text-xl font-semibold text-zinc-100 shadow-none placeholder:text-zinc-600 focus-visible:ring-0"
                        value={form.name}
                        onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                        placeholder={fa.project.namePlaceholder}
                     />
                     <Input
                        className="border-none bg-transparent px-0 text-sm text-zinc-500 shadow-none placeholder:text-zinc-600 focus-visible:ring-0"
                        value={form.description.split('\n')[0] || ''}
                        onChange={(event) =>
                           setForm((current) => ({
                              ...current,
                              description: [event.target.value, ...current.description.split('\n').slice(1)].join('\n').trimStart(),
                           }))
                        }
                        placeholder={fa.project.summaryPlaceholder}
                     />
                     <div className="flex flex-wrap items-center gap-2 border-b border-white/8 pb-4">
                        <LinearPill>
                           <ProjectStatusIcon status="ACTIVE" />
                           {fa.projectStatus.ACTIVE}
                        </LinearPill>
                        <LinearSelectPill
                           ariaLabel={fa.project.team}
                           options={[
                              { value: '', label: fa.app.unset },
                              ...teams.map((team) => ({ value: team.id, label: team.name })),
                           ]}
                           value={form.teamId}
                           onChange={(teamId) => setForm((current) => ({ ...current, teamId }))}
                        />
                     </div>
                     <Textarea
                        className="min-h-44 resize-none border-none bg-transparent px-0 text-sm leading-6 text-zinc-300 shadow-none placeholder:text-zinc-600 focus-visible:ring-0"
                        value={form.description}
                        onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                        placeholder={fa.project.descriptionPlaceholder}
                     />
                     <label className="grid gap-2 text-sm text-zinc-400">
                        <span>{fa.project.keyPrefix}</span>
                        <Input
                           className="ltr max-w-48 border-white/8 bg-white/[0.03] text-left uppercase text-zinc-300 placeholder:text-zinc-600"
                           value={form.keyPrefix}
                           onChange={(event) => setForm((current) => ({ ...current, keyPrefix: event.target.value }))}
                           placeholder={fa.project.keyPrefixPlaceholder}
                        />
                     </label>
                  </div>
                  <div className="flex justify-end gap-2 border-t border-white/7 px-5 py-3">
                     <Button type="button" variant="secondary" className="rounded-full bg-white/8" onClick={() => setModalOpen(false)}>
                        {fa.app.cancel}
                     </Button>
                     <Button disabled={isPending} className="rounded-full bg-indigo-500 px-5 hover:bg-indigo-400">
                        {fa.project.createProject}
                     </Button>
                  </div>
               </form>
            </DialogContent>
         </Dialog>
         <Dialog open={Boolean(healthProject)} onOpenChange={(open) => !open && setHealthProject(null)}>
            <DialogContent className="max-w-2xl border-white/10 bg-[#1d1d20] [direction:rtl]">
               <DialogHeader>
                  <DialogTitle>{healthProject ? fa.project.healthUpdateFor(healthProject.name) : fa.project.healthUpdate}</DialogTitle>
                  <DialogDescription>{fa.project.healthUpdateDescription}</DialogDescription>
               </DialogHeader>
               <form className="mt-3 grid gap-3" onSubmit={handleCreateProjectHealthUpdate}>
                  <div className="grid gap-2 sm:grid-cols-[180px_minmax(0,1fr)]">
                     <label className="grid gap-1 text-xs text-zinc-500">
                        {fa.project.health}
                        <Select value={healthForm.health} onValueChange={(value) => setHealthForm((current) => ({ ...current, health: value as TaskaraProjectUpdateHealth }))}>
                           <SelectTrigger className="h-9 border-white/8 bg-white/[0.03] text-zinc-200">
                              <SelectValue />
                           </SelectTrigger>
                           <SelectContent className="rounded-lg border-white/10 bg-[#202023] text-zinc-100">
                              {projectHealthOptions.map((option) => (
                                 <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                 </SelectItem>
                              ))}
                           </SelectContent>
                        </Select>
                     </label>
                     <label className="grid gap-1 text-xs text-zinc-500">
                        {fa.project.nextUpdateDue}
                        <Input
                           className="h-9 border-white/8 bg-white/[0.03] text-zinc-200"
                           type="datetime-local"
                           value={healthForm.nextUpdateDueAt}
                           onChange={(event) => setHealthForm((current) => ({ ...current, nextUpdateDueAt: event.target.value }))}
                        />
                     </label>
                  </div>
                  <Textarea
                     className="min-h-20 resize-none border-white/8 bg-white/[0.03] text-sm leading-6 text-zinc-200 placeholder:text-zinc-600"
                     value={healthForm.summary}
                     onChange={(event) => setHealthForm((current) => ({ ...current, summary: event.target.value }))}
                     placeholder={fa.project.healthSummaryPlaceholder}
                  />
                  <Textarea
                     className="min-h-20 resize-none border-white/8 bg-white/[0.03] text-sm leading-6 text-zinc-200 placeholder:text-zinc-600"
                     value={healthForm.progress}
                     onChange={(event) => setHealthForm((current) => ({ ...current, progress: event.target.value }))}
                     placeholder={fa.project.healthProgressPlaceholder}
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                     <Textarea
                        className="min-h-24 resize-none border-white/8 bg-white/[0.03] text-sm leading-6 text-zinc-200 placeholder:text-zinc-600"
                        value={healthForm.risks}
                        onChange={(event) => setHealthForm((current) => ({ ...current, risks: event.target.value }))}
                        placeholder={fa.project.healthRisksPlaceholder}
                     />
                     <Textarea
                        className="min-h-24 resize-none border-white/8 bg-white/[0.03] text-sm leading-6 text-zinc-200 placeholder:text-zinc-600"
                        value={healthForm.decisionsNeeded}
                        onChange={(event) => setHealthForm((current) => ({ ...current, decisionsNeeded: event.target.value }))}
                        placeholder={fa.project.healthDecisionsPlaceholder}
                     />
                  </div>
                  <div className="flex justify-end gap-2 border-t border-white/7 pt-3">
                     <Button type="button" variant="secondary" className="rounded-full bg-white/8" onClick={() => setHealthProject(null)}>
                        {fa.app.cancel}
                     </Button>
                     <Button disabled={submittingHealth} className="rounded-full bg-indigo-500 px-5 hover:bg-indigo-400">
                        {submittingHealth ? <Loader2 className="size-3.5 animate-spin" /> : null}
                        {fa.project.createHealthUpdate}
                     </Button>
                  </div>
               </form>
            </DialogContent>
         </Dialog>
      </div>
   );
}

function ProjectRow({
   activeTeamId,
   creatingDocs,
   orgId,
   project,
   projectSpace,
   teams,
   onCreateDocs,
   onHealthUpdate,
   onPublishUpdate,
   onTeamChange,
   publishingHealth,
}: {
   activeTeamId: string | null;
   creatingDocs: boolean;
   orgId: string;
   project: TaskaraProject;
   projectSpace: TaskaraKnowledgeSpace | null;
   teams: TaskaraTeam[];
   onCreateDocs: (project: TaskaraProject) => void;
   onHealthUpdate: (project: TaskaraProject) => void;
   onPublishUpdate: (project: TaskaraProject) => void;
   onTeamChange: (teamId: string) => void;
   publishingHealth: boolean;
}) {
   const statusMeta = linearProjectStatusMeta[project.status] || linearProjectStatusMeta.ACTIVE;
   const currentTeamId = project.team?.id || '';
   const latestUpdate = project.healthUpdates?.[0] || null;
   const healthMeta = latestUpdate ? projectHealthMeta[latestUpdate.health] : null;
   const HealthIcon = healthMeta?.icon;

   return (
      <article
         className={cn(
            'grid min-h-10 grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-1.5 transition hover:bg-white/[0.035]',
            activeTeamId && !currentTeamId && 'bg-pink-500/[0.025]'
         )}
      >
         <ProjectGlyph name={project.name} />
         <div className="min-w-0">
            <div className="flex items-center gap-2">
               <h2 className="truncate text-sm font-semibold text-zinc-200">{project.name}</h2>
               <span className="ltr rounded bg-white/6 px-1.5 py-0.5 text-[11px] font-medium text-zinc-500">
                  {project.keyPrefix}
               </span>
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-zinc-500">
               {healthMeta && HealthIcon ? (
                  <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px]', healthMeta.className)}>
                     <HealthIcon className="size-3" />
                     {healthMeta.label}
                  </span>
               ) : null}
               <p className="line-clamp-1 min-w-0">{latestUpdate?.summary || project.description || fa.project.noHealthUpdate}</p>
               {latestUpdate?.nextUpdateDueAt ? <span className="hidden shrink-0 md:inline">{formatJalaliDate(latestUpdate.nextUpdateDueAt)}</span> : null}
            </div>
         </div>
         <div className="flex items-center gap-4 text-xs text-zinc-500">
            <div className="flex shrink-0 items-center overflow-hidden rounded-lg border border-white/8 bg-white/[0.03]">
               <Link
                  aria-label={`${fa.project.milestones}: ${project.name}`}
                  className="inline-flex h-8 items-center gap-1.5 px-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100"
                  title={`${fa.project.milestones}: ${(project._count?.milestones || 0).toLocaleString('fa-IR')}`}
                  to={`/${orgId}/milestones?projectId=${encodeURIComponent(project.id)}`}
               >
                  <Diamond className="size-3.5 text-indigo-400" />
                  <span className="hidden xl:inline">{(project._count?.milestones || 0).toLocaleString('fa-IR')}</span>
               </Link>
               <button
                  aria-label={`${fa.milestone.newMilestone}: ${project.name}`}
                  className="inline-flex size-8 items-center justify-center border-r border-white/8 text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-100"
                  title={fa.milestone.newMilestone}
                  type="button"
                  onClick={() => openMilestoneCreate({ projectId: project.id, navigateOnCreate: true })}
               >
                  <Plus className="size-3.5" />
               </button>
            </div>
            <button
               className="hidden h-8 items-center gap-1.5 rounded-md border border-white/8 bg-white/[0.03] px-2 text-xs text-zinc-300 transition hover:bg-white/[0.07] hover:text-zinc-100 sm:inline-flex"
               type="button"
               onClick={() => onHealthUpdate(project)}
            >
               <Activity className="size-3.5" />
               {fa.project.healthUpdate}
            </button>
            {latestUpdate ? (
               <button
                  className="hidden h-8 items-center gap-1.5 rounded-md border border-white/8 bg-white/[0.03] px-2 text-xs text-zinc-300 transition hover:bg-white/[0.07] hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 xl:inline-flex"
                  disabled={publishingHealth}
                  type="button"
                  onClick={() => onPublishUpdate(project)}
               >
                  {publishingHealth ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                  {latestUpdate.publishedAt ? fa.project.republishHealthUpdate : fa.project.publishHealthUpdate}
               </button>
            ) : null}
            {projectSpace ? (
               <Link
                  className="hidden h-8 items-center gap-1.5 rounded-md border border-white/8 bg-white/[0.03] px-2 text-xs text-zinc-300 transition hover:bg-white/[0.07] hover:text-zinc-100 sm:inline-flex"
                  to={`/${orgId}/wiki/${projectSpace.key}`}
               >
                  <BookOpen className="size-3.5" />
                  {fa.project.docs}
               </Link>
            ) : (
               <button
                  className="hidden h-8 items-center gap-1.5 rounded-md border border-white/8 bg-white/[0.03] px-2 text-xs text-zinc-300 transition hover:bg-white/[0.07] hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 sm:inline-flex"
                  disabled={creatingDocs}
                  type="button"
                  onClick={() => onCreateDocs(project)}
               >
                  {creatingDocs ? <Loader2 className="size-3.5 animate-spin" /> : <BookOpen className="size-3.5" />}
                  {fa.project.createDocs}
               </button>
            )}
            <span className="hidden items-center gap-1 md:flex">
               <ProjectStatusIcon status={project.status} />
               {statusMeta.label}
            </span>
            <Select value={toSelectValue(currentTeamId)} onValueChange={(value) => onTeamChange(fromSelectValue(value))}>
               <SelectTrigger
                  aria-label={fa.project.team}
                  className="hidden h-8 w-36 rounded-md border-white/8 bg-white/[0.03] px-2 text-xs text-zinc-300 hover:bg-white/[0.06] lg:flex"
               >
                  <SelectValue />
               </SelectTrigger>
               <SelectContent className="rounded-lg border-white/10 bg-[#202023] text-zinc-100">
                  <SelectItem value={EMPTY_SELECT_VALUE}>{fa.app.unset}</SelectItem>
                  {teams.map((team) => (
                     <SelectItem key={team.id} value={team.id}>
                        {team.name}
                     </SelectItem>
                  ))}
               </SelectContent>
            </Select>
            <span>{(project._count?.tasks || 0).toLocaleString('fa-IR')} {fa.project.issueCount}</span>
         </div>
      </article>
   );
}

function ViewChip({
   active,
   children,
   onClick,
}: {
   active: boolean;
   children: React.ReactNode;
   onClick: () => void;
}) {
   return (
      <button
         className={cn(
            'inline-flex h-7 items-center gap-2 rounded-full border px-2.5 text-sm transition',
            active
               ? 'border-white/10 bg-white/8 text-zinc-100'
               : 'border-white/7 bg-transparent text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
         )}
         type="button"
         onClick={onClick}
      >
         {children}
      </button>
   );
}

const projectHealthOptions: Array<{ value: TaskaraProjectUpdateHealth; label: string }> = [
   { value: 'ON_TRACK', label: fa.project.healthOnTrack },
   { value: 'AT_RISK', label: fa.project.healthAtRisk },
   { value: 'OFF_TRACK', label: fa.project.healthOffTrack },
];

const projectHealthMeta: Record<
   TaskaraProjectUpdateHealth,
   { label: string; className: string; icon: typeof Activity }
> = {
   ON_TRACK: {
      label: fa.project.healthOnTrack,
      className: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
      icon: Activity,
   },
   AT_RISK: {
      label: fa.project.healthAtRisk,
      className: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
      icon: AlertTriangle,
   },
   OFF_TRACK: {
      label: fa.project.healthOffTrack,
      className: 'border-rose-400/20 bg-rose-400/10 text-rose-200',
      icon: AlertTriangle,
   },
};

function projectRefreshSourceMatches(detail: WorkspaceRefreshDetail) {
   return (
      workspaceRefreshSourceMatches(detail, 'knowledge') ||
      workspaceRefreshSourceMatches(detail, 'project') ||
      workspaceRefreshSourceMatches(detail, 'task-sync-mutation') ||
      workspaceRefreshSourceMatches(detail, 'team') ||
      workspaceRefreshSourceMatches(detail, 'workspace')
   );
}
