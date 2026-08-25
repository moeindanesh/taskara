import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Building2, Loader2, PencilLine, Plus, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LinearAvatar } from '@/components/taskara/linear-ui';
import { taskaraRequest } from '@/lib/taskara-client';
import type { PaginatedResponse, TaskaraUser } from '@/lib/taskara-types';
import type { SupportDepartment, SupportDepartmentMember, SupportPermissionGrant } from '@/lib/support-types';
import { useSupportWorkspace } from '@/lib/support-workspace-provider';
import { isWorkspaceAdminRole } from '@/lib/workspace-mode';
import { useWorkspaceRuntime } from '@/lib/workspace-runtime';
import { cn } from '@/lib/utils';
import { SupportWorkspaceConnectionsSettings } from '@/components/taskara/support-workspace-connections-settings';

const emptyDepartmentForm = { name: '', slug: '', description: '' };

export function SupportDepartmentsView({ setup = false }: { setup?: boolean }) {
   const support = useSupportWorkspace();
   const runtime = useWorkspaceRuntime();
   const canConfigureWorkspace = isWorkspaceAdminRole(runtime.role);
   const [users, setUsers] = useState<TaskaraUser[]>([]);
   const [selectedId, setSelectedId] = useState('');
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState('');
   const [createOpen, setCreateOpen] = useState(false);
   const [grantOpen, setGrantOpen] = useState(false);

   const load = useCallback(async () => {
      setLoading(true);
      setError('');
      try {
         const [departments, , userPage] = await Promise.all([
            support.loadDepartments(),
            canConfigureWorkspace ? support.loadGrants() : Promise.resolve([]),
            canConfigureWorkspace
               ? taskaraRequest<PaginatedResponse<TaskaraUser>>('/users?limit=100')
               : Promise.resolve(null),
         ]);
         setUsers(userPage ? userPage.items.filter((user) => user.kind !== 'AGENT') : []);
         setSelectedId((current) => current || departments[0]?.id || '');
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'بارگذاری تنظیمات پشتیبانی ناموفق بود.');
      } finally {
         setLoading(false);
      }
   }, [canConfigureWorkspace, support.loadDepartments, support.loadGrants]);

   useEffect(() => {
      void load();
   }, [load]);

   const selected = support.state.departmentsById[selectedId];

   return (
      <main dir="rtl" className="min-h-full bg-[#101011] px-4 py-5 text-zinc-200 sm:px-5" data-testid="support-departments-screen">
         {setup ? (
            <div className="mx-auto mb-4 max-w-7xl rounded-xl border border-indigo-400/15 bg-indigo-400/[0.045] px-4 py-4 sm:px-5">
               <h2 className="text-sm font-semibold text-zinc-200">راه‌اندازی فضای پشتیبانی</h2>
               <p className="mt-1.5 text-sm leading-7 text-zinc-500">نخست دپارتمان‌ها، اعضای پاسخ‌گو و مجوز تریاژ را مشخص کنید. هر عضو فقط پرونده‌های واگذارشده به خودش را می‌بیند.</p>
            </div>
         ) : null}
         <div className="mx-auto grid max-w-7xl gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
            <Card className="h-fit border-white/8 bg-[#171719] text-zinc-100">
               <CardHeader className="flex flex-row items-start justify-between gap-4 border-b border-white/7">
                  <div>
                     <CardTitle className="text-base">دپارتمان‌ها</CardTitle>
                     <CardDescription className="mt-1.5 leading-6 text-zinc-500">مرز مالکیت پرونده و اعضای پاسخ‌گو</CardDescription>
                  </div>
                  {canConfigureWorkspace ? <Button aria-label="ساخت دپارتمان" className="size-8 bg-zinc-100 text-zinc-950 hover:bg-white" size="icon" type="button" onClick={() => setCreateOpen(true)}>
                     <Plus className="size-4" />
                  </Button> : null}
               </CardHeader>
               <CardContent className="p-2">
                  {loading ? <LoadingLine label="در حال بارگذاری دپارتمان‌ها…" /> : null}
                  {!loading && !support.departments.length ? (
                     <div className="px-4 py-10 text-center">
                        <Building2 className="mx-auto size-7 text-zinc-600" />
                        <p className="mt-3 text-sm text-zinc-400">هنوز دپارتمانی ساخته نشده است.</p>
                        <p className="mt-1 text-xs leading-6 text-zinc-600">اولین دپارتمان را بسازید و اعضای مسئول را به آن اضافه کنید.</p>
                     </div>
                  ) : null}
                  <div className="grid gap-1">
                     {support.departments.map((department) => (
                        <button
                           key={department.id}
                           className={cn(
                              'flex w-full items-center gap-3 rounded-lg px-3 py-3 text-start transition',
                              selectedId === department.id ? 'bg-white/8 text-zinc-100' : 'text-zinc-400 hover:bg-white/4'
                           )}
                           type="button"
                           onClick={() => setSelectedId(department.id)}
                        >
                           <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-400/10 text-indigo-300"><Building2 className="size-4" /></span>
                           <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{department.name}</span>
                              <span dir="ltr" className="mt-0.5 block truncate text-left text-xs text-zinc-600">{department.slug}</span>
                           </span>
                           {!department.active ? <Badge variant="outline" className="border-white/10 text-[10px] text-zinc-500">غیرفعال</Badge> : null}
                        </button>
                     ))}
                  </div>
               </CardContent>
            </Card>

            <div className="min-w-0 space-y-4">
               {error ? <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/8 px-4 py-3 text-sm text-red-200">{error}</p> : null}
               {selected ? <DepartmentDetail canConfigure={canConfigureWorkspace} department={selected} users={users} /> : (
                  <Card className="border-white/8 bg-[#171719] text-zinc-100">
                     <CardContent className="flex min-h-64 items-center justify-center p-6 text-center text-sm text-zinc-600">برای مدیریت اعضا یک دپارتمان را انتخاب کنید.</CardContent>
                  </Card>
               )}
               {canConfigureWorkspace ? <PermissionGrantsCard grants={support.grants} users={users} onAdd={() => setGrantOpen(true)} /> : null}
            </div>
         </div>

         {canConfigureWorkspace ? (
            <div className="mx-auto mt-4 max-w-7xl">
               <SupportWorkspaceConnectionsSettings embedded departments={support.departments} />
            </div>
         ) : null}

         {canConfigureWorkspace ? <CreateDepartmentDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(department) => setSelectedId(department.id)} /> : null}
         {canConfigureWorkspace ? <GrantDialog open={grantOpen} users={users} onOpenChange={setGrantOpen} /> : null}
      </main>
   );
}

