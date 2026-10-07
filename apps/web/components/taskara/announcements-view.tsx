'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Bell, Check, ListChecks, Loader2, Megaphone, Plus, Send, X } from 'lucide-react';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { LinearAvatar } from '@/components/taskara/linear-ui';
import { SmsConfirmDialog } from '@/components/taskara/sms-confirm-dialog';
import { UserMultiSelectCombobox } from '@/components/taskara/user-multi-select-combobox';
import { formatJalaliDateTime } from '@/lib/jalali';
import { dispatchWorkspaceRefresh, useLiveRefresh, workspaceRefreshSourceMatches } from '@/lib/live-refresh';
import { taskaraRequest } from '@/lib/taskara-client';
import type { AnnouncementsResponse, PaginatedResponse, SmsSendSummary, TaskaraAnnouncement, TaskaraUser } from '@/lib/taskara-types';
import { fa } from '@/lib/fa-copy';
import { useAuthSession } from '@/store/auth-store';
import { cn } from '@/lib/utils';

const MIN_POLL_OPTIONS = 2;
const MAX_POLL_OPTIONS = 12;
const announcementsRefreshOrigin = 'announcements-view';

type AnnouncementPollDraftForm = {
   enabled: boolean;
   question: string;
   options: string[];
   allowMultiple: boolean;
};

type AnnouncementForm = {
   title: string;
   body: string;
   recipientIds: string[];
   poll: AnnouncementPollDraftForm;
};

function createEmptyForm(): AnnouncementForm {
   return {
      title: '',
      body: '',
      recipientIds: [],
      poll: {
         enabled: false,
         question: '',
         options: ['', ''],
         allowMultiple: false,
      },
   };
}

function mergeAnnouncementDetail(
   current: TaskaraAnnouncement | null,
   incoming: TaskaraAnnouncement
): TaskaraAnnouncement {
   if (!current || current.id !== incoming.id) return incoming;

   return {
      ...current,
      ...incoming,
      poll: 'poll' in incoming ? incoming.poll : current.poll,
      pollVoteOptionIds: incoming.pollVoteOptionIds ?? current.pollVoteOptionIds,
      recipients: incoming.recipients ?? current.recipients,
   };
}

