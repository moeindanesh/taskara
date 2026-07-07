'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
   ArrowRight,
   Check,
   CheckCircle2,
   Circle,
   ListChecks,
   Loader2,
   Megaphone,
   Plus,
   Search,
   Send,
   Users,
   X,
} from 'lucide-react';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
   CommunicationActionRailPanel,
   CommunicationCreateMenu,
   CommunicationDetailSkeleton,
   CommunicationEmptyState,
   CommunicationKindIcon,
   CommunicationListRow,
   CommunicationListSkeleton,
   type CommunicationFilter,
   type CommunicationKind,
   type CommunicationListItem,
} from '@/components/taskara/communications/primitives';
import { DescriptionEditor } from '@/components/taskara/description-editor';
import { LazyJalaliDatePicker } from '@/components/taskara/lazy-jalali-date-picker';
import { LinearAvatar, ProjectGlyph, StatusIcon } from '@/components/taskara/linear-ui';
import { SmsConfirmDialog } from '@/components/taskara/sms-confirm-dialog';
import { UserMultiSelectCombobox } from '@/components/taskara/user-multi-select-combobox';
import { formatJalaliDateTime } from '@/lib/jalali';
import { dispatchWorkspaceRefresh, useLiveRefresh, workspaceRefreshSourceMatches } from '@/lib/live-refresh';
import { EMPTY_SELECT_VALUE, fromSelectValue, toSelectValue } from '@/lib/select-utils';
import { taskaraRequest, uploadMedia } from '@/lib/taskara-client';
import type {
   AnnouncementsResponse,
   PaginatedResponse,
   SmsSendSummary,
   TaskaraAnnouncement,
   TaskaraMeeting,
   TaskaraMeetingActionItem,
   TaskaraMeetingActionItemListResponse,
   TaskaraProject,
   TaskaraTask,
   TaskaraUser,
} from '@/lib/taskara-types';
import { fa } from '@/lib/fa-copy';
import { useAuthSession } from '@/store/auth-store';
import { cn } from '@/lib/utils';

const MIN_POLL_OPTIONS = 2;
const MAX_POLL_OPTIONS = 12;
const communicationsRefreshOrigin = 'communications-view';

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

type MeetingForm = {
   title: string;
   description: string;
   projectId: string;
   ownerId: string;
   participantIds: string[];
   scheduledAt: string;
};

const emptyMeetingForm: MeetingForm = {
   title: '',
   description: '',
   projectId: '',
   ownerId: '',
   participantIds: [],
   scheduledAt: '',
};