function DepartmentDetail({
   canConfigure,
   department,
   users,
}: {
   canConfigure: boolean;
   department: SupportDepartment;
   users: TaskaraUser[];
}) {
   const support = useSupportWorkspace();
   const [members, setMembers] = useState<SupportDepartmentMember[]>([]);
   const [userId, setUserId] = useState('');
   const [role, setRole] = useState<'MEMBER' | 'MANAGER'>('MEMBER');
   const [loading, setLoading] = useState(true);
   const [submitting, setSubmitting] = useState(false);
   const [editOpen, setEditOpen] = useState(false);
   const [error, setError] = useState('');

   const loadMembers = useCallback(async () => {
      setLoading(true);
      setError('');
      try {
         setMembers(await support.loadDepartmentMembers(department.id));
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'بارگذاری اعضای دپارتمان ناموفق بود.');
      } finally {
         setLoading(false);
      }
   }, [department.id, support.loadDepartmentMembers]);

   useEffect(() => {
      void loadMembers();
   }, [loadMembers]);

   const availableUsers = useMemo(() => {
      const activeUserIds = new Set(members.filter((member) => member.active).map((member) => member.userId));
      return users.filter((user) => !activeUserIds.has(user.id));
   }, [members, users]);

   async function addMember(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!userId) return;
      setSubmitting(true);
      setError('');
      try {
         await support.addDepartmentMember(department.id, { userId, role });
         setUserId('');
         setRole('MEMBER');
         await loadMembers();
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'افزودن عضو ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   async function changeRole(member: SupportDepartmentMember, nextRole: 'MEMBER' | 'MANAGER') {
      setError('');
      try {
         await support.updateDepartmentMember(department.id, member.userId, { role: nextRole });
         await loadMembers();
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'تغییر نقش ناموفق بود.');
      }
   }

   async function deactivate(member: SupportDepartmentMember) {
      if (!window.confirm(`عضویت ${member.user?.name || 'این کاربر'} غیرفعال شود؟ پرونده‌های باز او به صف دپارتمان برمی‌گردند.`)) return;
      setError('');
      try {
         await support.removeDepartmentMember(department.id, member.userId);
         await loadMembers();
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'غیرفعال‌سازی عضو ناموفق بود.');
      }
   }

   return (
      <Card className="border-white/8 bg-[#171719] text-zinc-100">
         <CardHeader className="border-b border-white/7">
            <div className="flex flex-wrap items-start justify-between gap-3">
               <div>
                  <CardTitle className="flex items-center gap-2 text-base">{department.name}<Badge variant="outline" className="border-white/10 font-mono text-[10px] text-zinc-500">{department.slug}</Badge></CardTitle>
                  <CardDescription className="mt-2 max-w-2xl leading-6 text-zinc-500">{department.description || 'برای این دپارتمان توضیحی ثبت نشده است.'}</CardDescription>
               </div>
               <div className="flex items-center gap-2">
                  <Badge variant="outline" className={department.active ? 'border-lime-400/20 bg-lime-400/8 text-lime-300' : 'border-white/10 text-zinc-500'}>{department.active ? 'فعال' : 'غیرفعال'}</Badge>
                  {canConfigure ? (
                     <Button className="border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10" size="sm" type="button" variant="secondary" onClick={() => setEditOpen(true)}>
                        <PencilLine className="size-3.5" /> ویرایش
                     </Button>
                  ) : null}
               </div>
            </div>
         </CardHeader>
         <CardContent className="space-y-4 p-4">
            <div className="rounded-lg border border-sky-400/10 bg-sky-400/[0.035] px-3 py-2.5 text-xs leading-6 text-sky-100/70">
               عضو عادی فقط پرونده‌های واگذارشده به خودش را می‌بیند. مدیر دپارتمان می‌تواند صف و پرونده‌های همین دپارتمان را مدیریت کند.
            </div>
            {error ? <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2.5 text-sm text-red-200">{error}</p> : null}
            {canConfigure ? (
               <form className="grid gap-2 rounded-lg border border-white/7 bg-black/10 p-3 sm:grid-cols-[minmax(0,1fr)_150px_auto]" onSubmit={addMember}>
                  <select aria-label="عضو فضای کاری" className={selectClass} value={userId} onChange={(event) => setUserId(event.target.value)}>
                     <option value="">انتخاب عضو فضای کاری</option>
                     {availableUsers.map((user) => <option key={user.id} value={user.id}>{user.name} — {user.email}</option>)}
                  </select>
                  <select aria-label="نقش دپارتمان" className={selectClass} value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
                     <option value="MEMBER">عضو</option>
                     <option value="MANAGER">مدیر دپارتمان</option>
                  </select>
                  <Button className="bg-zinc-100 text-zinc-950 hover:bg-white" disabled={!userId || submitting} type="submit">
                     {submitting ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />} افزودن
                  </Button>
               </form>
            ) : (
               <p className="rounded-lg border border-white/7 bg-black/10 px-3 py-2.5 text-xs leading-6 text-zinc-500">
                  فهرست اعضا برای هماهنگی صف نمایش داده می‌شود. افزودن، حذف و تغییر نقش اعضا فقط در اختیار مدیر فضای کاری است.
               </p>
            )}
            <div className="divide-y divide-white/6 overflow-hidden rounded-lg border border-white/7">
               {loading ? <LoadingLine label="در حال بارگذاری اعضا…" /> : null}
               {!loading && !members.length ? <p className="px-4 py-8 text-center text-sm text-zinc-600">عضوی در این دپارتمان نیست.</p> : null}
               {members.map((member) => (
                  <div key={member.id} className={cn('flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center', !member.active && 'opacity-55')}>
                     <LinearAvatar name={member.user?.name || member.userId} src={member.user?.avatarUrl} className="size-8 shrink-0" />
                     <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-zinc-200">{member.user?.name || member.userId}</div>
                        <div dir="ltr" className="truncate text-left text-xs text-zinc-600">{member.user?.email || ''}</div>
                     </div>
                     {canConfigure && member.active ? (
                        <select aria-label={`نقش ${member.user?.name || member.userId}`} className={cn(selectClass, 'sm:w-44')} value={member.role} onChange={(event) => void changeRole(member, event.target.value as 'MEMBER' | 'MANAGER')}>
                           <option value="MEMBER">عضو</option>
                           <option value="MANAGER">مدیر دپارتمان</option>
                        </select>
                     ) : <Badge variant="outline" className="w-fit border-white/10 text-zinc-500">{member.active ? memberRoleLabel(member.role) : 'غیرفعال'}</Badge>}
                     {canConfigure && member.active ? (
                        <Button aria-label={`حذف ${member.user?.name || member.userId}`} className="text-zinc-600 hover:bg-red-400/10 hover:text-red-300" size="icon" type="button" variant="ghost" onClick={() => void deactivate(member)}><Trash2 className="size-4" /></Button>
                     ) : null}
                  </div>
               ))}
            </div>
         </CardContent>
         {canConfigure ? <EditDepartmentDialog department={department} open={editOpen} onOpenChange={setEditOpen} /> : null}
      </Card>
   );
}

