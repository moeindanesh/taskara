import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowLeftRight, Check, Link2, Loader2, Plus, ShieldCheck, Unplug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { formatJalaliDateTime } from '@/lib/jalali';
import { supportHandoffClient } from '@/lib/support-handoff-client';
import { supportClient } from '@/lib/support-client';
import {
   supportConnectionStatusLabels,
   supportHandoffIrreversibilityWarning,
} from '@/lib/support-handoff-presenters';
import type { SupportWorkspaceConnection } from '@/lib/support-handoff-types';
import type { SupportHandoffProjectOption } from '@/lib/support-handoff-types';
import type { SupportDepartment } from '@/lib/support-types';
import { taskaraRequest } from '@/lib/taskara-client';
import type { TaskaraWorkspaceMembership } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import { isWorkspaceAdminRole } from '@/lib/workspace-mode';
import { useWorkspaceRuntime } from '@/lib/workspace-runtime';

export function SupportWorkspaceConnectionsSettings({
   departments = [],
   embedded = false,
}: {
   departments?: SupportDepartment[];
   embedded?: boolean;
}) {
   const runtime = useWorkspaceRuntime();
   const isAdmin = isWorkspaceAdminRole(runtime.role);
   const [connections, setConnections] = useState<SupportWorkspaceConnection[]>([]);
   const [teamMemberships, setTeamMemberships] = useState<TaskaraWorkspaceMembership[]>([]);
   const [availableDepartments, setAvailableDepartments] = useState<SupportDepartment[]>(departments);
   const [loading, setLoading] = useState(true);
   const [busy, setBusy] = useState('');
   const [error, setError] = useState('');
   const [notice, setNotice] = useState('');
   const [teamWorkspaceId, setTeamWorkspaceId] = useState('');
   const [revokeConnection, setRevokeConnection] = useState<SupportWorkspaceConnection | null>(null);

   const load = useCallback(async () => {
      if (!isAdmin) return;
      setLoading(true);
      setError('');
      try {
         const [connectionResult, workspaceResult, departmentResult] = await Promise.all([
            supportHandoffClient.listConnections(),
            runtime.mode === 'SUPPORT'
               ? taskaraRequest<{ items: TaskaraWorkspaceMembership[]; total: number }>('/workspaces')
               : Promise.resolve({ items: [], total: 0 }),
            runtime.mode === 'SUPPORT'
               ? supportClient.listDepartments()
               : Promise.resolve({ items: [], total: 0, accessEpoch: '0' }),
         ]);
         setConnections(connectionResult.items);
         setTeamMemberships(workspaceResult.items.filter((membership) => membership.workspace.mode === 'TEAM'));
         setAvailableDepartments(departmentResult.items);
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'بارگذاری اتصال‌های فضای کاری ناموفق بود.');
      } finally {
         setLoading(false);
      }
   }, [isAdmin, runtime.mode]);

   useEffect(() => {
      void load();
   }, [load]);

   useEffect(() => {
      if (departments.length) setAvailableDepartments(departments);
   }, [departments]);

   async function createConnection(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!teamWorkspaceId || busy) return;
      setBusy('create');
      setError('');
      setNotice('');
      try {
         const result = await supportHandoffClient.createConnection(teamWorkspaceId);
         setTeamWorkspaceId('');
         setNotice(result.replayed
            ? 'درخواست موجود بازیابی شد؛ ابتدا مقصد دپارتمان را بررسی کنید.'
            : 'درخواست اتصال ثبت شد؛ پیش از تأیید دو طرف، حداقل یک مقصد دپارتمان تعیین کنید.');
         await load();
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'ثبت درخواست اتصال ناموفق بود.');
      } finally {
         setBusy('');
      }
   }

   async function approve(connection: SupportWorkspaceConnection) {
      if (busy) return;
      setBusy(`approve:${connection.id}`);
      setError('');
      setNotice('');
      try {
         await supportHandoffClient.approveConnection(connection.id, runtime.mode);
         setNotice('تأیید این فضای کاری ثبت شد.');
         await load();
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'تأیید اتصال ناموفق بود.');
      } finally {
         setBusy('');
      }
   }

   if (!isAdmin) return null;

   const body = (
      <div className="space-y-4">
         {error ? <Message tone="error">{error}</Message> : null}
         {notice ? <Message tone="success">{notice}</Message> : null}
         {runtime.mode === 'SUPPORT' ? (
            <form className="grid gap-3 rounded-lg border border-white/7 bg-black/10 p-3 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={createConnection}>
               <label className="grid gap-1.5 text-xs text-zinc-400">
                  فضای تیمی مقصد
                  <select
                     aria-label="فضای تیمی مقصد"
                     className={selectClass}
                     disabled={loading || busy === 'create'}
                     value={teamWorkspaceId}
                     onChange={(event) => setTeamWorkspaceId(event.target.value)}
                  >
                     <option value="">انتخاب فضای تیمی دارای عضویت</option>
                     {teamMemberships.map((membership) => (
                        <option key={membership.workspace.id} value={membership.workspace.id}>
                           {membership.workspace.name}
                        </option>
                     ))}
                  </select>
               </label>
               <Button className="self-end bg-zinc-100 text-zinc-950 hover:bg-white" disabled={!teamWorkspaceId || busy === 'create'} type="submit">
                  {busy === 'create' ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  درخواست اتصال
               </Button>
               <p className="text-xs leading-6 text-zinc-600 sm:col-span-2">
                  فقط فضایی فهرست می‌شود که خودتان عضو آن هستید. اتصال هیچ دسترسی تازه‌ای به پروژه یا کارها ایجاد نمی‌کند.
               </p>
            </form>
         ) : null}

         {loading ? <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-600"><Loader2 className="size-4 animate-spin" /> در حال بارگذاری اتصال‌ها…</div> : null}
         {!loading && !connections.length ? (
            <div className="rounded-lg border border-dashed border-white/10 px-4 py-10 text-center">
               <Link2 className="mx-auto size-7 text-zinc-600" />
               <p className="mt-3 text-sm text-zinc-400">هنوز اتصال دوطرفه‌ای ثبت نشده است.</p>
            </div>
         ) : null}
         <WorkspaceConnectionList
            busy={busy}
            connections={connections}
            departments={availableDepartments}
            side={runtime.mode}
            onApprove={(connection) => void approve(connection)}
            onChanged={() => void load()}
            onError={setError}
            onRevoke={setRevokeConnection}
            setBusy={setBusy}
         />
      </div>
   );

   return (
      <>
         {embedded ? (
            <Card className="border-white/8 bg-[#171719] text-zinc-100">
               <CardHeader className="border-b border-white/7">
                  <CardTitle className="flex items-center gap-2 text-base"><ArrowLeftRight className="size-4 text-indigo-300" /> تحویل کار به فضای تیمی</CardTitle>
                  <CardDescription className="mt-1.5 max-w-3xl leading-6 text-zinc-500">اتصال دوطرفه و مقصد مجاز هر دپارتمان را تنظیم کنید؛ پیوند پرونده و کار، دسترسی دو فضا را با هم ادغام نمی‌کند.</CardDescription>
               </CardHeader>
               <CardContent className="p-4">{body}</CardContent>
            </Card>
         ) : body}
         <RevokeConnectionDialog
            connection={revokeConnection}
            onOpenChange={(open) => !open && setRevokeConnection(null)}
            onRevoked={async () => {
               setRevokeConnection(null);
               setNotice('اتصال لغو شد؛ پیوندهای قبلی به‌صورت نمای منجمد باقی می‌مانند.');
               await load();
            }}
         />
      </>
   );
}

export function WorkspaceConnectionList({
   busy = '',
   connections,
   departments = [],
   side,
   onApprove = () => undefined,
   onChanged = () => undefined,
   onError = () => undefined,
   onRevoke = () => undefined,
   setBusy = () => undefined,
}: {
   busy?: string;
   connections: SupportWorkspaceConnection[];
   departments?: SupportDepartment[];
   side: 'SUPPORT' | 'TEAM';
   onApprove?: (connection: SupportWorkspaceConnection) => void;
   onChanged?: () => void;
   onError?: (message: string) => void;
   onRevoke?: (connection: SupportWorkspaceConnection) => void;
   setBusy?: (operation: string) => void;
}) {
   return (
      <div className="space-y-3">
         {connections.map((connection) => {
            const canApprove = connection.status === 'PENDING' && !connection.currentApproved && connection.targets.some((target) => target.active);
            return (
               <section key={connection.id} className="overflow-hidden rounded-lg border border-white/8 bg-[#111113]">
                  <div className="flex flex-col gap-3 border-b border-white/6 px-4 py-3 sm:flex-row sm:items-center">
                     <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-indigo-400/10 text-indigo-300"><ArrowLeftRight className="size-4" /></span>
                     <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-medium text-zinc-200">{connection.otherWorkspace.name}</h3>
                        <p className="mt-1 text-xs text-zinc-600">
                           تأیید این فضا: {connection.currentApproved ? 'ثبت شده' : 'ثبت نشده'} · تأیید فضای مقابل: {connection.otherApproved ? 'ثبت شده' : 'ثبت نشده'}
                           {' · '}ایجاد: {formatJalaliDateTime(connection.createdAt)}
                        </p>
                     </div>
                     <Badge variant="outline" className={connectionStatusTone(connection.status)}>{supportConnectionStatusLabels[connection.status]}</Badge>
                     {!connection.currentApproved && connection.status === 'PENDING' ? (
                        <Button className="border border-lime-400/20 bg-lime-400/10 text-lime-200 hover:bg-lime-400/15" disabled={Boolean(busy) || !canApprove} size="sm" type="button" variant="secondary" onClick={() => onApprove(connection)}>
                           {busy === `approve:${connection.id}` ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} تأیید این فضا
                        </Button>
                     ) : null}
                     {connection.status !== 'REVOKED' ? (
                        <Button className="text-zinc-500 hover:bg-red-400/10 hover:text-red-200" disabled={Boolean(busy)} size="sm" type="button" variant="ghost" onClick={() => onRevoke(connection)}><Unplug className="size-4" /> لغو</Button>
                     ) : null}
                  </div>
                  {side === 'SUPPORT' && connection.status === 'PENDING' && !connection.currentApproved && !connection.otherApproved ? (
                     <ConnectionTargets
                        busy={busy}
                        connection={connection}
                        departments={departments}
                        onChanged={onChanged}
                        onError={onError}
                        setBusy={setBusy}
                     />
                  ) : (
                     <div className="px-4 py-3 text-xs leading-6 text-zinc-600">
                        {connection.status === 'PENDING'
                           ? connection.targets.some((target) => target.active)
                              ? 'مقصدها پس از نخستین تأیید قفل می‌شوند؛ پس از تأیید هر دو فضا اتصال فعال خواهد شد.'
                              : 'پیش از تأیید، مدیر فضای پشتیبانی باید حداقل یک مقصد فعال دپارتمان ثبت کند.'
                           : connection.status === 'REVOKED'
                              ? 'تحویل تازه متوقف است و نماهای قبلی در آخرین وضعیت تأییدشده منجمد شده‌اند.'
                              : 'پروژه‌های مجاز را مدیر فضای پشتیبانی برای هر دپارتمان تعیین می‌کند.'}
                     </div>
                  )}
               </section>
            );
         })}
      </div>
   );
}

function ConnectionTargets({
   busy,
   connection,
   departments,
   onChanged,
   onError,
   setBusy,
}: {
   busy: string;
   connection: SupportWorkspaceConnection;
   departments: SupportDepartment[];
   onChanged: () => void;
   onError: (message: string) => void;
   setBusy: (operation: string) => void;
}) {
   const [departmentId, setDepartmentId] = useState('');
   const [projectId, setProjectId] = useState('');
   const [allowCreateTasks, setAllowCreateTasks] = useState(true);
   const [allowLinkTasks, setAllowLinkTasks] = useState(true);
   const [projects, setProjects] = useState<SupportHandoffProjectOption[]>([]);
   const [loadingProjects, setLoadingProjects] = useState(true);

   useEffect(() => {
      let cancelled = false;
      setLoadingProjects(true);
      void supportHandoffClient.listConnectionProjects(connection.id)
         .then((items) => { if (!cancelled) setProjects(items); })
         .catch((caught) => { if (!cancelled) onError(caught instanceof Error ? caught.message : 'بارگذاری پروژه‌های مجاز ناموفق بود.'); })
         .finally(() => { if (!cancelled) setLoadingProjects(false); });
      return () => { cancelled = true; };
   }, [connection.id, onError]);

   async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!departmentId || !projectId || (!allowCreateTasks && !allowLinkTasks) || busy) return;
      const operation = `target:${connection.id}`;
      setBusy(operation);
      onError('');
      try {
         await supportHandoffClient.createWorkTarget({
            connectionId: connection.id,
            departmentId,
            projectId,
            allowCreateTasks,
            allowLinkTasks,
         });
         setDepartmentId('');
         setProjectId('');
         onChanged();
      } catch (caught) {
         onError(caught instanceof Error ? caught.message : 'ثبت مقصد دپارتمان ناموفق بود.');
      } finally {
         setBusy('');
      }
   }

   return (
      <div className="space-y-3 p-4">
         <div className="grid gap-2">
            {!connection.targets.length ? <p className="rounded-md border border-dashed border-white/8 px-3 py-4 text-center text-xs text-zinc-600">برای این اتصال هنوز مقصد دپارتمانی ثبت نشده است.</p> : null}
            {connection.targets.map((target) => (
               <div key={target.id} className={cn('flex flex-wrap items-center gap-2 rounded-md border px-3 py-2.5 text-xs', target.active ? 'border-white/7 bg-white/[0.025]' : 'border-white/5 opacity-50')}>
                  <span className="text-zinc-300">{target.department.name}</span>
                  <span className="text-zinc-700">←</span>
                  <span className="font-medium text-zinc-300">{target.project.name}</span>
                  <span dir="ltr" className="font-mono text-zinc-600">{target.project.keyPrefix}</span>
                  <span className="ms-auto flex gap-1.5">
                     {target.allowCreateTasks ? <Badge variant="outline" className="border-indigo-400/15 text-[10px] text-indigo-200">ساخت کار</Badge> : null}
                     {target.allowLinkTasks ? <Badge variant="outline" className="border-sky-400/15 text-[10px] text-sky-200">پیوند موجود</Badge> : null}
                  </span>
               </div>
            ))}
         </div>
         <form className="grid gap-3 rounded-md border border-white/7 bg-black/10 p-3 lg:grid-cols-2" onSubmit={submit}>
            <label className="grid gap-1.5 text-xs text-zinc-400">دپارتمان
               <select className={selectClass} value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
                  <option value="">انتخاب دپارتمان</option>
                  {departments.filter((department) => department.active).map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
               </select>
            </label>
            <label className="grid gap-1.5 text-xs text-zinc-400">پروژه تیمی
               <select className={selectClass} disabled={loadingProjects} value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                     <option value="">انتخاب پروژه مجاز</option>
                     {projects.map((project) => <option key={project.actionRef} value={project.actionRef}>{project.name} ({project.keyPrefix})</option>)}
                  </select>
               {!loadingProjects && !projects.length ? <span className="text-[11px] leading-5 text-amber-200/75">پروژه‌ای که در آن اختیار نوشتن دارید یافت نشد.</span> : null}
            </label>
            <CapabilitySwitch checked={allowCreateTasks} label="اجازه ساخت کار تازه" onCheckedChange={setAllowCreateTasks} />
            <CapabilitySwitch checked={allowLinkTasks} label="اجازه پیوند کار موجود" onCheckedChange={setAllowLinkTasks} />
            {!allowCreateTasks && !allowLinkTasks ? <p role="alert" className="text-xs text-amber-300 lg:col-span-2">حداقل یکی از دو قابلیت باید فعال باشد.</p> : null}
            <div className="lg:col-span-2"><Button className="border border-white/10 bg-white/6 text-zinc-200 hover:bg-white/10" disabled={!departmentId || !projectId || (!allowCreateTasks && !allowLinkTasks) || Boolean(busy)} size="sm" type="submit" variant="secondary">{busy === `target:${connection.id}` ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} افزودن مقصد مجاز</Button></div>
         </form>
      </div>
   );
}

