'use client';

import type { FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ChevronDown, FolderKanban, Plus } from 'lucide-react';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { taskaraRequest } from '@/lib/taskara-client';
import type { TaskaraProject, TaskaraTeam } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';

const initialProjectForm = {
   name: '',
   keyPrefix: '',
   description: '',
   teamId: '',
};

export function ProjectsView() {
   const { teamId } = useParams();
   const activeTeamSlug = teamId && teamId !== 'all' ? teamId : null;
   const [projects, setProjects] = useState<TaskaraProject[]>([]);
   const [teams, setTeams] = useState<TaskaraTeam[]>([]);
   const [form, setForm] = useState(initialProjectForm);
   const [modalOpen, setModalOpen] = useState(false);
   const [filter, setFilter] = useState<'all' | 'active'>('all');
   const [error, setError] = useState('');
   const [loading, setLoading] = useState(true);
   const [isPending, startTransition] = useTransition();
   const activeTeam = useMemo(
      () => (activeTeamSlug ? teams.find((team) => team.slug === activeTeamSlug) || null : null),
      [activeTeamSlug, teams]
   );

   const load = useCallback(async () => {
      setError('');
      try {
         const [projectData, teamData] = await Promise.all([
            taskaraRequest<TaskaraProject[]>('/projects'),
            taskaraRequest<TaskaraTeam[]>('/teams'),
         ]);
         setProjects(projectData);
         setTeams(teamData);
         const activeTeam = activeTeamSlug ? teamData.find((team) => team.slug === activeTeamSlug) : null;
         setForm((current) => ({
            ...current,
            teamId: activeTeam?.id || current.teamId,
         }));
      } catch (err) {
         setError(err instanceof Error ? err.message : fa.project.loadFailed);
      } finally {
         setLoading(false);
      }
   }, [activeTeamSlug]);

   useEffect(() => {
      void load();
   }, [load]);

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
                        project={project}
                        teams={teams}
                        onTeamChange={(teamId) => void updateProjectTeam(project, teamId)}
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
                        <FolderKanban className="size-4 text-pink-400" />
                        {fa.nav.projects}
                     </LinearPill>
                     <ChevronDown className="size-4 text-zinc-600" />
                     <span>{fa.project.newProject}</span>
                  </DialogTitle>
                  <DialogDescription className="sr-only">{fa.project.createProject}</DialogDescription>
               </DialogHeader>

               <form onSubmit={handleCreateProject}>
                  <div className="space-y-3 px-5 py-4">
                     <ProjectGlyph />
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
                           value={form.teamId}
                           onChange={(teamId) => setForm((current) => ({ ...current, teamId }))}
                        >
                           <option value="">{fa.app.unset}</option>
                           {teams.map((team) => (
                              <option key={team.id} value={team.id}>
                                 {team.name}
                              </option>
                           ))}
                        </LinearSelectPill>
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
      </div>
   );
}

function ProjectRow({
   activeTeamId,
   project,
   teams,
   onTeamChange,
}: {
   activeTeamId: string | null;
   project: TaskaraProject;
   teams: TaskaraTeam[];
   onTeamChange: (teamId: string) => void;
}) {
   const statusMeta = linearProjectStatusMeta[project.status] || linearProjectStatusMeta.ACTIVE;
   const currentTeamId = project.team?.id || '';

   return (
      <article
         className={cn(
            'grid min-h-10 grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-1.5 transition hover:bg-white/[0.035]',
            activeTeamId && !currentTeamId && 'bg-pink-500/[0.025]'
         )}
      >
         <ProjectGlyph />
         <div className="min-w-0">
            <div className="flex items-center gap-2">
               <h2 className="truncate text-sm font-semibold text-zinc-200">{project.name}</h2>
               <span className="ltr rounded bg-white/6 px-1.5 py-0.5 text-[11px] font-medium text-zinc-500">
                  {project.keyPrefix}
               </span>
            </div>
            {project.description ? (
               <p className="mt-1 line-clamp-1 text-xs text-zinc-500">{project.description}</p>
            ) : null}
         </div>
         <div className="flex items-center gap-4 text-xs text-zinc-500">
            <span className="hidden items-center gap-1 md:flex">
               <ProjectStatusIcon status={project.status} />
               {statusMeta.label}
            </span>
            <select
               aria-label={fa.project.team}
               className="hidden h-8 rounded-md border border-white/8 bg-white/[0.03] px-2 text-xs text-zinc-300 outline-none hover:bg-white/[0.06] lg:inline"
               value={currentTeamId}
               onChange={(event) => onTeamChange(event.target.value)}
            >
               <option value="">{fa.app.unset}</option>
               {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                     {team.name}
                  </option>
               ))}
            </select>
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