export function AnnouncementsView() {
   const navigate = useNavigate();
   const { orgId, announcementId } = useParams();
   const { session } = useAuthSession();
   const currentUserId = session?.user.id || null;
   const [announcements, setAnnouncements] = useState<TaskaraAnnouncement[]>([]);
   const [users, setUsers] = useState<TaskaraUser[]>([]);
   const [selected, setSelected] = useState<TaskaraAnnouncement | null>(null);
   const [unreadCount, setUnreadCount] = useState(0);
   const [loading, setLoading] = useState(true);
   const [detailsLoading, setDetailsLoading] = useState(false);
   const [error, setError] = useState('');
   const [createOpen, setCreateOpen] = useState(false);
   const [form, setForm] = useState<AnnouncementForm>(() => createEmptyForm());
   const [submittingAction, setSubmittingAction] = useState<'draft' | 'publish' | null>(null);
   const [draftRecipientIds, setDraftRecipientIds] = useState<string[]>([]);
   const [publishSubmitting, setPublishSubmitting] = useState(false);
   const [smsSending, setSmsSending] = useState(false);
   const [smsConfirmOpen, setSmsConfirmOpen] = useState(false);
   const [pollSelection, setPollSelection] = useState<string[]>([]);
   const [pollVoting, setPollVoting] = useState(false);
   const loadRequestRef = useRef(0);
   const selectedRecipient = announcementRecipientForUser(selected, currentUserId);
   const selectedIsRead = Boolean(selectedRecipient?.readAt);
   const selectedCanMarkRead = Boolean(selectedRecipient && !selectedRecipient.readAt);
   const selectedCanVotePoll = Boolean(selected?.poll && selected.status === 'PUBLISHED' && selectedRecipient);
   const selectedPollTotalVotes = (selected?.poll?.options || []).reduce((sum, option) => sum + (option._count?.votes || 0), 0);

   const load = useCallback(async () => {
      const requestId = ++loadRequestRef.current;
      setError('');
      try {
         const [announcementResult, userResult] = await Promise.all([
            taskaraRequest<AnnouncementsResponse>('/announcements?limit=100'),
            taskaraRequest<PaginatedResponse<TaskaraUser>>('/users?limit=200'),
         ]);
         if (requestId !== loadRequestRef.current) return;
         setAnnouncements(announcementResult.items);
         setUnreadCount(announcementResult.unreadCount);
         setUsers(userResult.items);
      } catch (err) {
         if (requestId === loadRequestRef.current) {
            setError(err instanceof Error ? err.message : fa.announcement.loadFailed);
         }
      } finally {
         if (requestId === loadRequestRef.current) setLoading(false);
      }
   }, []);

   useLiveRefresh(load, {
      ignoreWorkspaceEventOrigins: [announcementsRefreshOrigin],
      workspaceEventFilter: (detail) => workspaceRefreshSourceMatches(detail, 'announcement'),
   });

   useEffect(() => {
      const next = announcementId
         ? announcements.find((item) => item.id === announcementId) || null
         : announcements[0] || null;
      setSelected((current) => {
         if (next) return mergeAnnouncementDetail(current, next);
         return announcementId && current?.id === announcementId ? current : null;
      });
      if (!announcementId && next && orgId) {
         navigate(`/${orgId}/announcements/${next.id}`, { replace: true });
      }
   }, [announcementId, announcements, navigate, orgId]);

   useEffect(() => {
      let canceled = false;
      async function loadSelected() {
         if (!announcementId) return;
         setError('');
         setSelected((current) => (current?.id === announcementId ? current : null));
         setDetailsLoading(true);
         try {
            const result = await taskaraRequest<TaskaraAnnouncement>(`/announcements/${encodeURIComponent(announcementId)}`);
            if (!canceled) setSelected(result);
         } catch (err) {
            if (!canceled) setError(err instanceof Error ? err.message : fa.announcement.loadFailed);
         } finally {
            if (!canceled) setDetailsLoading(false);
         }
      }
      void loadSelected();
      return () => {
         canceled = true;
      };
   }, [announcementId]);

   useEffect(() => {
      setDraftRecipientIds((selected?.recipients || []).map((recipient) => recipient.userId));
   }, [selected?.id, selected?.recipients]);

   useEffect(() => {
      setPollSelection(selected?.pollVoteOptionIds || []);
   }, [selected?.id, selected?.pollVoteOptionIds]);

   async function createNewAnnouncement(publish: boolean) {
      if (!form.title.trim() || (publish && !form.recipientIds.length)) return;
      const pollValidation = validatePollDraft(form.poll);
      if (!pollValidation.valid) {
         toast.error(pollValidation.message || fa.announcement.createFailed);
         return;
      }
      setSubmittingAction(publish ? 'publish' : 'draft');
      try {
         const created = await taskaraRequest<TaskaraAnnouncement>('/announcements', {
            method: 'POST',
            body: JSON.stringify({
               title: form.title,
               body: form.body,
               recipientIds: form.recipientIds,
               poll: pollValidation.poll,
               publish,
            }),
         });
         setCreateOpen(false);
         setForm(createEmptyForm());
         await load();
         navigate(`/${orgId || 'taskara'}/announcements/${created.id}`);
         dispatchWorkspaceRefresh({ source: 'announcement:create', origin: announcementsRefreshOrigin });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.announcement.createFailed);
      } finally {
         setSubmittingAction(null);
      }
   }

   async function markRead() {
      if (!selected || !selectedCanMarkRead) return;
      try {
         const updated = await taskaraRequest<TaskaraAnnouncement>(`/announcements/${encodeURIComponent(selected.id)}/read`, {
            method: 'PATCH',
         });
         setSelected(updated);
         await load();
         dispatchWorkspaceRefresh({ source: 'announcement:read', origin: announcementsRefreshOrigin });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.announcement.updateFailed);
      }
   }

   async function sendSms() {
      if (!selected) return;
      setSmsSending(true);
      try {
         const result = await taskaraRequest<SmsSendSummary>(`/announcements/${encodeURIComponent(selected.id)}/sms`, {
            method: 'POST',
         });
         toast.success(summaryText(fa.announcement.smsSummary, result));
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.announcement.smsFailed);
      } finally {
         setSmsSending(false);
      }
   }

   function requestSmsSend() {
      if (!selected || smsSending) return;
      setSmsConfirmOpen(true);
   }

   function confirmSmsSend() {
      setSmsConfirmOpen(false);
      void sendSms();
   }

   async function publishDraft() {
      if (!selected || selected.status !== 'DRAFT' || draftRecipientIds.length === 0) return;
      setPublishSubmitting(true);
      try {
         const updated = await taskaraRequest<TaskaraAnnouncement>(`/announcements/${encodeURIComponent(selected.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({
               recipientIds: draftRecipientIds,
               status: 'PUBLISHED',
            }),
         });
         setSelected(updated);
         setAnnouncements((items) => items.map((item) => (item.id === updated.id ? updated : item)));
         toast.success(fa.announcement.publishedToast);
         await load();
         dispatchWorkspaceRefresh({ source: 'announcement:publish', origin: announcementsRefreshOrigin });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.announcement.updateFailed);
      } finally {
         setPublishSubmitting(false);
      }
   }

   function toggleCreatePoll(enabled: boolean) {
      setForm((current) => {
         const nextOptions = current.poll.options.length >= MIN_POLL_OPTIONS ? current.poll.options : ['', ''];
         return {
            ...current,
            poll: {
               ...current.poll,
               enabled,
               options: nextOptions,
            },
         };
      });
   }

   function updatePollOption(index: number, value: string) {
      setForm((current) => ({
         ...current,
         poll: {
            ...current.poll,
            options: current.poll.options.map((option, optionIndex) => (optionIndex === index ? value : option)),
         },
      }));
   }

   function addPollOption() {
      setForm((current) => {
         if (current.poll.options.length >= MAX_POLL_OPTIONS) return current;
         return {
            ...current,
            poll: {
               ...current.poll,
               options: [...current.poll.options, ''],
            },
         };
      });
   }

   function removePollOption(index: number) {
      setForm((current) => {
         if (current.poll.options.length <= MIN_POLL_OPTIONS) return current;
         return {
            ...current,
            poll: {
               ...current.poll,
               options: current.poll.options.filter((_, optionIndex) => optionIndex !== index),
            },
         };
      });
   }

   function togglePollSelection(optionId: string) {
      if (!selected?.poll) return;
      if (!selected.poll.allowMultiple) {
         setPollSelection([optionId]);
         return;
      }
      setPollSelection((current) => (
         current.includes(optionId)
            ? current.filter((id) => id !== optionId)
            : [...current, optionId]
      ));
   }

   async function submitPollVote() {
      if (!selected?.poll || !pollSelection.length || !selectedCanVotePoll) return;
      setPollVoting(true);
      try {
         const updated = await taskaraRequest<TaskaraAnnouncement>(`/announcements/${encodeURIComponent(selected.id)}/poll-vote`, {
            method: 'PUT',
            body: JSON.stringify({ optionIds: pollSelection }),
         });
         setSelected(updated);
         setAnnouncements((items) => items.map((item) => (item.id === updated.id ? updated : item)));
         setPollSelection(updated.pollVoteOptionIds || []);
         toast.success(fa.announcement.pollVoteSaved);
         dispatchWorkspaceRefresh({ source: 'announcement:poll-vote', origin: announcementsRefreshOrigin });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.announcement.pollVoteFailed);
      } finally {
         setPollVoting(false);
      }
   }

   return (
      <div className="grid h-full min-h-0 grid-cols-1 overflow-hidden bg-[#101011] text-zinc-200 lg:grid-cols-[360px_minmax(0,1fr)] xl:grid-cols-[390px_minmax(0,1fr)_320px]">
         <section className="flex min-h-0 flex-col border-b border-white/8 lg:border-b-0 lg:border-e">
            <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/8 px-4">
               <div className="flex min-w-0 items-center gap-2">
                  <Megaphone className="size-4 shrink-0 text-zinc-500" />
                  <h1 className="truncate text-sm font-semibold text-zinc-100">{fa.announcement.title}</h1>
                  {unreadCount > 0 ? <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 text-[11px] text-indigo-700 dark:text-indigo-200">{unreadCount.toLocaleString('fa-IR')}</span> : null}
               </div>
               <Button size="icon" variant="ghost" className="size-8 rounded-full text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100" onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" />
               </Button>
            </div>
            {error ? <div className="m-3 rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-2 text-xs leading-5 text-red-700 dark:text-red-200">{error}</div> : null}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
               {loading ? (
                  <EmptyState>{fa.app.loading}</EmptyState>
               ) : announcements.length === 0 ? (
                  <EmptyState>{fa.announcement.noAnnouncements}</EmptyState>
               ) : (
                  <div className="space-y-1">
                     {announcements.map((announcement) => (
                        <button
                           key={announcement.id}
                           className={cn(
                              'grid w-full grid-cols-[28px_minmax(0,1fr)_auto] gap-3 rounded-lg px-3 py-2.5 text-start transition',
                              selected?.id === announcement.id ? 'bg-white/[0.075]' : 'hover:bg-white/[0.045]'
                           )}
                           type="button"
                           onClick={() => navigate(`/${orgId || 'taskara'}/announcements/${announcement.id}`)}
                        >
                           <span className="relative mt-0.5 inline-flex size-7 items-center justify-center rounded-full bg-white/[0.055] text-zinc-400">
                              <Bell className="size-4" />
                              {isAnnouncementUnreadForUser(announcement, currentUserId) ? <span className="absolute -top-0.5 -start-0.5 size-2 rounded-full bg-indigo-400 ring-2 ring-[#101011]" /> : null}
                           </span>
                           <span className="min-w-0">
                              <span className="mb-1 block truncate text-sm font-medium text-zinc-200">{announcement.title}</span>
                              <span className="line-clamp-1 text-xs leading-5 text-zinc-500">{announcement.body || fa.inbox.noDescription}</span>
                           </span>
                           <span className="shrink-0 whitespace-nowrap pt-0.5 text-[11px] text-zinc-500">{formatJalaliDateTime(announcement.publishedAt || announcement.createdAt)}</span>
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
                        <span>{statusLabel(selected.status)}</span>
                        <span className="h-1 w-1 rounded-full bg-zinc-700" />
                        <span>{formatJalaliDateTime(selected.publishedAt || selected.createdAt)}</span>
                        {detailsLoading ? <Loader2 className="size-4 animate-spin" /> : null}
                     </div>
                     <div className="flex items-center gap-1.5">
                        {selected.status === 'DRAFT' ? (
                           <Button
                              size="sm"
                              className="h-8 gap-2 rounded-full bg-indigo-700 dark:bg-indigo-500 px-4 text-sm font-normal text-white hover:bg-indigo-800 dark:hover:bg-indigo-400 disabled:bg-indigo-500/40"
                              disabled={publishSubmitting || draftRecipientIds.length === 0}
                              onClick={() => void publishDraft()}
                           >
                              {publishSubmitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                              {fa.announcement.publishDraft}
                           </Button>
                        ) : (
                           <>
                              <Button
                                 size="sm"
                                 variant="ghost"
                                 className="h-8 gap-2 rounded-full text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 disabled:text-zinc-600"
                                 disabled={!selectedCanMarkRead}
                                 onClick={() => void markRead()}
                              >
                                 <Check className="size-4" />
                                 {selectedIsRead ? fa.announcement.read : fa.announcement.markRead}
                              </Button>
                              <Button size="sm" variant="ghost" className="h-8 gap-2 rounded-full text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100" disabled={smsSending} onClick={requestSmsSend}>
                                 {smsSending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                                 {fa.announcement.sendSms}
                              </Button>
                           </>
                        )}
                     </div>
                  </div>
                  <h2 className="mb-5 break-words text-2xl font-semibold leading-9 text-zinc-50">{selected.title}</h2>
                  <section className="min-h-[140px] border-b border-white/8 pb-8">
                     {selected.body ? <p className="whitespace-pre-wrap text-sm leading-7 text-zinc-300">{selected.body}</p> : <p className="text-sm text-zinc-600">{fa.inbox.noDescription}</p>}
                  </section>
                  {selected.poll ? (
                     <section className="mt-6 space-y-4 rounded-xl border border-white/8 bg-[#18181a] p-4">
                        <div className="flex items-start gap-3">
                           <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-zinc-400">
                              <ListChecks className="size-4" />
                           </span>
                           <div className="min-w-0">
                              <p className="text-sm font-semibold text-zinc-100">{selected.poll.question}</p>
                              <p className="mt-1 text-xs text-zinc-500">
                                 {selected.poll.allowMultiple ? fa.announcement.pollAllowMultiple : fa.announcement.pollVote}
                              </p>
                           </div>
                        </div>
                        <div className="space-y-2">
                           {selected.poll.options.map((option) => {
                              const voteCount = option._count?.votes || 0;
                              const votePercent = selectedPollTotalVotes > 0 ? Math.round((voteCount / selectedPollTotalVotes) * 100) : 0;
                              const isDraftSelected = pollSelection.includes(option.id);
                              const isSavedVote = (selected.pollVoteOptionIds || []).includes(option.id);
                              return (
                                 <button
                                    key={option.id}
                                    className={cn(
                                       'w-full rounded-lg border px-3 py-2 text-start transition',
                                       isDraftSelected ? 'border-indigo-400/80 bg-indigo-500/10' : 'border-white/8 bg-[#1f1f22]',
                                       selectedCanVotePoll ? 'hover:border-indigo-300/70' : 'cursor-default'
                                    )}
                                    disabled={!selectedCanVotePoll || pollVoting}
                                    type="button"
                                    onClick={() => togglePollSelection(option.id)}
                                 >
                                    <div className="flex items-center justify-between gap-3">
                                       <span className="truncate text-sm text-zinc-200">{option.label}</span>
                                       <span className="shrink-0 text-[11px] text-zinc-500">{pollVotesCountText(voteCount)}</span>
                                    </div>
                                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8">
                                       <div className="h-full rounded-full bg-indigo-400/70 transition-all" style={{ width: `${votePercent}%` }} />
                                    </div>
                                    {isSavedVote ? <p className="mt-1 text-[11px] text-indigo-700 dark:text-indigo-200">{fa.announcement.pollYourVote}</p> : null}
                                 </button>
                              );
                           })}
                        </div>
                        {selectedCanVotePoll ? (
                           <Button
                              className="h-8 rounded-full bg-indigo-700 dark:bg-indigo-500 px-4 text-sm font-normal text-white hover:bg-indigo-800 dark:hover:bg-indigo-400 disabled:bg-indigo-500/40"
                              disabled={pollVoting || pollSelection.length === 0}
                              onClick={() => void submitPollVote()}
                           >
                              {pollVoting ? <Loader2 className="size-4 animate-spin" /> : null}
                              {pollVoting ? fa.announcement.pollVoting : fa.announcement.pollVote}
                           </Button>
                        ) : null}
                     </section>
                  ) : null}
                  {selected.status === 'DRAFT' ? (
                     <DraftPublishControls
                        className="mt-6 xl:hidden"
                        draftRecipientIds={draftRecipientIds}
                        publishSubmitting={publishSubmitting}
                        users={users}
                        onPublish={publishDraft}
                        onRecipientsChange={setDraftRecipientIds}
                     />
                  ) : null}
               </div>
            ) : (
               <div className="flex h-full items-center justify-center px-6 text-center text-sm text-zinc-500">{fa.announcement.selectAnnouncement}</div>
            )}
         </main>

         <aside className="hidden min-h-0 overflow-y-auto border-s border-white/8 p-3 xl:block">
            <section className="rounded-lg border border-white/8 bg-[#18181a]">
               <div className="border-b border-white/7 px-4 py-3 text-sm font-semibold text-zinc-400">{fa.announcement.recipients}</div>
               <div className="space-y-3 px-4 py-4">
                  {selected?.status === 'DRAFT' ? (
                     <DraftPublishControls
                        className="border-0 bg-transparent p-0"
                        draftRecipientIds={draftRecipientIds}
                        publishSubmitting={publishSubmitting}
                        users={users}
                        onPublish={publishDraft}
                        onRecipientsChange={setDraftRecipientIds}
                     />
                  ) : (
                     (selected?.recipients || []).map((recipient) => (
                        <div key={recipient.id} className="flex min-w-0 items-center justify-between gap-3">
                           <span className="flex min-w-0 items-center gap-2">
                              <LinearAvatar name={recipient.user.name} src={recipient.user.avatarUrl} className="size-6" />
                              <span className="truncate text-sm text-zinc-300">{recipient.user.name}</span>
                           </span>
                           <span className={cn('shrink-0 text-[11px]', recipient.readAt ? 'text-zinc-500' : 'text-indigo-700 dark:text-indigo-300')}>
                              {recipient.readAt ? formatJalaliDateTime(recipient.readAt) : fa.announcement.unread}
                           </span>
                        </div>
                     ))
                  )}
               </div>
            </section>
         </aside>

         <Dialog
            open={createOpen}
            onOpenChange={(open) => {
               setCreateOpen(open);
               if (!open) setForm(createEmptyForm());
            }}
         >
            <DialogContent
               aria-label={fa.announcement.newAnnouncement}
               showCloseButton={false}
               className="flex max-h-[calc(100svh-32px)] max-w-[760px] flex-col gap-0 overflow-hidden rounded-[18px] border-white/10 bg-[#1d1d20] p-0 text-zinc-100 shadow-[0_18px_70px_rgb(0_0_0/0.55)] sm:max-w-[760px]"
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
                        <Megaphone className="size-3.5 text-zinc-500" />
                        {fa.nav.announcements}
                     </span>
                     <span>{fa.announcement.newAnnouncement}</span>
                  </DialogTitle>
                  <DialogDescription className="sr-only">{fa.pages.announcementsDescription}</DialogDescription>
               </DialogHeader>
               <form
                  className="flex min-h-0 flex-1 flex-col"
                  onSubmit={(event) => {
                     event.preventDefault();
                     void createNewAnnouncement(form.recipientIds.length > 0);
                  }}
               >
                  <div className="flex min-h-[246px] flex-1 flex-col px-5 pt-7">
                     <Input
                        autoFocus
                        className="h-auto border-none bg-transparent px-0 text-xl leading-7 font-semibold text-zinc-100 shadow-none outline-none placeholder:text-zinc-600 focus-visible:ring-0"
                        placeholder={fa.announcement.titlePlaceholder}
                        value={form.title}
                        onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                     />
                     <Textarea
                        className="mt-2 min-h-28 resize-none border-none bg-transparent px-0 text-right text-sm leading-6 text-zinc-300 shadow-none outline-none placeholder:text-zinc-600 focus-visible:ring-0"
                        placeholder={fa.announcement.bodyPlaceholder}
                        value={form.body}
                        onChange={(event) => setForm((current) => ({ ...current, body: event.target.value }))}
                     />
                     <div className="mt-auto space-y-3 pb-4">
                        <section className="space-y-3 rounded-lg border border-white/8 bg-[#18181a] p-3">
                           <div className="flex items-center justify-between gap-3">
                              <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-300">
                                 <ListChecks className="size-4 text-zinc-500" />
                                 <span>{fa.announcement.addPoll}</span>
                              </div>
                              <Switch
                                 aria-label={fa.announcement.addPoll}
                                 checked={form.poll.enabled}
                                 className="data-[state=checked]:bg-indigo-500 data-[state=unchecked]:bg-zinc-700"
                                 onCheckedChange={toggleCreatePoll}
                              />
                           </div>
                           {form.poll.enabled ? (
                              <div className="space-y-2">
                                 <Input
                                    className="h-9 border-white/10 bg-[#202024] text-sm text-zinc-200 placeholder:text-zinc-500 focus-visible:ring-indigo-400/50"
                                    placeholder={fa.announcement.pollQuestionPlaceholder}
                                    value={form.poll.question}
                                    onChange={(event) =>
                                       setForm((current) => ({
                                          ...current,
                                          poll: {
                                             ...current.poll,
                                             question: event.target.value,
                                          },
                                       }))
                                    }
                                 />
                                 {form.poll.options.map((option, index) => (
                                    <div key={`poll-option-${index}`} className="flex items-center gap-2">
                                       <Input
                                          className="h-9 border-white/10 bg-[#202024] text-sm text-zinc-200 placeholder:text-zinc-500 focus-visible:ring-indigo-400/50"
                                          placeholder={pollOptionPlaceholder(index)}
                                          value={option}
                                          onChange={(event) => updatePollOption(index, event.target.value)}
                                       />
                                       <Button
                                          size="icon"
                                          type="button"
                                          variant="ghost"
                                          className="size-8 shrink-0 rounded-full text-zinc-400 hover:bg-white/8 hover:text-zinc-200 disabled:text-zinc-700"
                                          disabled={form.poll.options.length <= MIN_POLL_OPTIONS}
                                          onClick={() => removePollOption(index)}
                                       >
                                          <X className="size-4" />
                                       </Button>
                                    </div>
                                 ))}
                                 <div className="flex items-center justify-between gap-3">
                                    <Button
                                       type="button"
                                       variant="ghost"
                                       className="h-8 rounded-full px-3 text-xs text-zinc-300 hover:bg-white/8 hover:text-zinc-100 disabled:text-zinc-600"
                                       disabled={form.poll.options.length >= MAX_POLL_OPTIONS}
                                       onClick={addPollOption}
                                    >
                                       <Plus className="size-3.5" />
                                       {fa.announcement.pollAddOption}
                                    </Button>
                                    <div className="flex items-center gap-2 text-xs text-zinc-400">
                                       <span>{fa.announcement.pollAllowMultiple}</span>
                                       <Switch
                                          aria-label={fa.announcement.pollAllowMultiple}
                                          checked={form.poll.allowMultiple}
                                          className="data-[state=checked]:bg-indigo-500 data-[state=unchecked]:bg-zinc-700"
                                          onCheckedChange={(checked) =>
                                             setForm((current) => ({
                                                ...current,
                                                poll: {
                                                   ...current.poll,
                                                   allowMultiple: checked,
                                                },
                                             }))
                                          }
                                       />
                                    </div>
                                 </div>
                              </div>
                           ) : null}
                        </section>
                        <UserMultiSelectCombobox
                           ariaLabel={fa.announcement.recipients}
                           onChange={(recipientIds) => setForm((current) => ({ ...current, recipientIds }))}
                           placeholder={fa.announcement.recipients}
                           selectedIds={form.recipientIds}
                           users={users}
                        />
                     </div>
                  </div>
                  <DialogFooter className="flex-row items-center justify-between border-t border-white/7 px-5 py-3 sm:justify-between">
                     <span className="text-xs text-zinc-600">{fa.announcement.recipients}</span>
                     <div className="flex items-center gap-2">
                        <Button
                           type="button"
                           variant="ghost"
                           className="h-8 rounded-full px-4 text-sm font-normal text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100 disabled:text-zinc-600"
                           disabled={Boolean(submittingAction) || !form.title.trim()}
                           onClick={() => void createNewAnnouncement(false)}
                        >
                           {submittingAction === 'draft' ? <Loader2 className="size-4 animate-spin" /> : null}
                           {fa.announcement.saveDraft}
                        </Button>
                        <Button
                           type="button"
                           className="h-8 rounded-full bg-indigo-700 dark:bg-indigo-500 px-4 text-sm font-normal text-white hover:bg-indigo-800 dark:hover:bg-indigo-400 disabled:bg-indigo-500/40"
                           disabled={Boolean(submittingAction) || !form.title.trim() || !form.recipientIds.length}
                           onClick={() => void createNewAnnouncement(true)}
                        >
                           {submittingAction === 'publish' ? <Loader2 className="size-4 animate-spin" /> : null}
                           {fa.announcement.publish}
                        </Button>
                     </div>
                  </DialogFooter>
               </form>
            </DialogContent>
         </Dialog>
         <SmsConfirmDialog
            confirmLabel={fa.app.confirm}
            description={fa.app.smsConfirmDescription}
            open={smsConfirmOpen}
            pending={smsSending}
            title={fa.announcement.sendSms}
            onConfirm={confirmSmsSend}
            onOpenChange={setSmsConfirmOpen}
         />
      </div>
   );
}

function EmptyState({ children }: { children: React.ReactNode }) {
   return <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center text-sm text-zinc-500">{children}</div>;
}

function DraftPublishControls({
   className,
   draftRecipientIds,
   publishSubmitting,
   users,
   onPublish,
   onRecipientsChange,
}: {
   className?: string;
   draftRecipientIds: string[];
   publishSubmitting: boolean;
   users: TaskaraUser[];
   onPublish: () => Promise<void>;
   onRecipientsChange: (recipientIds: string[]) => void;
}) {
   return (
      <section className={cn('space-y-3 rounded-lg border border-white/8 bg-[#18181a] px-4 py-4', className)}>
         <p className="text-xs leading-5 text-zinc-500">{fa.announcement.publishDraftHint}</p>
         <UserMultiSelectCombobox
            ariaLabel={fa.announcement.recipients}
            onChange={onRecipientsChange}
            placeholder={fa.announcement.recipients}
            selectedIds={draftRecipientIds}
            users={users}
         />
         {draftRecipientIds.length === 0 ? <p className="text-xs leading-5 text-amber-800 dark:text-amber-200/80">{fa.announcement.publishDraftNoRecipients}</p> : null}
         <Button
            className="h-8 w-full rounded-full bg-indigo-700 dark:bg-indigo-500 text-sm font-normal text-white hover:bg-indigo-800 dark:hover:bg-indigo-400 disabled:bg-indigo-500/40"
            disabled={publishSubmitting || draftRecipientIds.length === 0}
            onClick={() => void onPublish()}
         >
            {publishSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {fa.announcement.publishDraft}
         </Button>
      </section>
   );
}

function validatePollDraft(poll: AnnouncementPollDraftForm):
   | { valid: true; poll?: { question: string; options: string[]; allowMultiple: boolean } }
   | { valid: false; message: string } {
   if (!poll.enabled) return { valid: true };

   const question = poll.question.trim();
   if (!question) return { valid: false, message: fa.announcement.pollQuestionRequired };

   const options = poll.options.map((option) => option.trim()).filter(Boolean);
   if (options.length < MIN_POLL_OPTIONS) return { valid: false, message: fa.announcement.pollRequiresTwoOptions };

   const uniqueOptions = new Set(options.map((option) => option.toLocaleLowerCase()));
   if (uniqueOptions.size !== options.length) {
      return { valid: false, message: fa.announcement.pollDuplicateOption };
   }

   return {
      valid: true,
      poll: {
         question,
         options: options.slice(0, MAX_POLL_OPTIONS),
         allowMultiple: poll.allowMultiple,
      },
   };
}

function pollOptionPlaceholder(index: number): string {
   return fa.announcement.pollOptionPlaceholder.replace('{index}', (index + 1).toLocaleString('fa-IR'));
}

function pollVotesCountText(count: number): string {
   return fa.announcement.pollVotesCount.replace('{count}', count.toLocaleString('fa-IR'));
}

function statusLabel(status: string): string {
   if (status === 'PUBLISHED') return fa.announcement.published;
   if (status === 'ARCHIVED') return fa.announcement.archived;
   return fa.announcement.draft;
}

function announcementRecipientForUser(announcement: TaskaraAnnouncement | null | undefined, userId: string | null) {
   if (!announcement || !userId) return undefined;
   return announcement.recipients?.find((recipient) => recipient.userId === userId);
}

function isAnnouncementUnreadForUser(announcement: TaskaraAnnouncement, userId: string | null): boolean {
   const recipient = announcementRecipientForUser(announcement, userId);
   return Boolean(recipient && !recipient.readAt);
}

function summaryText(template: string, summary: SmsSendSummary): string {
   return template
      .replace('{sent}', summary.sent.toLocaleString('fa-IR'))
      .replace('{skipped}', summary.skippedNoPhone.toLocaleString('fa-IR'))
      .replace('{failed}', summary.failed.toLocaleString('fa-IR'));
}