function EditDepartmentDialog({
   department,
   open,
   onOpenChange,
}: {
   department: SupportDepartment;
   open: boolean;
   onOpenChange: (open: boolean) => void;
}) {
   const support = useSupportWorkspace();
   const [name, setName] = useState(department.name);
   const [description, setDescription] = useState(department.description || '');
   const [active, setActive] = useState(department.active);
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   useEffect(() => {
      if (!open) return;
      setName(department.name);
      setDescription(department.description || '');
      setActive(department.active);
      setError('');
   }, [department.active, department.description, department.name, open]);

   async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!name.trim() || submitting) return;
      setSubmitting(true);
      setError('');
      try {
         await support.updateDepartment(department.id, {
            name: name.trim(),
            description: description.trim() || null,
            active,
         });
         onOpenChange(false);
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'ویرایش دپارتمان ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
         <DialogContent dir="rtl" className="border-white/10 bg-[#171719] text-zinc-100">
            <DialogHeader>
               <DialogTitle>ویرایش دپارتمان</DialogTitle>
               <DialogDescription className="leading-6 text-zinc-500">نام، توضیح و وضعیت عملیاتی دپارتمان را مدیریت کنید. شناسه کوتاه دپارتمان پس از ساخت تغییر نمی‌کند.</DialogDescription>
            </DialogHeader>
            <form className="grid gap-4" onSubmit={submit}>
               {error ? <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2.5 text-sm text-red-200">{error}</p> : null}
               <label className="grid gap-1.5 text-sm text-zinc-300">نام<Input className={inputClass} maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
               <label className="grid gap-1.5 text-sm text-zinc-300">توضیح<Textarea className={inputClass} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
               <label className="grid gap-1.5 text-sm text-zinc-300">وضعیت
                  <select className={selectClass} value={active ? 'ACTIVE' : 'INACTIVE'} onChange={(event) => setActive(event.target.value === 'ACTIVE')}>
                     <option value="ACTIVE">فعال</option>
                     <option value="INACTIVE">غیرفعال</option>
                  </select>
               </label>
               {!active && department.active ? <p className="rounded-lg border border-amber-400/15 bg-amber-400/[0.045] px-3 py-2.5 text-xs leading-6 text-amber-100/80">غیرفعال‌سازی فقط زمانی انجام می‌شود که دپارتمان هیچ پرونده بسته‌نشده‌ای نداشته باشد.</p> : null}
               <DialogFooter className="sm:flex-row-reverse sm:justify-start">
                  <Button className="bg-zinc-100 text-zinc-950 hover:bg-white" disabled={!name.trim() || submitting} type="submit">{submitting ? <Loader2 className="size-4 animate-spin" /> : null} ذخیره تغییرات</Button>
                  <Button disabled={submitting} type="button" variant="ghost" onClick={() => onOpenChange(false)}>انصراف</Button>
               </DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}

function PermissionGrantsCard({ grants, onAdd, users }: { grants: SupportPermissionGrant[]; onAdd: () => void; users: TaskaraUser[] }) {
   const support = useSupportWorkspace();
   const userById = useMemo(() => Object.fromEntries(users.map((user) => [user.id, user])), [users]);
   const [error, setError] = useState('');

   async function remove(grant: SupportPermissionGrant) {
      const name = grant.user?.name || userById[grant.userId]?.name || 'این کاربر';
      if (!window.confirm(`مجوز ${grantRoleLabel(grant.role)} از ${name} گرفته شود؟ دسترسی باز او فوراً بازنشانی می‌شود.`)) return;
      setError('');
      try {
         await support.removeGrant(grant.userId, grant.role);
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'حذف مجوز ناموفق بود.');
      }
   }

   return (
      <Card className="border-white/8 bg-[#171719] text-zinc-100">
         <CardHeader className="flex flex-row items-start justify-between gap-4 border-b border-white/7">
            <div>
               <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-4 text-indigo-300" /> مجوزهای سراسری پشتیبانی</CardTitle>
               <CardDescription className="mt-1.5 leading-6 text-zinc-500">تریاژ برای پرونده‌های بدون دپارتمان؛ سرپرست برای دید سراسری</CardDescription>
            </div>
            <Button className="border border-white/10 bg-white/6 text-zinc-300 hover:bg-white/10" type="button" variant="secondary" onClick={onAdd}><Plus className="size-4" /> افزودن مجوز</Button>
         </CardHeader>
         <CardContent className="p-0">
            {error ? <p role="alert" className="m-4 rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2.5 text-sm text-red-200">{error}</p> : null}
            {!grants.length ? <div className="px-4 py-10 text-center"><Users className="mx-auto size-6 text-zinc-600" /><p className="mt-3 text-sm text-zinc-600">مجوز سراسری ثبت نشده است.</p></div> : null}
            <div className="divide-y divide-white/6">
               {grants.map((grant) => {
                  const user = grant.user || userById[grant.userId];
                  return (
                     <div key={`${grant.userId}:${grant.role}`} className="flex items-center gap-3 px-4 py-3">
                        <LinearAvatar name={user?.name || grant.userId} src={user?.avatarUrl} className="size-8" />
                        <div className="min-w-0 flex-1"><div className="truncate text-sm text-zinc-200">{user?.name || grant.userId}</div><div dir="ltr" className="truncate text-left text-xs text-zinc-600">{user?.email || ''}</div></div>
                        <Badge variant="outline" className="border-indigo-400/20 bg-indigo-400/8 text-indigo-200">{grantRoleLabel(grant.role)}</Badge>
                        <Button aria-label={`حذف مجوز ${user?.name || grant.userId}`} className="text-zinc-600 hover:bg-red-400/10 hover:text-red-300" size="icon" type="button" variant="ghost" onClick={() => void remove(grant)}><Trash2 className="size-4" /></Button>
                     </div>
                  );
               })}
            </div>
         </CardContent>
      </Card>
   );
}