function createEmptyAnnouncementForm(): AnnouncementForm {
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

export function CommunicationsView() {
   const navigate = useNavigate();
   const location = useLocation();
   const { orgId, announcementId, meetingId } = useParams();
   const { session } = useAuthSession();
   const workspaceSlug = orgId || 'taskara';
   const currentUserId = session?.user.id || null;
   const pathParts = location.pathname.split('/').filter(Boolean);
   const routeKey = pathParts[1] || 'communications';
   const routePreferredFilter = routeKey === 'announcements' ? 'announcements' : routeKey === 'meetings' ? 'meetings' : 'all';
   const selectedKind: CommunicationKind | null = announcementId ? 'announcement' : meetingId ? 'meeting' : null;
   const selectedId = announcementId || meetingId || null;

   const [announcements, setAnnouncements] = useState<TaskaraAnnouncement[]>([]);
   const [meetings, setMeetings] = useState<TaskaraMeeting[]>([]);
   const [users, setUsers] = useState<TaskaraUser[]>([]);
   const [projects, setProjects] = useState<TaskaraProject[]>([]);
   const [selectedAnnouncement, setSelectedAnnouncement] = useState<TaskaraAnnouncement | null>(null);
   const [selectedMeeting, setSelectedMeeting] = useState<TaskaraMeeting | null>(null);
   const [meetingActionItems, setMeetingActionItems] = useState<TaskaraMeetingActionItem[]>([]);
   const [actionItemsLoading, setActionItemsLoading] = useState(false);
   const [loading, setLoading] = useState(true);
   const [detailsLoading, setDetailsLoading] = useState(false);
   const [error, setError] = useState('');
   const [filter, setFilter] = useState<CommunicationFilter>(routePreferredFilter);
   const [query, setQuery] = useState('');
   const [createMenuOpen, setCreateMenuOpen] = useState(false);
   const [createKind, setCreateKind] = useState<CommunicationKind | null>(null);
   const [announcementForm, setAnnouncementForm] = useState<AnnouncementForm>(() => createEmptyAnnouncementForm());
   const [meetingForm, setMeetingForm] = useState<MeetingForm>(emptyMeetingForm);
   const [submittingAction, setSubmittingAction] = useState<'draft' | 'publish' | 'meeting' | null>(null);
   const [draftRecipientIds, setDraftRecipientIds] = useState<string[]>([]);
   const [publishSubmitting, setPublishSubmitting] = useState(false);
   const [smsSending, setSmsSending] = useState(false);
   const [smsConfirmOpen, setSmsConfirmOpen] = useState(false);
   const [pollSelection, setPollSelection] = useState<string[]>([]);
   const [pollVoting, setPollVoting] = useState(false);
   const [actionItemPendingId, setActionItemPendingId] = useState<string | null>(null);
   const loadRequestRef = useRef(0);
   const searchInputRef = useRef<HTMLInputElement | null>(null);
   const viewRef = useRef<HTMLDivElement | null>(null);

   const selectedRecipient = announcementRecipientForUser(selectedAnnouncement, currentUserId);
   const selectedAnnouncementIsRead = Boolean(selectedRecipient?.readAt);
   const selectedAnnouncementCanMarkRead = Boolean(selectedRecipient && !selectedRecipient.readAt);
   const selectedCanVotePoll = Boolean(selectedAnnouncement?.poll && selectedAnnouncement.status === 'PUBLISHED' && selectedRecipient);
   const selectedPollTotalVotes = (selectedAnnouncement?.poll?.options || []).reduce((sum, option) => sum + (option._count?.votes || 0), 0);

   const allItems = useMemo(
      () => buildCommunicationItems(announcements, meetings, currentUserId),
      [announcements, currentUserId, meetings]
   );
   const visibleItems = useMemo(
      () => filterCommunicationItems(allItems, filter, query, currentUserId),
      [allItems, currentUserId, filter, query]
   );
   const selectedItem = useMemo(
      () => allItems.find((item) => item.kind === selectedKind && item.id === selectedId) || null,
      [allItems, selectedId, selectedKind]
   );
   const unreadAnnouncementCount = useMemo(
      () => announcements.filter((announcement) => isAnnouncementUnreadForUser(announcement, currentUserId)).length,
      [announcements, currentUserId]
   );
   const myMeetingCount = useMemo(
      () => meetings.filter((meeting) => isMeetingForUser(meeting, currentUserId)).length,
      [currentUserId, meetings]
   );

   const load = useCallback(async () => {
      const requestId = ++loadRequestRef.current;
      setError('');
      try {
         const [announcementResult, meetingResult, userResult, projectResult] = await Promise.all([
            taskaraRequest<AnnouncementsResponse>('/announcements?limit=100'),
            taskaraRequest<PaginatedResponse<TaskaraMeeting>>('/meetings?limit=100'),
            taskaraRequest<PaginatedResponse<TaskaraUser>>('/users?limit=200'),
            taskaraRequest<TaskaraProject[]>('/projects'),
         ]);
         if (requestId !== loadRequestRef.current) return;
         setAnnouncements(announcementResult.items);
         setMeetings(meetingResult.items);
         setUsers(userResult.items);
         setProjects(projectResult);
      } catch (err) {
         if (requestId === loadRequestRef.current) {
            setError(err instanceof Error ? err.message : fa.communications.loadFailed);
         }
      } finally {
         if (requestId === loadRequestRef.current) setLoading(false);
      }
   }, []);

   useLiveRefresh(load, {
      ignoreWorkspaceEventOrigins: [communicationsRefreshOrigin],
      workspaceEventFilter: (detail) =>
         workspaceRefreshSourceMatches(detail, 'announcement') ||
         workspaceRefreshSourceMatches(detail, 'meeting') ||
         workspaceRefreshSourceMatches(detail, 'meeting_action_item'),
   });

   useEffect(() => {
      setFilter(routePreferredFilter);
   }, [routePreferredFilter]);

   useEffect(() => {
      if (!selectedKind || !selectedId || !visibleItems.length) return;
      if (visibleItems.some((item) => item.kind === selectedKind && item.id === selectedId)) return;
      navigate(communicationHref(workspaceSlug, visibleItems[0]), { replace: true });
   }, [filter, navigate, query, selectedId, selectedKind, visibleItems, workspaceSlug]);

   useEffect(() => {
      let canceled = false;

      async function loadSelected() {
         if (!selectedKind || !selectedId) {
            setSelectedAnnouncement(null);
            setSelectedMeeting(null);
            setMeetingActionItems([]);
            return;
         }

         setError('');
         setDetailsLoading(true);
         if (selectedKind === 'announcement') {
            setSelectedMeeting(null);
            setMeetingActionItems([]);
            const snapshot = selectedItem?.kind === 'announcement' ? selectedItem.source as TaskaraAnnouncement : null;
            setSelectedAnnouncement((current) => (current?.id === selectedId ? current : snapshot));
            try {
               const result = await taskaraRequest<TaskaraAnnouncement>(`/announcements/${encodeURIComponent(selectedId)}`);
               if (!canceled) {
                  setSelectedAnnouncement(result);
                  setAnnouncements((items) => mergeAnnouncementIntoList(items, result));
               }
            } catch (err) {
               if (!canceled) setError(err instanceof Error ? err.message : fa.announcement.loadFailed);
            } finally {
               if (!canceled) setDetailsLoading(false);
            }
            return;
         }

         setSelectedAnnouncement(null);
         const snapshot = selectedItem?.kind === 'meeting' ? selectedItem.source as TaskaraMeeting : null;
         setSelectedMeeting((current) => (current?.id === selectedId ? current : snapshot));
         setActionItemsLoading(true);
         try {
            const [meetingResult, actionItemResult] = await Promise.all([
               taskaraRequest<TaskaraMeeting>(`/meetings/${encodeURIComponent(selectedId)}`),
               taskaraRequest<TaskaraMeetingActionItemListResponse>(
                  `/meeting-action-items?meetingId=${encodeURIComponent(selectedId)}&status=ALL&limit=50`
               ).catch(() => ({ items: [], total: 0, limit: 50, offset: 0 })),
            ]);
            if (!canceled) {
               setSelectedMeeting(meetingResult);
               setMeetings((items) => mergeMeetingIntoList(items, meetingResult));
               setMeetingActionItems(actionItemResult.items);
            }
         } catch (err) {
            if (!canceled) setError(err instanceof Error ? err.message : fa.meeting.loadFailed);
         } finally {
            if (!canceled) {
               setDetailsLoading(false);
               setActionItemsLoading(false);
            }
         }
      }

      void loadSelected();
      return () => {
         canceled = true;
      };
   }, [selectedId, selectedKind]);

   useEffect(() => {
      setDraftRecipientIds((selectedAnnouncement?.recipients || []).map((recipient) => recipient.userId));
   }, [selectedAnnouncement?.id, selectedAnnouncement?.recipients]);

   useEffect(() => {
      setPollSelection(selectedAnnouncement?.pollVoteOptionIds || []);
   }, [selectedAnnouncement?.id, selectedAnnouncement?.pollVoteOptionIds]);

   useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
         if (event.defaultPrevented || !viewRef.current) return;
         if (isEditableTarget(event.target)) return;
         const key = event.key.toLocaleLowerCase('fa');

         if (key === '/') {
            event.preventDefault();
            searchInputRef.current?.focus();
            return;
         }

         if (key === 'n' || key === 'د') {
            event.preventDefault();
            setCreateMenuOpen(true);
            return;
         }

         if (event.key === 'Enter') {
            if (!visibleItems.length) return;
            event.preventDefault();
            const current = selectedKind && selectedId
               ? visibleItems.find((item) => item.kind === selectedKind && item.id === selectedId)
               : null;
            navigate(communicationHref(workspaceSlug, current || visibleItems[0]));
            return;
         }

         if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
         if (!visibleItems.length) return;
         event.preventDefault();
         const currentIndex = selectedKind && selectedId
            ? visibleItems.findIndex((item) => item.kind === selectedKind && item.id === selectedId)
            : -1;
         const direction = event.key === 'ArrowDown' ? 1 : -1;
         const nextIndex = currentIndex < 0
            ? 0
            : Math.min(visibleItems.length - 1, Math.max(0, currentIndex + direction));
         const next = visibleItems[nextIndex];
         if (next) navigate(communicationHref(workspaceSlug, next));
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
   }, [navigate, selectedId, selectedKind, visibleItems, workspaceSlug]);

   const uploadInlineMeetingAssets = useCallback(async (files: File[]) => {
      if (!files.length) return [];
      return await Promise.all(files.map((file) => uploadMedia(file, file.name)));
   }, []);

   const uploadInlineMeetingImages = useCallback(
      async (files: File[]) => {
         const uploaded = await uploadInlineMeetingAssets(files);
         return uploaded.map((asset) => ({
            altText: asset.name,
            src: asset.url,
         }));
      },
      [uploadInlineMeetingAssets]
   );

   const uploadInlineMeetingFiles = useCallback(
      async (files: File[]) => {
         const uploaded = await uploadInlineMeetingAssets(files);
         return uploaded.map((asset) => ({
            kind:
               (asset.mimeType || '').toLowerCase().startsWith('audio/') ||
               (asset.mimeType || '').toLowerCase().startsWith('video/')
                  ? ('media' as const)
                  : ('file' as const),
            mimeType: asset.mimeType,
            name: asset.name,
            sizeBytes: asset.sizeBytes,
            src: asset.url,
         }));
      },
      [uploadInlineMeetingAssets]
   );

   function openCreate(kind: CommunicationKind) {
      setCreateMenuOpen(false);
      setCreateKind(kind);
   }

   async function createNewAnnouncement(publish: boolean) {
      if (!announcementForm.title.trim() || (publish && !announcementForm.recipientIds.length)) return;
      const pollValidation = validatePollDraft(announcementForm.poll);
      if (!pollValidation.valid) {
         toast.error(pollValidation.message || fa.announcement.createFailed);
         return;
      }
      setSubmittingAction(publish ? 'publish' : 'draft');
      try {
         const created = await taskaraRequest<TaskaraAnnouncement>('/announcements', {
            method: 'POST',
            body: JSON.stringify({
               title: announcementForm.title,
               body: announcementForm.body,
               recipientIds: announcementForm.recipientIds,
               poll: pollValidation.poll,
               publish,
            }),
         });
         setCreateKind(null);
         setAnnouncementForm(createEmptyAnnouncementForm());
         await load();
         navigate(communicationHref(workspaceSlug, { kind: 'announcement', id: created.id } as CommunicationListItem));
         dispatchWorkspaceRefresh({ source: 'announcement:create', origin: communicationsRefreshOrigin });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.announcement.createFailed);
      } finally {
         setSubmittingAction(null);
      }
   }

   async function createNewMeeting() {
      if (!meetingForm.title.trim()) return;
      setSubmittingAction('meeting');
      try {
         const created = await taskaraRequest<TaskaraMeeting>('/meetings', {
            method: 'POST',
            body: JSON.stringify({
               title: meetingForm.title,
               description: meetingForm.description || undefined,
               projectId: meetingForm.projectId || undefined,
               ownerId: meetingForm.ownerId || undefined,
               participantIds: meetingForm.participantIds,
               scheduledAt: meetingForm.scheduledAt || undefined,
            }),
         });
         setCreateKind(null);
         setMeetingForm(emptyMeetingForm);
         await load();
         navigate(communicationHref(workspaceSlug, { kind: 'meeting', id: created.id } as CommunicationListItem));
         dispatchWorkspaceRefresh({ source: 'meeting:create', origin: communicationsRefreshOrigin });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.meeting.createFailed);
      } finally {
         setSubmittingAction(null);
      }
   }

   async function markAnnouncementRead() {
      if (!selectedAnnouncement || !selectedAnnouncementCanMarkRead) return;
      try {
         const updated = await taskaraRequest<TaskaraAnnouncement>(`/announcements/${encodeURIComponent(selectedAnnouncement.id)}/read`, {
            method: 'PATCH',
         });
         setSelectedAnnouncement(updated);
         setAnnouncements((items) => mergeAnnouncementIntoList(items, updated));
         dispatchWorkspaceRefresh({ source: 'announcement:read', origin: communicationsRefreshOrigin });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.announcement.updateFailed);
      }
   }

   async function publishDraft() {
      if (!selectedAnnouncement || selectedAnnouncement.status !== 'DRAFT' || draftRecipientIds.length === 0) return;
      setPublishSubmitting(true);
      try {
         const updated = await taskaraRequest<TaskaraAnnouncement>(`/announcements/${encodeURIComponent(selectedAnnouncement.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({
               recipientIds: draftRecipientIds,
               status: 'PUBLISHED',
            }),
         });
         setSelectedAnnouncement(updated);
         setAnnouncements((items) => mergeAnnouncementIntoList(items, updated));
         toast.success(fa.announcement.publishedToast);
         dispatchWorkspaceRefresh({ source: 'announcement:publish', origin: communicationsRefreshOrigin });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.announcement.updateFailed);
      } finally {
         setPublishSubmitting(false);
      }
   }

   async function sendSms() {
      const selected = selectedKind === 'announcement' ? selectedAnnouncement : selectedMeeting;
      if (!selected || !selectedKind) return;
      setSmsSending(true);
      try {
         const path = selectedKind === 'announcement'
            ? `/announcements/${encodeURIComponent(selected.id)}/sms`
            : `/meetings/${encodeURIComponent(selected.id)}/sms`;
         const template = selectedKind === 'announcement' ? fa.announcement.smsSummary : fa.meeting.smsSummary;
         const result = await taskaraRequest<SmsSendSummary>(path, { method: 'POST' });
         toast.success(summaryText(template, result));
      } catch (err) {
         toast.error(err instanceof Error ? err.message : selectedKind === 'announcement' ? fa.announcement.smsFailed : fa.meeting.smsFailed);
      } finally {
         setSmsSending(false);
      }
   }

   function requestSmsSend() {
      if (smsSending || (!selectedAnnouncement && !selectedMeeting)) return;
      setSmsConfirmOpen(true);
   }

   function confirmSmsSend() {
      setSmsConfirmOpen(false);
      void sendSms();
   }

   function toggleCreatePoll(enabled: boolean) {
      setAnnouncementForm((current) => {
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
      setAnnouncementForm((current) => ({
         ...current,
         poll: {
            ...current.poll,
            options: current.poll.options.map((option, optionIndex) => (optionIndex === index ? value : option)),
         },
      }));
   }

   function addPollOption() {
      setAnnouncementForm((current) => {
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
      setAnnouncementForm((current) => {
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
      if (!selectedAnnouncement?.poll) return;
      if (!selectedAnnouncement.poll.allowMultiple) {
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
      if (!selectedAnnouncement?.poll || !pollSelection.length || !selectedCanVotePoll) return;
      setPollVoting(true);
      try {
         const updated = await taskaraRequest<TaskaraAnnouncement>(`/announcements/${encodeURIComponent(selectedAnnouncement.id)}/poll-vote`, {
            method: 'PUT',
            body: JSON.stringify({ optionIds: pollSelection }),
         });
         setSelectedAnnouncement(updated);
         setAnnouncements((items) => mergeAnnouncementIntoList(items, updated));
         setPollSelection(updated.pollVoteOptionIds || []);
         toast.success(fa.announcement.pollVoteSaved);
         dispatchWorkspaceRefresh({ source: 'announcement:poll-vote', origin: communicationsRefreshOrigin });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.announcement.pollVoteFailed);
      } finally {
         setPollVoting(false);
      }
   }

   async function createTaskFromActionItem(actionItem: TaskaraMeetingActionItem) {
      if (!selectedMeeting) return;
      setActionItemPendingId(actionItem.id);
      try {
         const result = await taskaraRequest<{ actionItem: TaskaraMeetingActionItem; task: TaskaraTask }>(
            `/meeting-action-items/${encodeURIComponent(actionItem.id)}/create-task`,
            {
               method: 'POST',
               body: JSON.stringify({
                  projectId: selectedMeeting.project?.id || undefined,
                  assigneeId: actionItem.assigneeId || undefined,
                  dueAt: actionItem.dueAt || undefined,
               }),
            }
         );
         setMeetingActionItems((items) => items.map((item) => (item.id === result.actionItem.id ? result.actionItem : item)));
         toast.success(fa.cockpit.actionItemTaskCreated(result.task.key));
         dispatchWorkspaceRefresh({ source: 'meeting_action_item:create_task', origin: communicationsRefreshOrigin });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.meeting.taskCreateFailed);
      } finally {
         setActionItemPendingId(null);
      }
   }

   const currentTitle = selectedAnnouncement?.title || selectedMeeting?.title || selectedItem?.title || '';
   const currentKind = selectedAnnouncement ? 'announcement' : selectedMeeting ? 'meeting' : selectedKind;

   return (
      <div ref={viewRef} className="grid h-full min-h-0 grid-cols-1 overflow-hidden bg-[#101011] text-zinc-200 lg:grid-cols-[360px_minmax(0,1fr)] xl:grid-cols-[390px_minmax(0,1fr)_320px]">
         <section className={cn('min-h-0 flex-col border-b border-white/8 lg:flex lg:border-b-0 lg:border-e', selectedId ? 'hidden lg:flex' : 'flex')}>
            <div className="shrink-0 border-b border-white/8 px-4 py-3">
               <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                     <Megaphone className="size-4 shrink-0 text-zinc-500" />
                     <h1 className="truncate text-sm font-semibold text-zinc-100">{fa.nav.communications}</h1>
                     {unreadAnnouncementCount > 0 ? (
                        <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 text-[11px] text-indigo-200">
                           {unreadAnnouncementCount.toLocaleString('fa-IR')}
                        </span>
                     ) : null}
                     {myMeetingCount > 0 ? (
                        <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] text-emerald-200">
                           {myMeetingCount.toLocaleString('fa-IR')}
                        </span>
                     ) : null}
                  </div>
                  <CommunicationCreateMenu
                     open={createMenuOpen}
                     onCreateAnnouncement={() => openCreate('announcement')}
                     onCreateMeeting={() => openCreate('meeting')}
                     onOpenChange={setCreateMenuOpen}
                  />
               </div>
               <div className="relative">
                  <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-zinc-600" />
                  <Input
                     ref={searchInputRef}
                     className="h-9 rounded-lg border-white/8 bg-white/[0.035] ps-9 text-sm text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-indigo-400/50"
                     placeholder={fa.communications.searchPlaceholder}
                     value={query}
                     onChange={(event) => setQuery(event.target.value)}
                  />
               </div>
               <div className="mt-3 flex gap-1 overflow-x-auto pb-1">
                  {communicationFilters.map((item) => (
                     <button
                        key={item.value}
                        className={cn(
                           'h-7 shrink-0 rounded-full border px-3 text-xs transition',
                           filter === item.value
                              ? 'border-white/12 bg-white/10 text-zinc-100'
                              : 'border-white/7 bg-transparent text-zinc-500 hover:bg-white/[0.045] hover:text-zinc-300'
                        )}
                        type="button"
                        onClick={() => setFilter(item.value)}
                     >
                        {item.label}
                     </button>
                  ))}
               </div>
            </div>
            {error ? <div className="m-3 rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-2 text-xs leading-5 text-red-200">{error}</div> : null}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
               {loading ? (
                  <CommunicationListSkeleton />
               ) : visibleItems.length === 0 ? (
                  <CommunicationEmptyState actionLabel={fa.communications.createPrimary} onAction={() => setCreateMenuOpen(true)}>
                     {query ? fa.communications.noSearchResults : fa.communications.noItems}
                  </CommunicationEmptyState>
               ) : (
                  <div className="space-y-1">
                     {visibleItems.map((item) => (
                        <CommunicationListRow
                           key={`${item.kind}-${item.id}`}
                           active={selectedKind === item.kind && selectedId === item.id}
                           item={item}
                           onSelect={() => navigate(communicationHref(workspaceSlug, item))}
                        />
                     ))}
                  </div>
               )}
            </div>
         </section>

         <main className={cn('min-h-0 overflow-y-auto', selectedId ? 'block' : 'hidden lg:block')}>
            {selectedKind && selectedId && !selectedAnnouncement && !selectedMeeting && !selectedItem ? (
               <CommunicationDetailSkeleton />
            ) : currentKind && (selectedAnnouncement || selectedMeeting || selectedItem) ? (
               <div className="mx-auto flex min-h-full w-full max-w-[900px] flex-col px-5 py-5 lg:px-8">
                  <div className="mb-7 flex items-center justify-between gap-3">
                     <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-500">
                        <Button
                           size="icon"
                           variant="ghost"
                           className="size-8 rounded-full text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100 lg:hidden"
                           onClick={() => navigate(`/${workspaceSlug}/communications`)}
                        >
                           <ArrowRight className="size-4" />
                        </Button>
                        <CommunicationKindIcon kind={currentKind} className="size-4 shrink-0 text-zinc-500" />
                        <span>{selectedAnnouncement ? announcementStatusLabel(selectedAnnouncement.status) : selectedMeeting ? meetingStatusLabel(selectedMeeting.status) : selectedItem?.status}</span>
                        <span className="h-1 w-1 rounded-full bg-zinc-700" />
                        <span>{detailDateLabel(selectedAnnouncement, selectedMeeting, selectedItem)}</span>
                        {detailsLoading ? <Loader2 className="size-4 animate-spin" /> : null}
                     </div>
                     <div className="flex shrink-0 items-center gap-1.5">
                        {selectedAnnouncement?.status === 'DRAFT' ? (
                           <Button
                              size="sm"
                              className="h-8 gap-2 rounded-full bg-indigo-500 px-4 text-sm font-normal text-white hover:bg-indigo-400 disabled:bg-indigo-500/40"
                              disabled={publishSubmitting || draftRecipientIds.length === 0}
                              onClick={() => void publishDraft()}
                           >
                              {publishSubmitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                              {fa.announcement.publishDraft}
                           </Button>
                        ) : selectedAnnouncement ? (
                           <>
                              <Button
                                 size="sm"
                                 variant="ghost"
                                 className="h-8 gap-2 rounded-full text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 disabled:text-zinc-600"
                                 disabled={!selectedAnnouncementCanMarkRead}
                                 onClick={() => void markAnnouncementRead()}
                              >
                                 <Check className="size-4" />
                                 {selectedAnnouncementIsRead ? fa.announcement.read : fa.announcement.markRead}
                              </Button>
                              <Button size="sm" variant="ghost" className="h-8 gap-2 rounded-full text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100" disabled={smsSending} onClick={requestSmsSend}>
                                 {smsSending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                                 {fa.communications.sms}
                              </Button>
                           </>
                        ) : selectedMeeting ? (
                           <Button size="sm" variant="ghost" className="h-8 gap-2 rounded-full text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100" disabled={smsSending} onClick={requestSmsSend}>
                              {smsSending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                              {fa.communications.sms}
                           </Button>
                        ) : null}
                     </div>
                  </div>

                  <h2 className="mb-3 break-words text-2xl font-semibold leading-9 text-zinc-50">{currentTitle}</h2>
                  {selectedMeeting ? (
                     <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                        {selectedMeeting.project ? (
                           <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-white/8 bg-white/[0.035] px-2.5 py-1">
                              <ProjectGlyph name={selectedMeeting.project.name} className="size-4 rounded" iconClassName="size-3" />
                              <span className="truncate">{selectedMeeting.project.name}</span>
                           </span>
                        ) : null}
                        {selectedMeeting.owner ? (
                           <span className="inline-flex items-center gap-1.5 rounded-full border border-white/8 bg-white/[0.035] px-2.5 py-1">
                              <LinearAvatar name={selectedMeeting.owner.name} src={selectedMeeting.owner.avatarUrl} className="size-4" />
                              {fa.communications.ownerLine(selectedMeeting.owner.name)}
                           </span>
                        ) : null}
                     </div>
                  ) : null}

                  {selectedAnnouncement ? (
                     <AnnouncementDetail
                        announcement={selectedAnnouncement}
                        pollSelection={pollSelection}
                        pollTotalVotes={selectedPollTotalVotes}
                        pollVoting={pollVoting}
                        selectedCanVotePoll={selectedCanVotePoll}
                        onPollOptionToggle={togglePollSelection}
                        onPollVote={submitPollVote}
                     />
                  ) : selectedMeeting ? (
                     <MeetingDetail
                        actionItems={meetingActionItems}
                        actionItemsLoading={actionItemsLoading}
                        actionItemPendingId={actionItemPendingId}
                        meeting={selectedMeeting}
                        onCreateTaskFromActionItem={createTaskFromActionItem}
                     />
                  ) : (
                     <section className="min-h-[140px] border-b border-white/8 pb-8">
                        <p className="text-sm text-zinc-600">{fa.app.loading}</p>
                     </section>
                  )}

                  {selectedAnnouncement?.status === 'DRAFT' ? (
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
               <div className="flex h-full items-center justify-center px-6 text-center text-sm text-zinc-500">{fa.communications.selectItem}</div>
            )}
         </main>

         <aside className="hidden min-h-0 overflow-y-auto border-s border-white/8 p-3 xl:block">
            <div className="space-y-3">
               <CommunicationActionRailPanel title={fa.meeting.status}>
                  <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-300">
                     <span>{selectedAnnouncement ? announcementStatusLabel(selectedAnnouncement.status) : selectedMeeting ? meetingStatusLabel(selectedMeeting.status) : fa.app.unset}</span>
                     <span className="h-1 w-1 rounded-full bg-zinc-700" />
                     <span>{detailDateLabel(selectedAnnouncement, selectedMeeting, selectedItem)}</span>
                     {detailsLoading ? <Loader2 className="size-4 animate-spin text-zinc-500" /> : null}
                  </div>
               </CommunicationActionRailPanel>
               <CommunicationActionRailPanel title={fa.communications.actions}>
                  {selectedAnnouncement?.status === 'DRAFT' ? (
                     <DraftPublishControls
                        className="border-0 bg-transparent p-0"
                        draftRecipientIds={draftRecipientIds}
                        publishSubmitting={publishSubmitting}
                        users={users}
                        onPublish={publishDraft}
                        onRecipientsChange={setDraftRecipientIds}
                     />
                  ) : (
                     <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 w-full gap-2 rounded-full text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100"
                        disabled={(!selectedAnnouncement && !selectedMeeting) || smsSending}
                        onClick={requestSmsSend}
                     >
                        {smsSending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                        {fa.communications.sms}
                     </Button>
                  )}
               </CommunicationActionRailPanel>
               {selectedAnnouncement ? (
                  <CommunicationActionRailPanel title={fa.announcement.recipients}>
                     {(selectedAnnouncement.recipients || []).map((recipient) => (
                        <div key={recipient.id} className="flex min-w-0 items-center justify-between gap-3">
                           <span className="flex min-w-0 items-center gap-2">
                              <LinearAvatar name={recipient.user.name} src={recipient.user.avatarUrl} className="size-6" />
                              <span className="truncate text-sm text-zinc-300">{recipient.user.name}</span>
                           </span>
                           <span className={cn('shrink-0 text-[11px]', recipient.readAt ? 'text-zinc-500' : 'text-indigo-300')}>
                              {recipient.readAt ? formatJalaliDateTime(recipient.readAt) : fa.announcement.unread}
                           </span>
                        </div>
                     ))}
                  </CommunicationActionRailPanel>
               ) : null}
               {selectedMeeting ? (
                  <>
                     <CommunicationActionRailPanel title={fa.meeting.participants}>
                        {(selectedMeeting.participants || []).map((participant) => (
                           <div key={participant.id} className="flex min-w-0 items-center justify-between gap-3">
                              <span className="flex min-w-0 items-center gap-2">
                                 <LinearAvatar name={participant.user.name} src={participant.user.avatarUrl} className="size-6" />
                                 <span className="truncate text-sm text-zinc-300">{participant.user.name}</span>
                              </span>
                              <span className="shrink-0 text-[11px] text-zinc-500">{participant.role === 'OWNER' ? fa.meeting.owner : ''}</span>
                           </div>
                        ))}
                     </CommunicationActionRailPanel>
                     <CommunicationActionRailPanel title={fa.meeting.project}>
                        <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-300">
                           {selectedMeeting.project ? (
                              <>
                                 <ProjectGlyph name={selectedMeeting.project.name} className="size-5 rounded" iconClassName="size-3.5" />
                                 <span className="truncate">{selectedMeeting.project.name}</span>
                              </>
                           ) : (
                              <span>{fa.app.unset}</span>
                           )}
                        </div>
                     </CommunicationActionRailPanel>
                  </>
               ) : null}
            </div>
         </aside>

         <AnnouncementCreateDialog
            form={announcementForm}
            open={createKind === 'announcement'}
            submittingAction={submittingAction}
            users={users}
            onAddPollOption={addPollOption}
            onCreate={createNewAnnouncement}
            onFormChange={setAnnouncementForm}
            onOpenChange={(open) => {
               setCreateKind(open ? 'announcement' : null);
               if (!open) setAnnouncementForm(createEmptyAnnouncementForm());
            }}
            onPollEnabledChange={toggleCreatePoll}
            onPollOptionChange={updatePollOption}
            onRemovePollOption={removePollOption}
         />
         <MeetingCreateDialog
            form={meetingForm}
            open={createKind === 'meeting'}
            projects={projects}
            submitting={submittingAction === 'meeting'}
            uploadInlineFiles={uploadInlineMeetingFiles}
            uploadInlineImages={uploadInlineMeetingImages}
            users={users}
            onCreate={createNewMeeting}
            onFormChange={setMeetingForm}
            onOpenChange={(open) => {
               setCreateKind(open ? 'meeting' : null);
               if (!open) setMeetingForm(emptyMeetingForm);
            }}
         />
         <SmsConfirmDialog
            confirmLabel={fa.app.confirm}
            description={fa.app.smsConfirmDescription}
            open={smsConfirmOpen}
            pending={smsSending}
            title={selectedKind === 'meeting' ? fa.meeting.sendSms : fa.announcement.sendSms}
            onConfirm={confirmSmsSend}
            onOpenChange={setSmsConfirmOpen}
         />
      </div>
   );
}

function AnnouncementDetail({
   announcement,
   pollSelection,
   pollTotalVotes,
   pollVoting,
   selectedCanVotePoll,
   onPollOptionToggle,
   onPollVote,
}: {
   announcement: TaskaraAnnouncement;
   pollSelection: string[];
   pollTotalVotes: number;
   pollVoting: boolean;
   selectedCanVotePoll: boolean;
   onPollOptionToggle: (optionId: string) => void;
   onPollVote: () => Promise<void>;
}) {
   return (
      <>
         <section className="min-h-[140px] border-b border-white/8 pb-8">
            {announcement.body ? (
               <ReadableContent>{announcement.body}</ReadableContent>
            ) : (
               <p className="text-sm text-zinc-600">{fa.inbox.noDescription}</p>
            )}
         </section>
         {announcement.poll ? (
            <section className="mt-6 space-y-4 rounded-lg border border-white/8 bg-[#18181a] p-4">
               <div className="flex items-start gap-3">
                  <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-zinc-400">
                     <ListChecks className="size-4" />
                  </span>
                  <div className="min-w-0">
                     <p className="text-sm font-semibold text-zinc-100">{announcement.poll.question}</p>
                     <p className="mt-1 text-xs text-zinc-500">
                        {announcement.poll.allowMultiple ? fa.announcement.pollAllowMultiple : fa.announcement.pollVote}
                     </p>
                  </div>
               </div>
               <div className="space-y-2">
                  {announcement.poll.options.map((option) => {
                     const voteCount = option._count?.votes || 0;
                     const votePercent = pollTotalVotes > 0 ? Math.round((voteCount / pollTotalVotes) * 100) : 0;
                     const isDraftSelected = pollSelection.includes(option.id);
                     const isSavedVote = (announcement.pollVoteOptionIds || []).includes(option.id);
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
                           onClick={() => onPollOptionToggle(option.id)}
                        >
                           <div className="flex items-center justify-between gap-3">
                              <span className="truncate text-sm text-zinc-200">{option.label}</span>
                              <span className="shrink-0 text-[11px] text-zinc-500">{pollVotesCountText(voteCount)}</span>
                           </div>
                           <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8">
                              <div className="h-full rounded-full bg-indigo-400/70 transition-all" style={{ width: `${votePercent}%` }} />
                           </div>
                           {isSavedVote ? <p className="mt-1 text-[11px] text-indigo-200">{fa.announcement.pollYourVote}</p> : null}
                        </button>
                     );
                  })}
               </div>
               {selectedCanVotePoll ? (
                  <Button
                     className="h-8 rounded-full bg-indigo-500 px-4 text-sm font-normal text-white hover:bg-indigo-400 disabled:bg-indigo-500/40"
                     disabled={pollVoting || pollSelection.length === 0}
                     onClick={() => void onPollVote()}
                  >
                     {pollVoting ? <Loader2 className="size-4 animate-spin" /> : null}
                     {pollVoting ? fa.announcement.pollVoting : fa.announcement.pollVote}
                  </Button>
               ) : null}
            </section>
         ) : null}
      </>
   );
}

function MeetingDetail({
   actionItems,
   actionItemsLoading,
   actionItemPendingId,
   meeting,
   onCreateTaskFromActionItem,
}: {
   actionItems: TaskaraMeetingActionItem[];
   actionItemsLoading: boolean;
   actionItemPendingId: string | null;
   meeting: TaskaraMeeting;
   onCreateTaskFromActionItem: (actionItem: TaskaraMeetingActionItem) => Promise<void>;
}) {
   const description = descriptionText(meeting.description);
   const openActionItems = actionItems.filter((item) => item.status === 'OPEN');

   return (
      <>
         <section className="min-h-[140px] border-b border-white/8 pb-8">
            {description ? (
               <ReadableContent>{description}</ReadableContent>
            ) : (
               <p className="text-sm text-zinc-600">{fa.meeting.descriptionPlaceholder}</p>
            )}
         </section>
         <section className="mt-6 space-y-4">
            <div className="flex items-center justify-between gap-3">
               <h3 className="text-base font-semibold text-zinc-100">{fa.meeting.actionItems}</h3>
               {actionItemsLoading ? <Loader2 className="size-4 animate-spin text-zinc-500" /> : null}
            </div>
            {openActionItems.length ? (
               <div className="space-y-2">
                  {openActionItems.map((item) => (
                     <div key={item.id} className="rounded-lg border border-white/8 bg-white/[0.025] px-3 py-3">
                        <div className="flex min-w-0 items-start justify-between gap-3">
                           <div className="min-w-0">
                              <div className="flex min-w-0 items-center gap-2">
                                 {item.task ? <CheckCircle2 className="size-4 shrink-0 text-emerald-300" /> : <Circle className="size-4 shrink-0 text-zinc-500" />}
                                 <p className="truncate text-sm font-medium text-zinc-200">{item.title}</p>
                              </div>
                              {item.notes ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">{item.notes}</p> : null}
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-600">
                                 {item.assignee ? (
                                    <span className="inline-flex items-center gap-1">
                                       <LinearAvatar name={item.assignee.name} src={item.assignee.avatarUrl} className="size-4" />
                                       {item.assignee.name}
                                    </span>
                                 ) : null}
                                 {item.dueAt ? <span>{formatJalaliDateTime(item.dueAt)}</span> : null}
                                 {item.task ? <span>{item.task.key}</span> : null}
                              </div>
                           </div>
                           {!item.task ? (
                              <Button
                                 size="sm"
                                 variant="ghost"
                                 className="h-8 shrink-0 rounded-full px-3 text-xs text-zinc-300 hover:bg-white/8 hover:text-zinc-100"
                                 disabled={actionItemPendingId === item.id}
                                 onClick={() => void onCreateTaskFromActionItem(item)}
                              >
                                 {actionItemPendingId === item.id ? <Loader2 className="size-3.5 animate-spin" /> : <ListChecks className="size-3.5" />}
                                 {fa.cockpit.createLinkedTask}
                              </Button>
                           ) : null}
                        </div>
                     </div>
                  ))}
               </div>
            ) : actionItemsLoading ? null : (
               <div className="rounded-lg border border-white/8 bg-white/[0.02] px-3 py-4 text-sm text-zinc-500">{fa.cockpit.noOpenActionItems}</div>
            )}
         </section>
         {(meeting.tasks || []).length ? (
            <section className="mt-6 space-y-3">
               <h3 className="text-base font-semibold text-zinc-100">{fa.communications.linkedTasks}</h3>
               <div className="space-y-2">
                  {(meeting.tasks || []).slice(0, 10).map((link) => (
                     <div key={`${link.meetingId}-${link.taskId}`} className="flex min-w-0 items-center gap-3 rounded-lg border border-white/8 bg-white/[0.025] px-3 py-2 text-sm text-zinc-300">
                        <StatusIcon status={link.task.status} />
                        <span className="min-w-0 flex-1 truncate">{link.task.title}</span>
                        <span className="shrink-0 text-xs text-zinc-500">{link.task.key}</span>
                     </div>
                  ))}
               </div>
            </section>
         ) : null}
      </>
   );
}

function AnnouncementCreateDialog({
   form,
   open,
   submittingAction,
   users,
   onAddPollOption,
   onCreate,
   onFormChange,
   onOpenChange,
   onPollEnabledChange,
   onPollOptionChange,
   onRemovePollOption,
}: {
   form: AnnouncementForm;
   open: boolean;
   submittingAction: 'draft' | 'publish' | 'meeting' | null;
   users: TaskaraUser[];
   onAddPollOption: () => void;
   onCreate: (publish: boolean) => Promise<void>;
   onFormChange: React.Dispatch<React.SetStateAction<AnnouncementForm>>;
   onOpenChange: (open: boolean) => void;
   onPollEnabledChange: (enabled: boolean) => void;
   onPollOptionChange: (index: number, value: string) => void;
   onRemovePollOption: (index: number) => void;
}) {
   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
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
                     {fa.communications.announcementType}
                  </span>
                  <span>{fa.announcement.newAnnouncement}</span>
               </DialogTitle>
               <DialogDescription className="sr-only">{fa.pages.communicationsDescription}</DialogDescription>
            </DialogHeader>
            <form
               className="flex min-h-0 flex-1 flex-col"
               onSubmit={(event) => {
                  event.preventDefault();
                  void onCreate(form.recipientIds.length > 0);
               }}
            >
               <div className="flex min-h-[246px] flex-1 flex-col px-5 pt-7">
                  <Input
                     autoFocus
                     className="h-auto border-none bg-transparent px-0 text-xl leading-7 font-semibold text-zinc-100 shadow-none outline-none placeholder:text-zinc-600 focus-visible:ring-0"
                     placeholder={fa.announcement.titlePlaceholder}
                     value={form.title}
                     onChange={(event) => onFormChange((current) => ({ ...current, title: event.target.value }))}
                  />
                  <Textarea
                     className="mt-2 min-h-28 resize-none border-none bg-transparent px-0 text-right text-sm leading-6 text-zinc-300 shadow-none outline-none placeholder:text-zinc-600 focus-visible:ring-0"
                     placeholder={fa.announcement.bodyPlaceholder}
                     value={form.body}
                     onChange={(event) => onFormChange((current) => ({ ...current, body: event.target.value }))}
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
                              onCheckedChange={onPollEnabledChange}
                           />
                        </div>
                        {form.poll.enabled ? (
                           <div className="space-y-2">
                              <Input
                                 className="h-9 border-white/10 bg-[#202024] text-sm text-zinc-200 placeholder:text-zinc-500 focus-visible:ring-indigo-400/50"
                                 placeholder={fa.announcement.pollQuestionPlaceholder}
                                 value={form.poll.question}
                                 onChange={(event) =>
                                    onFormChange((current) => ({
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
                                       onChange={(event) => onPollOptionChange(index, event.target.value)}
                                    />
                                    <Button
                                       size="icon"
                                       type="button"
                                       variant="ghost"
                                       className="size-8 shrink-0 rounded-full text-zinc-400 hover:bg-white/8 hover:text-zinc-200 disabled:text-zinc-700"
                                       disabled={form.poll.options.length <= MIN_POLL_OPTIONS}
                                       onClick={() => onRemovePollOption(index)}
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
                                    onClick={onAddPollOption}
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
                                          onFormChange((current) => ({
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
                        onChange={(recipientIds) => onFormChange((current) => ({ ...current, recipientIds }))}
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
                        onClick={() => void onCreate(false)}
                     >
                        {submittingAction === 'draft' ? <Loader2 className="size-4 animate-spin" /> : null}
                        {fa.announcement.saveDraft}
                     </Button>
                     <Button
                        type="button"
                        className="h-8 rounded-full bg-indigo-500 px-4 text-sm font-normal text-white hover:bg-indigo-400 disabled:bg-indigo-500/40"
                        disabled={Boolean(submittingAction) || !form.title.trim() || !form.recipientIds.length}
                        onClick={() => void onCreate(true)}
                     >
                        {submittingAction === 'publish' ? <Loader2 className="size-4 animate-spin" /> : null}
                        {fa.announcement.publish}
                     </Button>
                  </div>
               </DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}

function MeetingCreateDialog({
   form,
   open,
   projects,
   submitting,
   uploadInlineFiles,
   uploadInlineImages,
   users,
   onCreate,
   onFormChange,
   onOpenChange,
}: {
   form: MeetingForm;
   open: boolean;
   projects: TaskaraProject[];
   submitting: boolean;
   uploadInlineFiles: (files: File[]) => Promise<Array<{ kind: 'file' | 'media'; mimeType?: string; name: string; sizeBytes: number; src: string }>>;
   uploadInlineImages: (files: File[]) => Promise<Array<{ altText: string; src: string }>>;
   users: TaskaraUser[];
   onCreate: () => Promise<void>;
   onFormChange: React.Dispatch<React.SetStateAction<MeetingForm>>;
   onOpenChange: (open: boolean) => void;
}) {
   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent
            aria-label={fa.meeting.newMeeting}
            showCloseButton={false}
            className="flex max-h-[calc(100svh-32px)] max-w-[760px] flex-col gap-0 overflow-visible rounded-[18px] border-white/10 bg-[#1d1d20] p-0 text-zinc-100 shadow-[0_18px_70px_rgb(0_0_0/0.55)] sm:max-w-[760px]"
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
                     <Users className="size-3.5 text-zinc-500" />
                     {fa.nav.meetings}
                  </span>
                  <span>{fa.meeting.newMeeting}</span>
               </DialogTitle>
               <DialogDescription className="sr-only">{fa.pages.communicationsDescription}</DialogDescription>
            </DialogHeader>
            <form
               className="flex min-h-0 flex-1 flex-col"
               onSubmit={(event) => {
                  event.preventDefault();
                  void onCreate();
               }}
            >
               <div className="flex min-h-[246px] flex-1 flex-col px-5 pt-7">
                  <Input
                     autoFocus
                     className="h-auto border-none bg-transparent px-0 text-xl leading-7 font-semibold text-zinc-100 shadow-none outline-none placeholder:text-zinc-600 focus-visible:ring-0"
                     placeholder={fa.meeting.titlePlaceholder}
                     value={form.title}
                     onChange={(event) => onFormChange((current) => ({ ...current, title: event.target.value }))}
                  />
                  <DescriptionEditor
                     className="mt-2"
                     contentClassName="min-h-24 text-right text-sm leading-6 text-zinc-300"
                     showToolbar={false}
                     uploadInlineFiles={uploadInlineFiles}
                     uploadInlineImages={uploadInlineImages}
                     value={form.description}
                     variant="plain"
                     users={users}
                     onChange={(description) => onFormChange((current) => ({ ...current, description }))}
                     onInlineFileUploadError={(err) => {
                        toast.error(err instanceof Error ? err.message : fa.meeting.createFailed);
                     }}
                     onInlineImageUploadError={(err) => {
                        toast.error(err instanceof Error ? err.message : fa.meeting.createFailed);
                     }}
                     placeholder={fa.meeting.descriptionPlaceholder}
                  />
                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pb-4">
                     <div className="relative inline-flex h-6 max-w-[196px] shrink-0">
                        <span className="sr-only">{fa.meeting.project}</span>
                        <Select
                           value={toSelectValue(form.projectId)}
                           onValueChange={(value) => onFormChange((current) => ({ ...current, projectId: fromSelectValue(value) }))}
                        >
                           <SelectTrigger
                              aria-label={fa.meeting.project}
                              className="h-6 min-w-0 rounded-full border-white/8 bg-[#2a2a2d] py-0 px-2.5 text-[12px] font-normal text-zinc-300 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] hover:bg-[#303033]"
                           >
                              <SelectValue placeholder={fa.meeting.project} />
                           </SelectTrigger>
                           <SelectContent className="rounded-xl border-white/10 bg-[#202023] text-zinc-100">
                              <SelectItem value={EMPTY_SELECT_VALUE}>{fa.meeting.project}</SelectItem>
                              {projects.map((project) => (
                                 <SelectItem key={project.id} value={project.id}>
                                    {project.name}
                                 </SelectItem>
                              ))}
                           </SelectContent>
                        </Select>
                     </div>
                     <div className="relative inline-flex h-6 max-w-[196px] shrink-0">
                        <span className="sr-only">{fa.meeting.owner}</span>
                        <span className="pointer-events-none absolute start-2 top-1/2 z-10 flex -translate-y-1/2 items-center">
                           <Users className="size-3.5 text-zinc-500" />
                        </span>
                        <Select
                           value={toSelectValue(form.ownerId)}
                           onValueChange={(value) => onFormChange((current) => ({ ...current, ownerId: fromSelectValue(value) }))}
                        >
                           <SelectTrigger
                              aria-label={fa.meeting.owner}
                              className="h-6 min-w-0 rounded-full border-white/8 bg-[#2a2a2d] py-0 ps-6 pe-2.5 text-[12px] font-normal text-zinc-300 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] hover:bg-[#303033]"
                           >
                              <SelectValue placeholder={fa.meeting.owner} />
                           </SelectTrigger>
                           <SelectContent className="rounded-xl border-white/10 bg-[#202023] text-zinc-100">
                              <SelectItem value={EMPTY_SELECT_VALUE}>{fa.meeting.owner}</SelectItem>
                              {users.map((user) => (
                                 <SelectItem key={user.id} value={user.id}>
                                    {user.name}
                                 </SelectItem>
                              ))}
                           </SelectContent>
                        </Select>
                     </div>
                     <div className="w-[260px] max-w-full">
                        <LazyJalaliDatePicker
                           ariaLabel={fa.meeting.scheduledAt}
                           showTime
                           value={form.scheduledAt}
                           onChange={(scheduledAt) => onFormChange((current) => ({ ...current, scheduledAt: scheduledAt || '' }))}
                        />
                     </div>
                  </div>
                  <div className="mb-4">
                     <UserMultiSelectCombobox
                        ariaLabel={fa.meeting.participants}
                        onChange={(participantIds) => onFormChange((current) => ({ ...current, participantIds }))}
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
   );
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
         {draftRecipientIds.length === 0 ? <p className="text-xs leading-5 text-amber-200/80">{fa.announcement.publishDraftNoRecipients}</p> : null}
         <Button
            className="h-8 w-full rounded-full bg-indigo-500 text-sm font-normal text-white hover:bg-indigo-400 disabled:bg-indigo-500/40"
            disabled={publishSubmitting || draftRecipientIds.length === 0}
            onClick={() => void onPublish()}
         >
            {publishSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {fa.announcement.publishDraft}
         </Button>
      </section>
   );
}

function ReadableContent({ children }: { children: ReactNode }) {
   return <p className="whitespace-pre-wrap text-sm leading-7 text-zinc-300">{children}</p>;
}

const communicationFilters: Array<{ value: CommunicationFilter; label: string }> = [
   { value: 'all', label: fa.communications.all },
   { value: 'announcements', label: fa.communications.announcementType },
   { value: 'meetings', label: fa.meeting.title },
   { value: 'unread', label: fa.announcement.unread },
   { value: 'mine', label: fa.communications.mine },
   { value: 'drafts', label: fa.announcement.draft },
];

function buildCommunicationItems(
   announcements: TaskaraAnnouncement[],
   meetings: TaskaraMeeting[],
   currentUserId: string | null
): CommunicationListItem[] {
   const announcementItems = announcements.map((announcement): CommunicationListItem => ({
      kind: 'announcement',
      id: announcement.id,
      title: announcement.title,
      preview: announcement.body || '',
      status: announcementStatusLabel(announcement.status),
      date: announcement.publishedAt || announcement.createdAt,
      unread: isAnnouncementUnreadForUser(announcement, currentUserId),
      audienceCount: announcement._count?.recipients || announcement.recipients?.length || 0,
      source: announcement,
   }));
   const meetingItems = meetings.map((meeting): CommunicationListItem => ({
      kind: 'meeting',
      id: meeting.id,
      title: meeting.title,
      preview: descriptionText(meeting.description) || meeting.project?.name || '',
      status: meetingStatusLabel(meeting.status),
      date: meeting.scheduledAt || meeting.heldAt || meeting.createdAt,
      audienceCount: meeting._count?.participants || meeting.participants?.length || 0,
      projectName: meeting.project?.name,
      source: meeting,
   }));

   return [...announcementItems, ...meetingItems].sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime());
}

function filterCommunicationItems(
   items: CommunicationListItem[],
   filter: CommunicationFilter,
   query: string,
   currentUserId: string | null
): CommunicationListItem[] {
   const normalizedQuery = normalizeSearchValue(query);
   return items.filter((item) => {
      if (filter === 'announcements' && item.kind !== 'announcement') return false;
      if (filter === 'meetings' && item.kind !== 'meeting') return false;
      if (filter === 'unread' && !item.unread) return false;
      if (filter === 'drafts') {
         if (item.kind !== 'announcement') return false;
         if ((item.source as TaskaraAnnouncement).status !== 'DRAFT') return false;
      }
      if (filter === 'mine' && !isCommunicationForUser(item, currentUserId)) return false;
      if (!normalizedQuery) return true;
      return communicationSearchValues(item).some((value) => normalizeSearchValue(value).includes(normalizedQuery));
   });
}

function communicationSearchValues(item: CommunicationListItem) {
   if (item.kind === 'announcement') {
      const announcement = item.source as TaskaraAnnouncement;
      return [
         item.title,
         item.preview,
         announcement.creator?.name,
         ...(announcement.recipients || []).map((recipient) => recipient.user.name),
      ];
   }

   const meeting = item.source as TaskaraMeeting;
   return [
      item.title,
      item.preview,
      meeting.project?.name,
      meeting.owner?.name,
      ...(meeting.participants || []).map((participant) => participant.user.name),
   ];
}

function isCommunicationForUser(item: CommunicationListItem, userId: string | null) {
   if (!userId) return false;
   if (item.kind === 'announcement') {
      const announcement = item.source as TaskaraAnnouncement;
      return announcement.creator?.id === userId || Boolean(announcementRecipientForUser(announcement, userId));
   }
   return isMeetingForUser(item.source as TaskaraMeeting, userId);
}

function isMeetingForUser(meeting: TaskaraMeeting, userId: string | null): boolean {
   if (!userId) return false;
   return (
      meeting.owner?.id === userId ||
      meeting.createdBy?.id === userId ||
      Boolean(meeting.participants?.some((participant) => participant.userId === userId))
   );
}

function communicationHref(workspaceSlug: string, item: Pick<CommunicationListItem, 'kind' | 'id'>): string {
   const segment = item.kind === 'announcement' ? 'announcements' : 'meetings';
   return `/${workspaceSlug}/communications/${segment}/${item.id}`;
}

function normalizeSearchValue(value: string | null | undefined): string {
   return (value || '').toLocaleLowerCase('fa').trim().replace(/\s+/g, ' ');
}

function mergeAnnouncementIntoList(items: TaskaraAnnouncement[], announcement: TaskaraAnnouncement) {
   return items.some((item) => item.id === announcement.id)
      ? items.map((item) => (item.id === announcement.id ? { ...item, ...announcement } : item))
      : [announcement, ...items];
}

function mergeMeetingIntoList(items: TaskaraMeeting[], meeting: TaskaraMeeting) {
   return items.some((item) => item.id === meeting.id)
      ? items.map((item) => (item.id === meeting.id ? { ...item, ...meeting } : item))
      : [meeting, ...items];
}

function detailDateLabel(
   announcement: TaskaraAnnouncement | null,
   meeting: TaskaraMeeting | null,
   item: CommunicationListItem | null
) {
   const date = announcement?.publishedAt || announcement?.createdAt || meeting?.scheduledAt || meeting?.heldAt || meeting?.createdAt || item?.date;
   return date ? formatJalaliDateTime(date) : fa.app.noDate;
}

function announcementStatusLabel(status: string): string {
   if (status === 'PUBLISHED') return fa.announcement.published;
   if (status === 'ARCHIVED') return fa.announcement.archived;
   return fa.announcement.draft;
}

function meetingStatusLabel(status: string): string {
   if (status === 'HELD') return fa.meeting.held;
   if (status === 'CANCELED') return fa.meeting.canceled;
   if (status === 'ARCHIVED') return fa.meeting.archived;
   return fa.meeting.planned;
}

function announcementRecipientForUser(announcement: TaskaraAnnouncement | null | undefined, userId: string | null) {
   if (!announcement || !userId) return undefined;
   return announcement.recipients?.find((recipient) => recipient.userId === userId);
}

function isAnnouncementUnreadForUser(announcement: TaskaraAnnouncement, userId: string | null): boolean {
   const recipient = announcementRecipientForUser(announcement, userId);
   return Boolean(recipient && !recipient.readAt);
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

function summaryText(template: string, summary: SmsSendSummary): string {
   return template
      .replace('{sent}', summary.sent.toLocaleString('fa-IR'))
      .replace('{skipped}', summary.skippedNoPhone.toLocaleString('fa-IR'))
      .replace('{failed}', summary.failed.toLocaleString('fa-IR'));
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

function isEditableTarget(target: EventTarget | null) {
   if (!(target instanceof HTMLElement)) return false;
   return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
}
