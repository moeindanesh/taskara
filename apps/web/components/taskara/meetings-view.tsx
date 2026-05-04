'use client';

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CalendarDays, CheckSquare, Loader2, Plus, Send, Users, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogClose,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { DescriptionEditor } from '@/components/taskara/description-editor';
import { LazyJalaliDatePicker } from '@/components/taskara/lazy-jalali-date-picker';
import { LinearAvatar, ProjectGlyph } from '@/components/taskara/linear-ui';
import { UserMultiSelectCombobox } from '@/components/taskara/user-multi-select-combobox';
import { formatJalaliDateTime } from '@/lib/jalali';
import { dispatchWorkspaceRefresh, useLiveRefresh } from '@/lib/live-refresh';
import { taskaraRequest } from '@/lib/taskara-client';
import type { PaginatedResponse, SmsSendSummary, TaskaraMeeting, TaskaraProject, TaskaraTask, TaskaraUser } from '@/lib/taskara-types';
import { fa } from '@/lib/fa-copy';
import { cn } from '@/lib/utils';

const emptyMeetingForm = {
   title: '',
   description: '',
   ownerId: '',
   participantIds: [] as string[],
   scheduledAt: '',
};

export function MeetingsView() {
   const navigate = useNavigate();
   const { orgId, meetingId } = useParams();
   const [meetings, setMeetings] = useState<TaskaraMeeting[]>([]);
   const [users, setUsers] = useState<TaskaraUser[]>([]);
   const [projects, setProjects] = useState<TaskaraProject[]>([]);
   const [selected, setSelected] = useState<TaskaraMeeting | null>(null);
   const [loading, setLoading] = useState(true);
   const [detailsLoading, setDetailsLoading] = useState(false);
   const [error, setError] = useState('');
   const [createOpen, setCreateOpen] = useState(false);
   const [form, setForm] = useState(emptyMeetingForm);
   const [submitting, setSubmitting] = useState(false);
   const [smsSending, setSmsSending] = useState(false);
   const [actionTitle, setActionTitle] = useState('');
   const [actionProjectId, setActionProjectId] = useState('');
   const [actionAssigneeId, setActionAssigneeId] = useState('');
   const [actionSubmitting, setActionSubmitting] = useState(false);

   const load = useCallback(async () => {
      setError('');
      try {
         const [meetingResult, userResult, projectResult] = await Promise.all([
            taskaraRequest<PaginatedResponse<TaskaraMeeting>>('/meetings?limit=100'),
            taskaraRequest<PaginatedResponse<TaskaraUser>>('/users?limit=200'),
            taskaraRequest<TaskaraProject[]>('/projects'),
         ]);
         setMeetings(meetingResult.items);
         setUsers(userResult.items);
         setProjects(projectResult);
      } catch (err) {
         setError(err instanceof Error ? err.message : fa.meeting.loadFailed);
      } finally {
         setLoading(false);
      }
   }, []);

   useLiveRefresh(load);

   useEffect(() => {
      const next = meetings.find((item) => item.id === meetingId) || meetings[0] || null;
      setSelected(next);
      if (!meetingId && next && orgId) {
         navigate(`/${orgId}/meetings/${next.id}`, { replace: true });
      }
   }, [meetingId, meetings, navigate, orgId]);

   useEffect(() => {
      let canceled = false;
      async function loadSelected() {
         if (!meetingId) return;
         setDetailsLoading(true);
         try {
            const result = await taskaraRequest<TaskaraMeeting>(`/meetings/${encodeURIComponent(meetingId)}`);
            if (!canceled) {
               setSelected(result);
               setActionProjectId((current) => current || result.project?.id || projects[0]?.id || '');
            }
         } catch (err) {
            if (!canceled) setError(err instanceof Error ? err.message : fa.meeting.loadFailed);
         } finally {
            if (!canceled) setDetailsLoading(false);
         }
      }
      void loadSelected();
      return () => {
         canceled = true;
      };
   }, [meetingId, projects]);

   useEffect(() => {
      setActionProjectId((current) => current || selected?.project?.id || projects[0]?.id || '');
   }, [projects, selected?.project?.id]);

   async function createNewMeeting() {
      if (!form.title.trim()) return;
      setSubmitting(true);
      try {
         const created = await taskaraRequest<TaskaraMeeting>('/meetings', {
            method: 'POST',
            body: JSON.stringify({
               title: form.title,
               description: form.description || undefined,
               ownerId: form.ownerId || undefined,
               participantIds: form.participantIds,
               scheduledAt: form.scheduledAt || undefined,
            }),
         });
         setCreateOpen(false);
         setForm(emptyMeetingForm);
         await load();
         navigate(`/${orgId || 'taskara'}/meetings/${created.id}`);
         dispatchWorkspaceRefresh({ source: 'meeting:create' });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.meeting.createFailed);
      } finally {
         setSubmitting(false);
      }
   }

   async function createActionTask() {
      if (!selected || !actionTitle.trim() || !actionProjectId) return;
      setActionSubmitting(true);
      try {
         await taskaraRequest<PaginatedResponse<TaskaraTask>>(`/meetings/${encodeURIComponent(selected.id)}/tasks`, {
            method: 'POST',
            body: JSON.stringify({
               projectId: actionProjectId,
               tasks: [
                  {
                     title: actionTitle,
                     assigneeId: actionAssigneeId || undefined,
                  },
               ],
            }),
         });
         setActionTitle('');
         setActionAssigneeId('');
         const refreshed = await taskaraRequest<TaskaraMeeting>(`/meetings/${encodeURIComponent(selected.id)}`);
         setSelected(refreshed);
         await load();
         dispatchWorkspaceRefresh({ source: 'meeting:tasks' });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.meeting.taskCreateFailed);
      } finally {
         setActionSubmitting(false);
      }
   }

   async function sendSms() {
      if (!selected) return;
      setSmsSending(true);
      try {
         const result = await taskaraRequest<SmsSendSummary>(`/meetings/${encodeURIComponent(selected.id)}/sms`, {
            method: 'POST',
         });
         toast.success(summaryText(fa.meeting.smsSummary, result));
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.meeting.smsFailed);
      } finally {
         setSmsSending(false);
      }
   }

   return (
      <div className="grid h-full min-h-0 grid-cols-1 overflow-hidden bg-[#101011] text-zinc-200 lg:grid-cols-[360px_minmax(0,1fr)] xl:grid-cols-[390px_minmax(0,1fr)_320px]">
         <section className="flex min-h-0 flex-col border-b border-white/8 lg:border-b-0 lg:border-e">
            <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/8 px-4">
               <div className="flex min-w-0 items-center gap-2">
                  <CalendarDays className="size-4 shrink-0 text-zinc-500" />
                  <h1 className="truncate text-sm font-semibold text-zinc-100">{fa.meeting.title}</h1>
               </div>
               <Button size="icon" variant="ghost" className="size-8 rounded-full text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100" onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" />
               </Button>
            </div>
            {error ? <div className="m-3 rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-2 text-xs leading-5 text-red-200">{error}</div> : null}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
               {loading ? (
                  <EmptyState>{fa.app.loading}</EmptyState>
               ) : meetings.length === 0 ? (
                  <EmptyState>{fa.meeting.noMeetings}</EmptyState>
               ) : (
                  <div className="space-y-1">
                     {meetings.map((meeting) => (
                        <button
                           key={meeting.id}
                           className={cn(
                              'grid w-full grid-cols-[28px_minmax(0,1fr)_auto] gap-3 rounded-lg px-3 py-2.5 text-start transition',
                              selected?.id === meeting.id ? 'bg-white/[0.075]' : 'hover:bg-white/[0.045]'
                           )}
                           type="button"
                           onClick={() => navigate(`/${orgId || 'taskara'}/meetings/${meeting.id}`)}
                        >
                           <span className="mt-0.5 inline-flex size-7 items-center justify-center rounded-full bg-white/[0.055] text-zinc-400">
                              <Users className="size-4" />
                           </span>
                           <span className="min-w-0">
                              <span className="mb-1 block truncate text-sm font-medium text-zinc-200">{meeting.title}</span>
                              <span className="line-clamp-1 text-xs leading-5 text-zinc-500">{descriptionText(meeting.description) || meeting.project?.name || fa.inbox.noDescription}</span>
                           </span>
                           <span className="shrink-0 whitespace-nowrap pt-0.5 text-[11px] text-zinc-500">{formatJalaliDateTime(meeting.scheduledAt || meeting.createdAt)}</span>
                        </button>
                     ))}
                  </div>
               )}
            </div>
         </section>

         <main className="min-h-0 overflow-y-auto">
            {selected ? (
               <div className="mx-auto flex min-h-full w-full max-w-[880px] flex-col px-5 py-5 lg:px-8">
                  <div className="mb-8 flex items-center justify-between gap-3">
                     <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-500">
                        <span>{meetingStatusLabel(selected.status)}</span>
                        <span className="h-1 w-1 rounded-full bg-zinc-700" />
                        <span>{formatJalaliDateTime(selected.scheduledAt || selected.heldAt || selected.createdAt)}</span>
                        {detailsLoading ? <Loader2 className="size-4 animate-spin" /> : null}
                     </div>
                     <Button size="sm" variant="ghost" className="h-8 gap-2 rounded-full text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100" disabled={smsSending} onClick={() => void sendSms()}>
                        {smsSending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                        {fa.meeting.sendSms}
                     </Button>
                  </div>

                  <h2 className="mb-5 break-words text-2xl font-semibold leading-9 text-zinc-50">{selected.title}</h2>
                  <section className="mb-8 min-h-[140px] border-b border-white/8 pb-8">
                     {descriptionText(selected.description) ? <p className="whitespace-pre-wrap text-sm leading-7 text-zinc-300">{descriptionText(selected.description)}</p> : <p className="text-sm text-zinc-600">{fa.meeting.descriptionPlaceholder}</p>}
                  </section>

                  <section className="mb-8">
                     <h3 className="mb-3 text-base font-semibold text-zinc-100">{fa.meeting.createTasks}</h3>
                     <div className="grid gap-2 rounded-lg border border-white/8 bg-[#18181a] p-3 md:grid-cols-[minmax(0,1fr)_180px_180px_auto]">
                        <Input className="h-9 border-white/10 bg-white/[0.03]" placeholder={fa.meeting.actionTitlePlaceholder} value={actionTitle} onChange={(event) => setActionTitle(event.target.value)} />
                        <select className="h-9 rounded-md border border-white/10 bg-[#202023] px-2 text-sm text-zinc-200 outline-none" value={actionProjectId} onChange={(event) => setActionProjectId(event.target.value)}>
                           <option value="">{fa.issue.project}</option>
                           {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                        </select>
                        <select className="h-9 rounded-md border border-white/10 bg-[#202023] px-2 text-sm text-zinc-200 outline-none" value={actionAssigneeId} onChange={(event) => setActionAssigneeId(event.target.value)}>
                           <option value="">{fa.issue.noAssignee}</option>
                           {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
                        </select>
                        <Button className="h-9" disabled={actionSubmitting || !actionTitle.trim() || !actionProjectId} onClick={() => void createActionTask()}>
                           {actionSubmitting ? <Loader2 className="size-4 animate-spin" /> : <CheckSquare className="size-4" />}
                           {fa.app.create}
                        </Button>
                     </div>
                  </section>

                  <section>
                     <h3 className="mb-3 text-base font-semibold text-zinc-100">{fa.meeting.actionItems}</h3>
                     {(selected.tasks || []).length ? (
                        <div className="space-y-2">
                           {(selected.tasks || []).map((link) => (
                              <div key={`${link.meetingId}-${link.taskId}`} className="flex items-center justify-between gap-3 rounded-lg border border-white/8 bg-white/[0.025] px-3 py-2">
                                 <span className="min-w-0">
                                    <span className="ltr me-2 text-xs text-zinc-500">{link.task.key}</span>
                                    <span className="text-sm text-zinc-200">{link.task.title}</span>
                                 </span>
                                 <Button size="sm" variant="ghost" className="h-7 text-xs text-zinc-500" onClick={() => navigate(`/${orgId || 'taskara'}/issue/${encodeURIComponent(link.task.key)}`)}>
                                    {fa.nav.issues}
                                 </Button>
                              </div>
                           ))}
                        </div>
                     ) : (
                        <EmptyState>{fa.app.empty}</EmptyState>
                     )}
                  </section>
               </div>
            ) : (
               <div className="flex h-full items-center justify-center px-6 text-center text-sm text-zinc-500">{fa.meeting.selectMeeting}</div>
            )}
         </main>

         <aside className="hidden min-h-0 overflow-y-auto border-s border-white/8 p-3 xl:block">
            <div className="space-y-3">
               <Panel title={fa.meeting.participants}>
                  {(selected?.participants || []).map((participant) => (
                     <div key={participant.id} className="flex min-w-0 items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2">
                           <LinearAvatar name={participant.user.name} src={participant.user.avatarUrl} className="size-6" />
                           <span className="truncate text-sm text-zinc-300">{participant.user.name}</span>
                        </span>
                        <span className="shrink-0 text-[11px] text-zinc-500">{participant.role === 'OWNER' ? fa.meeting.owner : ''}</span>
                     </div>
                  ))}
               </Panel>
               <Panel title={fa.meeting.project}>
                  <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-300">
                     <ProjectGlyph name={selected?.project?.name} className="size-5 rounded" iconClassName="size-3.5" />
                     <span className="truncate">{selected?.project?.name || fa.app.unset}</span>
                  </div>
               </Panel>
            </div>
         </aside>

         <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogContent
               aria-label={fa.meeting.newMeeting}
               showCloseButton={false}
               className="top-[35%] flex max-h-[calc(100svh-32px)] max-w-[760px] flex-col gap-0 overflow-visible rounded-[18px] border-white/10 bg-[#1d1d20] p-0 text-zinc-100 shadow-[0_18px_70px_rgb(0_0_0/0.55)] sm:max-w-[760px]"
            >
               <DialogHeader className="relative px-5 pt-4 pb-0 text-right">
                  <div className="absolute top-4 end-4 flex items-center gap-2">
                     <DialogClose asChild>
                        <button
                           aria-label={fa.app.close}
                           className="inline-flex size-7 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/6 hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-indigo-400/60 focus-visible:outline-none"
                           title={fa.app.close}
                           type="button"
                        >
                           <X className="size-4" />
                        </button>
                     </DialogClose>
                  </div>
                  <DialogTitle className="flex min-w-0 items-center gap-2 pe-12 text-sm font-semibold text-zinc-200">
                     <span className="inline-flex h-7 max-w-[190px] shrink-0 items-center gap-1.5 rounded-full border border-white/8 bg-[#2a2a2d] px-2.5 text-[12px] font-normal text-zinc-300">
                        <CalendarDays className="size-3.5 text-zinc-500" />
                        {fa.nav.meetings}
                     </span>
                     <span>{fa.meeting.newMeeting}</span>
                  </DialogTitle>
                  <DialogDescription className="sr-only">{fa.pages.meetingsDescription}</DialogDescription>
               </DialogHeader>
               <form
                  className="flex min-h-0 flex-1 flex-col"
                  onSubmit={(event) => {
                     event.preventDefault();
                     void createNewMeeting();
                  }}
               >
                  <div className="flex min-h-[246px] flex-1 flex-col px-5 pt-7">
                     <Input
                        autoFocus
                        className="h-auto border-none bg-transparent px-0 text-xl leading-7 font-semibold text-zinc-100 shadow-none outline-none placeholder:text-zinc-600 focus-visible:ring-0"
                        placeholder={fa.meeting.titlePlaceholder}
                        value={form.title}
                        onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                     />
                     <DescriptionEditor
                        className="mt-2"
                        contentClassName="min-h-24 text-right text-sm leading-6 text-zinc-300"
                        showToolbar={false}
                        value={form.description}
                        variant="plain"
                        users={users}
                        onChange={(description) => setForm((current) => ({ ...current, description }))}
                        placeholder={fa.meeting.descriptionPlaceholder}
                     />
                     <div className="mt-auto flex flex-wrap items-center gap-1.5 pb-4">
                        <label className="relative inline-flex h-6 max-w-[196px] shrink-0">
                           <span className="sr-only">{fa.meeting.owner}</span>
                           <span className="pointer-events-none absolute start-2 top-1/2 z-10 flex -translate-y-1/2 items-center">
                              <Users className="size-3.5 text-zinc-500" />
                           </span>
                           <select
                              aria-label={fa.meeting.owner}
                              className="h-6 min-w-0 cursor-pointer appearance-none rounded-full border border-white/8 bg-[#2a2a2d] py-0 ps-6 pe-2.5 text-[12px] font-normal text-zinc-300 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] outline-none transition hover:bg-[#303033] focus:ring-2 focus:ring-indigo-400/35"
                              value={form.ownerId}
                              onChange={(event) => setForm((current) => ({ ...current, ownerId: event.target.value }))}
                           >
                              <option value="">{fa.meeting.owner}</option>
                              {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
                           </select>
                        </label>
                        <div className="w-[260px] max-w-full">
                           <LazyJalaliDatePicker
                              ariaLabel={fa.meeting.scheduledAt}
                              showTime
                              value={form.scheduledAt}
                              onChange={(scheduledAt) =>
                                 setForm((current) => ({ ...current, scheduledAt: scheduledAt || '' }))
                              }
                           />
                        </div>
                     </div>
                     <div className="mb-4">
                        <UserMultiSelectCombobox
                           ariaLabel={fa.meeting.participants}
                           onChange={(participantIds) => setForm((current) => ({ ...current, participantIds }))}
                           placeholder={fa.meeting.participants}
                           selectedIds={form.participantIds}
                           users={users}
                        />
                     </div>
                  </div>
                  <DialogFooter className="flex-row items-center justify-between border-t border-white/7 px-5 py-3 sm:justify-between">
                     <span className="text-xs text-zinc-600">{fa.meeting.participants}</span>
                     <Button
                        className="h-8 rounded-full bg-indigo-500 px-4 text-sm font-normal text-white hover:bg-indigo-400 disabled:bg-indigo-500/40"
                        disabled={submitting || !form.title.trim()}
                     >
                        {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                        {fa.meeting.create}
                     </Button>
                  </DialogFooter>
               </form>
            </DialogContent>
         </Dialog>
      </div>
   );
}

function Panel({ children, title }: { children: React.ReactNode; title: string }) {
   return (
      <section className="rounded-lg border border-white/8 bg-[#18181a]">
         <div className="border-b border-white/7 px-4 py-3 text-sm font-semibold text-zinc-400">{title}</div>
         <div className="space-y-3 px-4 py-4">{children}</div>
      </section>
   );
}

function EmptyState({ children }: { children: React.ReactNode }) {
   return <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center text-sm text-zinc-500">{children}</div>;
}

function meetingStatusLabel(status: string): string {
   if (status === 'HELD') return fa.meeting.held;
   if (status === 'CANCELED') return fa.meeting.canceled;
   if (status === 'ARCHIVED') return fa.meeting.archived;
   return fa.meeting.planned;
}

function descriptionText(description?: string | null): string {
   const trimmed = description?.trim();
   if (!trimmed) return '';
   if (!trimmed.startsWith('{')) return trimmed;

   try {
      const parsed = JSON.parse(trimmed) as unknown;
      const lines: string[] = [];
      collectDescriptionText(parsed, lines);
      return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
   } catch {
      return '';
   }
}

function collectDescriptionText(value: unknown, lines: string[]): void {
   if (!value || typeof value !== 'object') return;

   if (Array.isArray(value)) {
      for (const item of value) collectDescriptionText(item, lines);
      return;
   }

   const node = value as Record<string, unknown>;
   if (typeof node.text === 'string') {
      lines.push(node.text);
   } else if (node.type === 'mention') {
      lines.push(`@${stringValue(node.mentionName) || stringValue(objectValue(node.attrs)?.mentionName) || ''}`);
   } else if (node.type === 'inline-image') {
      lines.push('[image]');
   }

   const childContainers = [node.root, node.children, node.content];
   const beforeLength = lines.length;
   for (const childContainer of childContainers) {
      if (Array.isArray(childContainer)) {
         for (const child of childContainer) collectDescriptionText(child, lines);
      } else {
         collectDescriptionText(childContainer, lines);
      }
   }

   if (['paragraph', 'heading', 'listitem'].includes(String(node.type)) && lines.length > beforeLength) {
      lines.push('\n');
   }
}

function objectValue(value: unknown): Record<string, unknown> | null {
   return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
   return typeof value === 'string' ? value : '';
}

function summaryText(template: string, summary: SmsSendSummary): string {
   return template
      .replace('{sent}', summary.sent.toLocaleString('fa-IR'))
      .replace('{skipped}', summary.skippedNoPhone.toLocaleString('fa-IR'))
      .replace('{failed}', summary.failed.toLocaleString('fa-IR'));
}