function CreateDepartmentDialog({ open, onCreated, onOpenChange }: { open: boolean; onCreated: (department: SupportDepartment) => void; onOpenChange: (open: boolean) => void }) {
   const support = useSupportWorkspace();
   const [form, setForm] = useState(emptyDepartmentForm);
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!form.name.trim() || !form.slug.trim()) return;
      setSubmitting(true);
      setError('');
      try {
         const department = await support.createDepartment({
            name: form.name.trim(),
            slug: form.slug.trim().toLowerCase(),
            description: form.description.trim() || undefined,
         });
         setForm(emptyDepartmentForm);
         onCreated(department);
         onOpenChange(false);
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'ساخت دپارتمان ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
         <DialogContent dir="rtl" className="border-white/10 bg-[#171719] text-zinc-100">
            <DialogHeader><DialogTitle>ساخت دپارتمان</DialogTitle><DialogDescription className="leading-6 text-zinc-500">هر دپارتمان یک مرز مستقل برای صف و دسترسی پرونده‌هاست.</DialogDescription></DialogHeader>
            <form className="space-y-4" onSubmit={submit}>
               {error ? <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2.5 text-sm text-red-200">{error}</p> : null}
               <Field label="نام دپارتمان"><Input autoFocus className={inputClass} maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
               <Field label="شناسه انگلیسی"><Input dir="ltr" className={cn(inputClass, 'text-left')} pattern="[a-z0-9-]{2,48}" placeholder="customer-success" value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value.toLowerCase() })} /></Field>
               <Field label="توضیح"><Textarea className={cn(inputClass, 'min-h-20')} maxLength={2000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
               <DialogFooter className="sm:flex-row-reverse sm:justify-start"><Button className="bg-zinc-100 text-zinc-950 hover:bg-white" disabled={!form.name.trim() || !form.slug.trim() || submitting} type="submit">{submitting ? <Loader2 className="size-4 animate-spin" /> : null} ساخت دپارتمان</Button><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>انصراف</Button></DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}

