'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Gauge, RefreshCw, Save, Settings2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { LinearAvatar } from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { dispatchWorkspaceRefresh } from '@/lib/live-refresh';
import { taskaraRequest } from '@/lib/taskara-client';
import type {
   TaskaraCapacityUser,
   TaskaraCapacityUserListResponse,
   TaskaraTeam,
   TaskaraTeamWorkingAgreement,
   TaskaraTeamWorkingAgreementListResponse,
   TaskaraUserCapacity,
} from '@/lib/taskara-types';
import { cn } from '@/lib/utils';

type CapacityDraft = {
   active: boolean;
   dailyWeightLimit: string;
   note: string;
   weeklyWeightLimit: string;
};

type AgreementDraft = {
   activeWipLimit: string;
   blockedSlaHours: string;
   reviewSlaHours: string;
   reviewWipLimit: string;
   staleAfterHours: string;
   teamId: string;
};

const workspaceAgreementScope = 'workspace';
const numberFormatter = new Intl.NumberFormat('fa-IR');

export function CapacitySettingsView() {
   const [users, setUsers] = useState<TaskaraCapacityUser[]>([]);
   const [agreements, setAgreements] = useState<TaskaraTeamWorkingAgreement[]>([]);
   const [teams, setTeams] = useState<TaskaraTeam[]>([]);
   const [capacityDrafts, setCapacityDrafts] = useState<Record<string, CapacityDraft>>({});
   const [agreementDraft, setAgreementDraft] = useState<AgreementDraft>(() => agreementToDraft(null, workspaceAgreementScope));
   const [selectedScope, setSelectedScope] = useState(workspaceAgreementScope);
   const [loading, setLoading] = useState(true);
   const [refreshing, setRefreshing] = useState(false);
   const [error, setError] = useState('');
   const [savingUserId, setSavingUserId] = useState<string | null>(null);
   const [savingAgreement, setSavingAgreement] = useState(false);
   const requestRef = useRef(0);

   const load = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
      const requestId = ++requestRef.current;
      if (mode === 'initial') setLoading(true);
      if (mode === 'refresh') setRefreshing(true);
      setError('');

      try {
         const [capacityResult, agreementResult, teamResult] = await Promise.all([
            taskaraRequest<TaskaraCapacityUserListResponse>('/capacity/users'),
            taskaraRequest<TaskaraTeamWorkingAgreementListResponse>('/capacity/agreements'),
            taskaraRequest<TaskaraTeam[]>('/teams'),
         ]);
         if (requestId !== requestRef.current) return;
         setUsers(capacityResult.items);
         setAgreements(agreementResult.items);
         setTeams(teamResult);
         setCapacityDrafts(Object.fromEntries(capacityResult.items.map((item) => [item.user.id, capacityToDraft(item.capacity)])));
      } catch (loadError) {
         if (requestId === requestRef.current) {
            setError(loadError instanceof Error ? loadError.message : fa.capacitySettings.loadFailed);
         }
      } finally {
         if (requestId === requestRef.current) {
            setLoading(false);
            setRefreshing(false);
         }
      }
   }, []);

   useEffect(() => {
      void load();
   }, [load]);

   const selectedAgreement = useMemo(
      () => agreements.find((item) => agreementScopeValue(item) === selectedScope) || null,
      [agreements, selectedScope]
   );

   useEffect(() => {
      setAgreementDraft(agreementToDraft(selectedAgreement, selectedScope));
   }, [selectedAgreement, selectedScope]);

   const activeUsers = users.filter((item) => capacityDrafts[item.user.id]?.active !== false).length;
   const averageDailyCapacity = users.length
      ? users.reduce((sum, item) => sum + (Number(capacityDrafts[item.user.id]?.dailyWeightLimit) || item.capacity.dailyWeightLimit || 0), 0) / users.length
      : 0;

   async function saveCapacity(item: TaskaraCapacityUser) {
      const draft = capacityDrafts[item.user.id] || capacityToDraft(item.capacity);
      const payload = capacityDraftToPayload(draft);
      if (!payload) {
         toast.error(fa.capacitySettings.invalidCapacity);
         return;
      }

      setSavingUserId(item.user.id);
      try {
         const updated = await taskaraRequest<TaskaraUserCapacity>(`/capacity/users/${encodeURIComponent(item.user.id)}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
         });
         setUsers((current) => current.map((row) => (row.user.id === item.user.id ? { ...row, capacity: updated } : row)));
         setCapacityDrafts((current) => ({ ...current, [item.user.id]: capacityToDraft(updated) }));
         dispatchWorkspaceRefresh({ source: 'capacity:user' });
         toast.success(fa.capacitySettings.capacitySaved);
      } catch (saveError) {
         toast.error(saveError instanceof Error ? saveError.message : fa.capacitySettings.saveFailed);
      } finally {
         setSavingUserId(null);
      }
   }

   async function saveAgreement() {
      const payload = agreementDraftToPayload(agreementDraft);
      if (!payload) {
         toast.error(fa.capacitySettings.invalidAgreement);
         return;
      }

      setSavingAgreement(true);
      try {
         const saved = await taskaraRequest<TaskaraTeamWorkingAgreement>('/capacity/agreements', {
            method: 'POST',
            body: JSON.stringify(payload),
         });
         setAgreements((current) => {
            const scope = agreementScopeValue(saved);
            return [saved, ...current.filter((item) => agreementScopeValue(item) !== scope)];
         });
         setSelectedScope(agreementScopeValue(saved));
         dispatchWorkspaceRefresh({ source: 'capacity:agreement' });
         toast.success(fa.capacitySettings.agreementSaved);
      } catch (saveError) {
         toast.error(saveError instanceof Error ? saveError.message : fa.capacitySettings.saveFailed);
      } finally {
         setSavingAgreement(false);
      }
   }

   return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background text-zinc-900 dark:bg-[#101011] dark:text-zinc-100" data-testid="capacity-settings-screen">
         <div className="sticky top-0 z-10 border-b border-zinc-200 bg-background/95 px-4 py-3 backdrop-blur dark:border-white/8 dark:bg-[#101011]/95 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
               <div className="min-w-0 text-xs leading-5 text-zinc-500">{fa.capacitySettings.description}</div>
               <Button size="xs" variant="outline" className="h-8 gap-1.5" onClick={() => void load('refresh')} disabled={refreshing}>
                  <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
                  {fa.capacitySettings.refresh}
               </Button>
            </div>
         </div>

         <main className="space-y-4 p-4 sm:p-6">
            {error ? (
               <div className="rounded-md border border-red-400/25 bg-red-400/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">
                  {error}
               </div>
            ) : null}

            {loading ? (
               <CapacitySettingsSkeleton />
            ) : (
               <>
                  <section className="grid gap-2 md:grid-cols-3">
                     <MetricTile icon={Users} label={fa.capacitySettings.peopleMetric} value={users.length} />
                     <MetricTile icon={CheckCircle2} label={fa.capacitySettings.activeMetric} value={activeUsers} />
                     <MetricTile icon={Gauge} label={fa.capacitySettings.averageMetric} value={Number(averageDailyCapacity.toFixed(1))} suffix={fa.capacitySettings.weightUnit} />
                  </section>

                  <section className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
                     <UserCapacityPanel
                        drafts={capacityDrafts}
                        savingUserId={savingUserId}
                        users={users}
                        onDraftChange={(userId, draft) => setCapacityDrafts((current) => ({ ...current, [userId]: draft }))}
                        onSave={saveCapacity}
                     />
                     <AgreementPanel
                        draft={agreementDraft}
                        saving={savingAgreement}
                        selectedScope={selectedScope}
                        teams={teams}
                        onDraftChange={setAgreementDraft}
                        onSave={() => void saveAgreement()}
                        onScopeChange={setSelectedScope}
                     />
                  </section>
               </>
            )}
         </main>
      </div>
   );
}

function UserCapacityPanel({
   drafts,
   savingUserId,
   users,
   onDraftChange,
   onSave,
}: {
   drafts: Record<string, CapacityDraft>;
   savingUserId: string | null;
   users: TaskaraCapacityUser[];
   onDraftChange: (userId: string, draft: CapacityDraft) => void;
   onSave: (item: TaskaraCapacityUser) => void;
}) {
   return (
      <section className="min-w-0 space-y-3">
         <header className="px-1">
            <div className="flex min-w-0 items-center gap-2">
               <Users className="size-4 shrink-0 text-zinc-500" />
               <h2 className="truncate text-sm font-semibold">{fa.capacitySettings.userCapacityTitle}</h2>
            </div>
            <p className="mt-1 text-xs leading-5 text-zinc-500">{fa.capacitySettings.userCapacityDescription}</p>
         </header>
         {users.length ? (
            <div className="grid gap-3">
               {users.map((item) => {
                  const draft = drafts[item.user.id] || capacityToDraft(item.capacity);
                  return (
                     <article
                        key={item.user.id}
                        className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-white/8 dark:bg-[#161618]"
                        data-testid="capacity-user-row"
                     >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                           <div className="flex min-w-0 items-start gap-3">
                              <LinearAvatar name={item.user.name} src={item.user.avatarUrl} className="size-10 shrink-0" />
                              <div className="min-w-0">
                                 <div className="truncate text-sm font-semibold">{item.user.name}</div>
                                 <div className="ltr truncate text-xs text-zinc-500">{item.user.email}</div>
                                 <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-zinc-500">
                                    <span className="rounded-full border border-zinc-200 px-2 py-0.5 dark:border-white/8">{roleLabel(item.role)}</span>
                                    {!item.capacity.id ? (
                                       <span className="rounded-full border border-amber-300/60 bg-amber-300/10 px-2 py-0.5 text-amber-700 dark:border-amber-400/20 dark:text-amber-200">
                                          {fa.capacitySettings.defaultCapacity}
                                       </span>
                                    ) : null}
                                 </div>
                              </div>
                           </div>

                           <Button size="xs" className="h-8 gap-1.5 self-start sm:shrink-0" disabled={savingUserId === item.user.id} onClick={() => onSave(item)}>
                              {savingUserId === item.user.id ? <RefreshCw className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                              {fa.capacitySettings.saveCapacity}
                           </Button>
                        </div>

                        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(132px,0.55fr)_minmax(132px,0.55fr)_minmax(260px,1fr)]">
                           <NumberField
                              label={fa.capacitySettings.dailyLimit}
                              max={100}
                              min={0}
                              value={draft.dailyWeightLimit}
                              onChange={(dailyWeightLimit) => onDraftChange(item.user.id, { ...draft, dailyWeightLimit })}
                           />
                           <NumberField
                              label={fa.capacitySettings.weeklyLimit}
                              max={500}
                              min={0}
                              optional
                              value={draft.weeklyWeightLimit}
                              onChange={(weeklyWeightLimit) => onDraftChange(item.user.id, { ...draft, weeklyWeightLimit })}
                           />
                           <label className="flex min-h-14 min-w-0 items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2 text-xs dark:border-white/8">
                              <span className="min-w-0">
                                 <span className="block font-medium">{fa.capacitySettings.activeCapacity}</span>
                                 <span className="mt-0.5 block leading-5 text-zinc-500">{fa.capacitySettings.activeCapacityDescription}</span>
                              </span>
                              <Switch checked={draft.active} onCheckedChange={(active) => onDraftChange(item.user.id, { ...draft, active })} />
                           </label>
                           <label className="min-w-0 md:col-span-2 xl:col-span-3">
                              <span className="mb-1 block text-xs font-medium text-zinc-500">{fa.capacitySettings.note}</span>
                              <Textarea
                                 className="min-h-16 resize-none text-sm"
                                 maxLength={2000}
                                 value={draft.note}
                                 onChange={(event) => onDraftChange(item.user.id, { ...draft, note: event.target.value })}
                                 placeholder={fa.capacitySettings.notePlaceholder}
                              />
                           </label>
                        </div>
                     </article>
                  );
               })}
            </div>
         ) : (
            <EmptyState title={fa.capacitySettings.noUsers} />
         )}
      </section>
   );
}

function AgreementPanel({
   draft,
   saving,
   selectedScope,
   teams,
   onDraftChange,
   onSave,
   onScopeChange,
}: {
   draft: AgreementDraft;
   saving: boolean;
   selectedScope: string;
   teams: TaskaraTeam[];
   onDraftChange: (draft: AgreementDraft) => void;
   onSave: () => void;
   onScopeChange: (scope: string) => void;
}) {
   return (
      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-white/8 dark:bg-[#161618]">
         <header className="border-b border-zinc-200 px-4 py-3 dark:border-white/7">
            <div className="flex min-w-0 items-center gap-2">
               <Settings2 className="size-4 shrink-0 text-zinc-500" />
               <h2 className="truncate text-sm font-semibold">{fa.capacitySettings.agreementTitle}</h2>
            </div>
            <p className="mt-1 text-xs leading-5 text-zinc-500">{fa.capacitySettings.agreementDescription}</p>
         </header>
         <div className="space-y-3 p-4">
            <label className="block">
               <span className="mb-1 block text-xs font-medium text-zinc-500">{fa.capacitySettings.scope}</span>
               <Select value={selectedScope} onValueChange={onScopeChange}>
                  <SelectTrigger className="h-9">
                     <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                     <SelectItem value={workspaceAgreementScope}>{fa.capacitySettings.workspaceScope}</SelectItem>
                     {teams.map((team) => (
                        <SelectItem key={team.id} value={`team:${team.id}`}>
                           {team.name}
                        </SelectItem>
                     ))}
                  </SelectContent>
               </Select>
            </label>

            <div className="grid gap-2 sm:grid-cols-2">
               <NumberField
                  label={fa.capacitySettings.activeWipLimit}
                  max={500}
                  min={0}
                  optional
                  value={draft.activeWipLimit}
                  onChange={(activeWipLimit) => onDraftChange({ ...draft, activeWipLimit })}
               />
               <NumberField
                  label={fa.capacitySettings.reviewWipLimit}
                  max={500}
                  min={0}
                  optional
                  value={draft.reviewWipLimit}
                  onChange={(reviewWipLimit) => onDraftChange({ ...draft, reviewWipLimit })}
               />
               <NumberField
                  label={fa.capacitySettings.reviewSlaHours}
                  max={720}
                  min={1}
                  value={draft.reviewSlaHours}
                  onChange={(reviewSlaHours) => onDraftChange({ ...draft, reviewSlaHours })}
               />
               <NumberField
                  label={fa.capacitySettings.blockedSlaHours}
                  max={720}
                  min={1}
                  value={draft.blockedSlaHours}
                  onChange={(blockedSlaHours) => onDraftChange({ ...draft, blockedSlaHours })}
               />
               <NumberField
                  label={fa.capacitySettings.staleAfterHours}
                  max={2160}
                  min={1}
                  value={draft.staleAfterHours}
                  onChange={(staleAfterHours) => onDraftChange({ ...draft, staleAfterHours })}
               />
            </div>

            <Button className="h-8 gap-1.5" disabled={saving} size="xs" onClick={onSave}>
               {saving ? <RefreshCw className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
               {fa.capacitySettings.saveAgreement}
            </Button>
         </div>
      </section>
   );
}

function NumberField({
   label,
   max,
   min,
   optional = false,
   value,
   onChange,
}: {
   label: string;
   max: number;
   min: number;
   optional?: boolean;
   value: string;
   onChange: (value: string) => void;
}) {
   return (
      <label className="min-w-0">
         <span className="mb-1 block text-xs font-medium text-zinc-500">{label}</span>
         <Input
            inputMode="decimal"
            max={max}
            min={min}
            type="number"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={optional ? fa.capacitySettings.optionalNumber : undefined}
         />
      </label>
   );
}

function MetricTile({
   icon: Icon,
   label,
   suffix,
   value,
}: {
   icon: React.ComponentType<{ className?: string }>;
   label: string;
   suffix?: string;
   value: number;
}) {
   return (
      <div className="rounded-lg border border-zinc-200 bg-white px-3 py-3 shadow-sm dark:border-white/8 dark:bg-[#161618]">
         <div className="flex items-center justify-between gap-3">
            <span className="inline-flex size-8 items-center justify-center rounded-md border border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-white/8 dark:bg-white/5 dark:text-zinc-300">
               <Icon className="size-4" />
            </span>
            <span className="text-xl font-semibold">
               {numberFormatter.format(value)}
               {suffix ? <span className="ms-1 text-xs font-normal text-zinc-500">{suffix}</span> : null}
            </span>
         </div>
         <div className="mt-2 truncate text-xs text-zinc-500">{label}</div>
      </div>
   );
}

function EmptyState({ title }: { title: string }) {
   return (
      <div className="rounded-md border border-dashed border-zinc-200 px-4 py-10 text-center dark:border-white/10">
         <CheckCircle2 className="mx-auto mb-2 size-5 text-emerald-500" />
         <div className="text-sm font-medium">{title}</div>
      </div>
   );
}

function CapacitySettingsSkeleton() {
   return (
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
         <div className="h-[520px] animate-pulse rounded-lg border border-zinc-200 bg-zinc-100 dark:border-white/8 dark:bg-white/5" />
         <div className="h-[360px] animate-pulse rounded-lg border border-zinc-200 bg-zinc-100 dark:border-white/8 dark:bg-white/5" />
      </div>
   );
}

function capacityToDraft(capacity: TaskaraUserCapacity): CapacityDraft {
   return {
      active: capacity.active,
      dailyWeightLimit: String(capacity.dailyWeightLimit ?? 8),
      note: capacity.note || '',
      weeklyWeightLimit: capacity.weeklyWeightLimit === null || capacity.weeklyWeightLimit === undefined ? '' : String(capacity.weeklyWeightLimit),
   };
}

function capacityDraftToPayload(draft: CapacityDraft) {
   const dailyWeightLimit = numberOrNull(draft.dailyWeightLimit);
   const weeklyWeightLimit = optionalNumberOrNull(draft.weeklyWeightLimit);
   if (dailyWeightLimit === null || weeklyWeightLimit === false) return null;
   if (dailyWeightLimit < 0 || dailyWeightLimit > 100) return null;
   if (typeof weeklyWeightLimit === 'number' && (weeklyWeightLimit < 0 || weeklyWeightLimit > 500)) return null;
   return {
      active: draft.active,
      dailyWeightLimit,
      note: draft.note.trim() || null,
      weeklyWeightLimit,
   };
}

function agreementToDraft(agreement: TaskaraTeamWorkingAgreement | null, selectedScope: string): AgreementDraft {
   return {
      activeWipLimit: optionalNumberString(agreement?.activeWipLimit),
      blockedSlaHours: String(agreement?.blockedSlaHours ?? 24),
      reviewSlaHours: String(agreement?.reviewSlaHours ?? 24),
      reviewWipLimit: optionalNumberString(agreement?.reviewWipLimit),
      staleAfterHours: String(agreement?.staleAfterHours ?? 72),
      teamId: selectedScope.startsWith('team:') ? selectedScope.slice(5) : '',
   };
}

function agreementDraftToPayload(draft: AgreementDraft) {
   const activeWipLimit = optionalNumberOrNull(draft.activeWipLimit);
   const reviewWipLimit = optionalNumberOrNull(draft.reviewWipLimit);
   const reviewSlaHours = numberOrNull(draft.reviewSlaHours);
   const blockedSlaHours = numberOrNull(draft.blockedSlaHours);
   const staleAfterHours = numberOrNull(draft.staleAfterHours);
   if (
      activeWipLimit === false ||
      reviewWipLimit === false ||
      reviewSlaHours === null ||
      blockedSlaHours === null ||
      staleAfterHours === null
   ) {
      return null;
   }
   if (
      (typeof activeWipLimit === 'number' && (activeWipLimit < 0 || activeWipLimit > 500)) ||
      (typeof reviewWipLimit === 'number' && (reviewWipLimit < 0 || reviewWipLimit > 500)) ||
      reviewSlaHours < 1 ||
      reviewSlaHours > 720 ||
      blockedSlaHours < 1 ||
      blockedSlaHours > 720 ||
      staleAfterHours < 1 ||
      staleAfterHours > 2160
   ) {
      return null;
   }
   return {
      activeWipLimit,
      blockedSlaHours,
      reviewSlaHours,
      reviewWipLimit,
      staleAfterHours,
      teamId: draft.teamId || null,
   };
}

function agreementScopeValue(agreement: TaskaraTeamWorkingAgreement): string {
   return agreement.teamId ? `team:${agreement.teamId}` : workspaceAgreementScope;
}

function numberOrNull(value: string): number | null {
   if (!value.trim()) return null;
   const numeric = Number(value);
   return Number.isFinite(numeric) ? numeric : null;
}

function optionalNumberOrNull(value: string): number | null | false {
   if (!value.trim()) return null;
   const numeric = Number(value);
   return Number.isFinite(numeric) ? numeric : false;
}

function optionalNumberString(value: number | null | undefined): string {
   return value === null || value === undefined ? '' : String(value);
}

function roleLabel(role: string): string {
   return fa.role[role as keyof typeof fa.role] || role;
}