function CapabilitySwitch({ checked, label, onCheckedChange }: { checked: boolean; label: string; onCheckedChange: (checked: boolean) => void }) {
   return <label className="flex items-center justify-between gap-3 rounded-md border border-white/7 px-3 py-2.5 text-xs text-zinc-400"><span>{label}</span><Switch checked={checked} onCheckedChange={onCheckedChange} /></label>;
}

function RevokeConnectionDialog({
   connection,
   onOpenChange,
   onRevoked,
}: {
   connection: SupportWorkspaceConnection | null;
   onOpenChange: (open: boolean) => void;
   onRevoked: () => Promise<void>;
}) {
   const [reason, setReason] = useState('');
   const [confirmed, setConfirmed] = useState(false);
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   useEffect(() => {
      if (!connection) return;
      setReason('');
      setConfirmed(false);
      setError('');
   }, [connection]);

   async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!connection || !reason.trim() || !confirmed) return;
      setSubmitting(true);
      setError('');
      try {
         await supportHandoffClient.revokeConnection(connection.id, reason.trim());
         await onRevoked();
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'لغو اتصال ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <Dialog open={Boolean(connection)} onOpenChange={(open) => !submitting && onOpenChange(open)}>
         <DialogContent dir="rtl" className="border-white/10 bg-[#171719] text-zinc-100">
            <DialogHeader><DialogTitle>لغو اتصال دو فضای کاری</DialogTitle><DialogDescription className="leading-6 text-zinc-500">تحویل تازه متوقف می‌شود؛ پرونده و کارهای قبلی حذف نمی‌شوند.</DialogDescription></DialogHeader>
            <form className="space-y-4" onSubmit={submit}>
               {error ? <Message tone="error">{error}</Message> : null}
               <div className="rounded-lg border border-amber-400/15 bg-amber-400/[0.045] px-3 py-2.5 text-xs leading-6 text-amber-100/80"><AlertTriangle className="me-1 inline size-4" />{supportHandoffIrreversibilityWarning}</div>
               <label className="grid gap-1.5 text-sm text-zinc-300">دلیل لغو<Textarea className={inputClass} maxLength={1000} required value={reason} onChange={(event) => setReason(event.target.value)} /></label>
               <label className="flex items-start gap-2 text-xs leading-6 text-zinc-400"><input checked={confirmed} className="mt-1 size-4 accent-red-400" type="checkbox" onChange={(event) => setConfirmed(event.target.checked)} /><span>می‌دانم نمای پیوندهای قبلی منجمد می‌شود و متن کپی‌شده قابل بازپس‌گیری نیست.</span></label>
               <DialogFooter className="sm:flex-row-reverse sm:justify-start"><Button className="bg-red-500/20 text-red-100 hover:bg-red-500/30" disabled={!reason.trim() || !confirmed || submitting} type="submit">{submitting ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />} لغو اتصال</Button><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>انصراف</Button></DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}

function connectionStatusTone(status: SupportWorkspaceConnection['status']): string {
   if (status === 'ACTIVE') return 'border-lime-400/20 bg-lime-400/8 text-lime-300';
   if (status === 'PENDING') return 'border-amber-400/20 bg-amber-400/8 text-amber-300';
   return 'border-white/10 bg-white/5 text-zinc-500';
}

function Message({ children, tone }: { children: React.ReactNode; tone: 'error' | 'success' }) {
   return <p role={tone === 'error' ? 'alert' : 'status'} className={cn('rounded-lg border px-3 py-2.5 text-sm', tone === 'error' ? 'border-red-400/20 bg-red-400/8 text-red-200' : 'border-lime-400/15 bg-lime-400/[0.045] text-lime-200')}><ShieldCheck className="me-1 inline size-4" />{children}</p>;
}

const inputClass = 'border-white/10 bg-[#0c0c0e] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/20';
const selectClass = 'h-9 w-full rounded-md border border-white/10 bg-[#0c0c0e] px-3 text-sm text-zinc-200 outline-none focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/20';