function GrantDialog({ open, onOpenChange, users }: { open: boolean; onOpenChange: (open: boolean) => void; users: TaskaraUser[] }) {
   const support = useSupportWorkspace();
   const [userId, setUserId] = useState('');
   const [role, setRole] = useState<'TRIAGER' | 'SUPERVISOR'>('TRIAGER');
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!userId) return;
      setSubmitting(true);
      setError('');
      try {
         await support.setGrant({ userId, role });
         setUserId('');
         setRole('TRIAGER');
         onOpenChange(false);
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'ثبت مجوز ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
         <DialogContent dir="rtl" className="border-white/10 bg-[#171719] text-zinc-100">
            <DialogHeader><DialogTitle>افزودن مجوز پشتیبانی</DialogTitle><DialogDescription className="leading-6 text-zinc-500">این مجوز مستقل از عضویت دپارتمان است.</DialogDescription></DialogHeader>
            <form className="space-y-4" onSubmit={submit}>
               {error ? <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2.5 text-sm text-red-200">{error}</p> : null}
               <Field label="کاربر"><select className={selectClass} value={userId} onChange={(event) => setUserId(event.target.value)}><option value="">انتخاب کاربر</option>{users.map((user) => <option key={user.id} value={user.id}>{user.name} — {user.email}</option>)}</select></Field>
               <Field label="مجوز"><select className={selectClass} value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="TRIAGER">تریاژ</option><option value="SUPERVISOR">سرپرست پشتیبانی</option></select></Field>
               <DialogFooter className="sm:flex-row-reverse sm:justify-start"><Button className="bg-zinc-100 text-zinc-950 hover:bg-white" disabled={!userId || submitting} type="submit">{submitting ? <Loader2 className="size-4 animate-spin" /> : null} ثبت مجوز</Button><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>انصراف</Button></DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
   return <label className="grid gap-1.5 text-sm text-zinc-300"><span>{label}</span>{children}</label>;
}

function LoadingLine({ label }: { label: string }) {
   return <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-zinc-600"><Loader2 className="size-4 animate-spin" /> {label}</div>;
}

function grantRoleLabel(role: SupportPermissionGrant['role']) {
   return role === 'TRIAGER' ? 'تریاژ' : 'سرپرست';
}

function memberRoleLabel(role: SupportDepartmentMember['role']) {
   return role === 'MANAGER' ? 'مدیر دپارتمان' : 'عضو';
}

const inputClass = 'border-white/10 bg-[#0c0c0e] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/20';
const selectClass = 'h-9 w-full rounded-md border border-white/10 bg-[#0c0c0e] px-3 text-sm text-zinc-200 outline-none focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/20';
