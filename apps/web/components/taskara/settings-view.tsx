'use client';

import { type ChangeEvent, type ComponentType, type FormEvent, type ReactNode, useEffect, useState, useTransition } from 'react';
import {
   ArrowRight,
   Building2,
   FolderKanban,
   ImageOff,
   Loader2,
   Save,
   Trash2,
   Upload,
   UserRound,
   UsersRound,
} from 'lucide-react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { MembersView } from '@/components/taskara/members-view';
import { ProjectsView } from '@/components/taskara/projects-view';
import { TeamsView } from '@/components/taskara/teams-view';
import { LinearAvatar } from '@/components/taskara/linear-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { taskaraRequest, uploadMedia } from '@/lib/taskara-client';
import { formatJalaliDateTime } from '@/lib/jalali';
import { RoleBadge, workspaceRoles } from '@/lib/taskara-presenters';
import type { PaginatedResponse, TaskaraMe, TaskaraUser } from '@/lib/taskara-types';
import { fa } from '@/lib/fa-copy';
import { cn } from '@/lib/utils';
import { getAuthSession, setAuthSession } from '@/store/auth-store';

const settingsSections = ['profile', 'workspace', 'members', 'teams', 'projects'] as const;
type SettingsSection = (typeof settingsSections)[number];
type SettingsIcon = ComponentType<{ className?: string }>;

const initialUserForm = {
   name: '',
   email: '',
   phone: '',
   role: 'MEMBER',
   mattermostUsername: '',
};

const initialProfileForm = {
   name: '',
   phone: '',
   avatarUrl: '',
   mattermostUsername: '',
};

const inputClassName =
   'border-white/10 bg-[#111113] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/25';
const selectClassName =
   'flex h-9 w-full rounded-md border border-white/10 bg-[#111113] px-3 text-sm text-zinc-200 outline-none transition focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/25 disabled:cursor-not-allowed disabled:opacity-55';

function isSettingsSection(value?: string): value is SettingsSection {
   return settingsSections.includes(value as SettingsSection);
}

export function SettingsView() {
   const { orgId = 'taskara' } = useParams();
   const location = useLocation();
   const pathParts = location.pathname.split('/').filter(Boolean);
   const requestedSection = pathParts[2];

   if (!requestedSection) {
      return <Navigate replace to={`/${orgId}/settings/profile`} />;
   }

   if (!isSettingsSection(requestedSection)) {
      return <Navigate replace to={`/${orgId}/settings/profile`} />;
   }

   return (
      <SettingsChrome activeSection={requestedSection} orgId={orgId}>
         {requestedSection === 'profile' ? <ProfileSettingsPage /> : null}
         {requestedSection === 'workspace' ? <WorkspaceAccessSettingsPage /> : null}
         {requestedSection === 'members' ? <EmbeddedExistingRoute><MembersView /></EmbeddedExistingRoute> : null}
         {requestedSection === 'teams' ? <EmbeddedExistingRoute><TeamsView /></EmbeddedExistingRoute> : null}
         {requestedSection === 'projects' ? <EmbeddedExistingRoute><ProjectsView /></EmbeddedExistingRoute> : null}
      </SettingsChrome>
   );
}

function SettingsChrome({
   activeSection,
   children,
   orgId,
}: {
   activeSection: SettingsSection;
   children: ReactNode;
   orgId: string;
}) {
   const navGroups: Array<{ title: string; items: Array<{ title: string; to: string; icon: SettingsIcon; section: SettingsSection }> }> = [
      {
         title: 'تنظیمات فردی',
         items: [
            { title: 'پروفایل', to: `/${orgId}/settings/profile`, icon: UserRound, section: 'profile' },
         ],
      },
      {
         title: 'مدیریت',
         items: [
            { title: 'فضای کاری', to: `/${orgId}/settings/workspace`, icon: Building2, section: 'workspace' },
            { title: 'اعضا', to: `/${orgId}/settings/members`, icon: UsersRound, section: 'members' },
            { title: 'تیم‌ها', to: `/${orgId}/settings/teams`, icon: UsersRound, section: 'teams' },
            { title: 'پروژه‌ها', to: `/${orgId}/settings/projects`, icon: FolderKanban, section: 'projects' },
         ],
      },
   ];

   return (
      <div dir="rtl" className="flex h-full min-h-0 flex-col bg-[#101011] text-zinc-200 lg:flex-row">
         <aside className="flex w-full shrink-0 flex-col border-b border-white/8 bg-[#09090a] px-3 py-3 lg:min-h-full lg:w-[280px] lg:border-b-0 lg:border-l lg:border-r-0">
            <Link
               className="mb-5 inline-flex h-8 w-fit items-center gap-2 rounded-md px-2 text-sm font-medium text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
               to={`/${orgId}/team/all/all`}
            >
               <ArrowRight className="size-4" />
               بازگشت به برنامه
            </Link>

            <nav className="flex min-w-0 gap-4 overflow-x-auto pb-1 lg:block lg:space-y-4 lg:overflow-visible lg:pb-0">
               {navGroups.map((group) => (
                  <div key={group.title} className="min-w-[190px] lg:min-w-0">
                     <div className="mb-2 px-2 text-[13px] font-medium text-zinc-500">{group.title}</div>
                     <div className="space-y-1">
                        {group.items.map((item) => {
                           const Icon = item.icon;
                           const active = item.section === activeSection;

                           return (
                              <Link
                                 key={item.to}
                                 className={cn(
                                    'flex h-8 items-center gap-2 rounded-md px-2 text-sm font-medium transition',
                                    active
                                       ? 'bg-white/8 text-zinc-100'
                                       : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-200'
                                 )}
                                 to={item.to}
                              >
                                 <Icon className="size-4 shrink-0" />
                                 <span className="truncate">{item.title}</span>
                              </Link>
                           );
                        })}
                     </div>
                  </div>
               ))}
            </nav>
         </aside>

         <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
   );
}

function EmbeddedExistingRoute({ children }: { children: ReactNode }) {
   return <div dir="rtl" className="min-h-full bg-[#101011]">{children}</div>;
}

function ProfileSettingsPage() {
   const [me, setMe] = useState<TaskaraMe | null>(null);
   const [form, setForm] = useState(initialProfileForm);
   const [loading, setLoading] = useState(true);
   const [saving, setSaving] = useState(false);
   const [uploading, setUploading] = useState(false);
   const [error, setError] = useState('');
   const [notice, setNotice] = useState('');

   useEffect(() => {
      let cancelled = false;

      void (async () => {
         setError('');
         try {
            const result = await taskaraRequest<TaskaraMe>('/me');
            if (cancelled) return;

            setMe(result);
            setForm({
               name: result.user.name || '',
               phone: result.user.phone || '',
               avatarUrl: result.user.avatarUrl || '',
               mattermostUsername: result.user.mattermostUsername || '',
            });
         } catch (err) {
            if (!cancelled) setError(err instanceof Error ? err.message : 'بارگذاری پروفایل ناموفق بود.');
         } finally {
            if (!cancelled) setLoading(false);
         }
      })();

      return () => {
         cancelled = true;
      };
   }, []);

   async function handleAvatarUpload(event: ChangeEvent<HTMLInputElement>) {
      const file = event.target.files?.[0];
      event.target.value = '';
      setNotice('');

      if (!file) return;
      if (!file.type.startsWith('image/')) {
         setError('یک فایل تصویر انتخاب کنید.');
         return;
      }
      if (file.size > 5 * 1024 * 1024) {
         setError('تصویر پروفایل باید ۵ مگابایت یا کمتر باشد.');
         return;
      }

      setUploading(true);
      setError('');
      try {
         const media = await uploadMedia(file, `${me?.user.id || 'profile'}-avatar`);
         setForm((current) => ({ ...current, avatarUrl: media.url }));
         setNotice('تصویر بارگذاری شد. برای استفاده در پروفایل، تغییرات را ذخیره کنید.');
      } catch (err) {
         setError(err instanceof Error ? err.message : 'بارگذاری تصویر پروفایل ناموفق بود.');
      } finally {
         setUploading(false);
      }
   }

   async function handleProfileSave(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!form.name.trim()) {
         setError('نام کامل الزامی است.');
         return;
      }

      setSaving(true);
      setError('');
      setNotice('');
      try {
         const result = await taskaraRequest<TaskaraMe>('/me', {
            method: 'PATCH',
            body: JSON.stringify({
               name: form.name.trim(),
               phone: form.phone.trim() || null,
               avatarUrl: form.avatarUrl.trim() || null,
               mattermostUsername: form.mattermostUsername.trim() || null,
            }),
         });

         setMe(result);
         setForm({
            name: result.user.name || '',
            phone: result.user.phone || '',
            avatarUrl: result.user.avatarUrl || '',
            mattermostUsername: result.user.mattermostUsername || '',
         });
         const session = getAuthSession();
         if (session) {
            setAuthSession({
               ...session,
               role: result.role,
               user: result.user,
               workspace: result.workspace,
            });
         }
         setNotice('پروفایل به‌روزرسانی شد.');
         window.dispatchEvent(new CustomEvent('taskara:teams-updated'));
      } catch (err) {
         setError(err instanceof Error ? err.message : 'به‌روزرسانی پروفایل ناموفق بود.');
      } finally {
         setSaving(false);
      }
   }

   return (
      <div className="mx-auto w-full max-w-[900px] px-5 py-6 sm:px-7 lg:py-10">
         <SettingsPageTitle title="پروفایل" />

         {error ? <SettingsMessage tone="error">{error}</SettingsMessage> : null}
         {notice ? <SettingsMessage tone="success">{notice}</SettingsMessage> : null}

         <form className="space-y-4" onSubmit={handleProfileSave}>
            <SettingsPanel title="تصویر پروفایل">
               <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-4">
                     <LinearAvatar name={form.name || me?.user.name} src={form.avatarUrl.trim() || null} className="size-10 text-sm" />
                     <div className="min-w-0">
                        <div className="text-sm font-medium text-zinc-200">{form.name || me?.user.name || 'پروفایل شما'}</div>
                        <div className="mt-1 truncate text-xs text-zinc-500">{me?.user.email || (loading ? fa.app.loading : 'بدون ایمیل')}</div>
                     </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                     <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 text-sm font-medium text-zinc-200 transition hover:bg-white/8">
                        {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                        بارگذاری
                        <input
                           accept="image/*"
                           className="sr-only"
                           disabled={uploading}
                           type="file"
                           onChange={(event) => void handleAvatarUpload(event)}
                        />
                     </label>
                     <Button
                        className="h-8 border-white/10 bg-transparent text-zinc-400 hover:bg-white/6 hover:text-zinc-100"
                        disabled={!form.avatarUrl || uploading}
                        size="sm"
                        type="button"
                        variant="outline"
                        onClick={() => setForm((current) => ({ ...current, avatarUrl: '' }))}
                     >
                        <ImageOff className="size-4" />
                        حذف
                     </Button>
                  </div>
               </div>
               <SettingsField label="نشانی تصویر" description="از نشانی تصویر میزبانی‌شده استفاده کنید یا تصویر جدیدی بارگذاری کنید.">
                  <Input
                     className={cn(inputClassName, 'ltr')}
                     placeholder="Avatar URL"
                     type="url"
                     value={form.avatarUrl}
                     onChange={(event) => setForm((current) => ({ ...current, avatarUrl: event.target.value }))}
                  />
               </SettingsField>
            </SettingsPanel>

            <SettingsPanel title="حساب کاربری">
               <SettingsField label="ایمیل">
                  <Input className={cn(inputClassName, 'ltr text-zinc-500')} readOnly value={me?.user.email || ''} />
               </SettingsField>
               <SettingsField label="نام کامل">
                  <Input
                     className={inputClassName}
                     disabled={loading}
                     value={form.name}
                     onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  />
               </SettingsField>
               <SettingsField label={fa.settings.phone} description="برای ارسال پیامک‌های یادآوری و کارهای سپرده‌شده.">
                  <Input
                     className={cn(inputClassName, 'ltr')}
                     disabled={loading}
                     inputMode="tel"
                     placeholder="09123456789"
                     value={form.phone}
                     onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))}
                  />
               </SettingsField>
               <SettingsField label="نام کاربری مترموست" description="یک کلمه، مثل نام کوتاه یا نام کوچک.">
                  <Input
                     className={cn(inputClassName, 'ltr')}
                     disabled={loading}
                     placeholder="moein.danesh97"
                     value={form.mattermostUsername}
                     onChange={(event) => setForm((current) => ({ ...current, mattermostUsername: event.target.value }))}
                  />
               </SettingsField>
            </SettingsPanel>

            <div className="flex justify-end">
               <Button
                  className="h-9 border border-white/10 bg-zinc-100 px-4 text-zinc-950 hover:bg-white"
                  disabled={saving || uploading || loading}
                  type="submit"
               >
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  ذخیره تغییرات
               </Button>
            </div>
         </form>
      </div>
   );
}

function WorkspaceAccessSettingsPage() {
   const [me, setMe] = useState<TaskaraMe | null>(null);
   const [users, setUsers] = useState<TaskaraUser[]>([]);
   const [form, setForm] = useState(initialUserForm);
   const [error, setError] = useState('');
   const [loading, setLoading] = useState(true);
   const [isPending, startTransition] = useTransition();
   const isWorkspaceAdmin = me?.role === 'OWNER' || me?.role === 'ADMIN';
   const roleOptions = me?.role === 'OWNER' ? workspaceRoles : workspaceRoles.filter((role) => role !== 'OWNER');

   async function load() {
      setError('');
      try {
         const [meResult, usersResult] = await Promise.all([
            taskaraRequest<TaskaraMe>('/me'),
            taskaraRequest<PaginatedResponse<TaskaraUser>>('/users?limit=100'),
         ]);
         setMe(meResult);
         setUsers(usersResult.items);
      } catch (err) {
         setError(err instanceof Error ? err.message : fa.settings.loadFailed);
      } finally {
         setLoading(false);
      }
   }

   useEffect(() => {
      void load();
   }, []);

   async function handleCreateUser(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!form.name.trim() || !form.email.trim()) return;

      try {
         await taskaraRequest('/users', {
            method: 'POST',
            body: JSON.stringify({
               name: form.name.trim(),
               email: form.email.trim(),
               phone: form.phone.trim() || undefined,
               role: form.role,
               mattermostUsername: form.mattermostUsername.trim() || undefined,
            }),
         });
         setForm(initialUserForm);
         startTransition(() => {
            void load();
         });
      } catch (err) {
         setError(err instanceof Error ? err.message : fa.settings.createFailed);
      }
   }

   async function handleRoleChange(userId: string, role: string) {
      try {
         await taskaraRequest(`/users/${userId}/role`, {
            method: 'PATCH',
            body: JSON.stringify({ role }),
         });
         startTransition(() => {
            void load();
         });
      } catch (err) {
         setError(err instanceof Error ? err.message : fa.settings.roleUpdateFailed);
      }
   }

   async function handleRemoveMembership(user: TaskaraUser) {
      if (!window.confirm(`${user.name} از فضای کاری حذف شود؟`)) return;

      try {
         await taskaraRequest(`/users/${user.id}/membership`, {
            method: 'DELETE',
         });
         startTransition(() => {
            void load();
         });
      } catch (err) {
         setError(err instanceof Error ? err.message : 'حذف دسترسی کاربر ناموفق بود.');
      }
   }

   return (
      <div className="mx-auto w-full max-w-[1180px] px-5 py-6 sm:px-7 lg:py-10">
         <SettingsPageTitle title="فضای کاری" />

         {error ? <SettingsMessage tone="error">{error}</SettingsMessage> : null}

         <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
            <div className="space-y-4">
               <SettingsPanel title="نمای کلی">
                  <InfoRows>
                     {loading || !me ? (
                        <div className="px-5 py-4 text-sm text-zinc-500">{fa.app.loading}</div>
                     ) : (
                        <>
                           <InfoRow label="فضای کاری" value={me.workspace.name} detail={me.workspace.slug} />
                           <InfoRow label="کاربر فعلی" value={me.user.name} detail={me.user.email} />
                           <InfoRow label="اعلان خوانده‌نشده" value={me.unreadNotifications.toLocaleString('fa-IR')} />
                        </>
                     )}
                  </InfoRows>
               </SettingsPanel>

               {isWorkspaceAdmin ? (
                  <SettingsPanel title={fa.settings.createUser}>
                     <form className="space-y-3 px-4 py-4" onSubmit={handleCreateUser}>
                        <label className="grid gap-2 text-sm text-zinc-300">
                           <span>{fa.settings.name}</span>
                           <Input
                              className={inputClassName}
                              value={form.name}
                              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                              placeholder={fa.settings.name}
                           />
                        </label>
                        <label className="grid gap-2 text-sm text-zinc-300">
                           <span>{fa.settings.email}</span>
                           <Input
                              className={cn(inputClassName, 'ltr')}
                              value={form.email}
                              onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                              placeholder="sara@example.com"
                           />
                        </label>
                        <label className="grid gap-2 text-sm text-zinc-300">
                           <span>{fa.settings.phone}</span>
                           <Input
                              className={cn(inputClassName, 'ltr')}
                              inputMode="tel"
                              value={form.phone}
                              onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))}
                              placeholder="09123456789"
                           />
                        </label>
                        <label className="grid gap-2 text-sm text-zinc-300">
                           <span>{fa.settings.mattermostUsername}</span>
                           <Input
                              className={cn(inputClassName, 'ltr')}
                              value={form.mattermostUsername}
                              onChange={(event) => setForm((current) => ({ ...current, mattermostUsername: event.target.value }))}
                              placeholder="sara"
                           />
                        </label>
                        <label className="grid gap-2 text-sm text-zinc-300">
                           <span>{fa.settings.role}</span>
                           <select
                              className={selectClassName}
                              value={form.role}
                              onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}
                           >
                              {roleOptions.map((role) => (
                                 <option key={role} value={role}>
                                    {fa.role[role]}
                                 </option>
                              ))}
                           </select>
                        </label>
                        <Button className="w-full border border-white/10 bg-zinc-100 text-zinc-950 hover:bg-white" disabled={isPending}>
                           {isPending ? fa.settings.creating : fa.settings.createUser}
                        </Button>
                     </form>
                  </SettingsPanel>
               ) : null}
            </div>

            <SettingsPanel title={fa.settings.accessManagement}>
               <div className="overflow-x-auto px-1 pb-1">
                  <Table>
                     <TableHeader>
                        <TableRow className="border-white/8 hover:bg-transparent">
                           <TableHead className="text-right text-zinc-500">{fa.table.user}</TableHead>
                           <TableHead className="text-right text-zinc-500">{fa.table.role}</TableHead>
                           <TableHead className="text-right text-zinc-500">{fa.table.phone}</TableHead>
                           <TableHead className="text-right text-zinc-500">{fa.table.mattermost}</TableHead>
                           <TableHead className="text-right text-zinc-500">{fa.table.joinedAt}</TableHead>
                           <TableHead className="text-right text-zinc-500">{fa.table.changeRole}</TableHead>
                           <TableHead className="text-right text-zinc-500">{fa.app.more}</TableHead>
                        </TableRow>
                     </TableHeader>
                     <TableBody>
                        {loading ? (
                           <TableRow className="border-white/8">
                              <TableCell colSpan={7} className="py-10 text-center text-zinc-500">{fa.app.loading}</TableCell>
                           </TableRow>
                        ) : users.length === 0 ? (
                           <TableRow className="border-white/8">
                              <TableCell colSpan={7} className="py-10 text-center text-zinc-500">{fa.settings.noUsers}</TableCell>
                           </TableRow>
                        ) : (
                           users.map((user) => {
                              const userRoleOptions = user.role === 'OWNER' && !roleOptions.includes('OWNER')
                                 ? ['OWNER' as const, ...roleOptions]
                                 : roleOptions;
                              const ownerLocked = user.role === 'OWNER' && me?.role !== 'OWNER';

                              return (
                                 <TableRow key={user.id} className="border-white/8 hover:bg-white/[0.025]">
                                    <TableCell>
                                       <div className="flex min-w-[220px] items-center gap-3">
                                          <LinearAvatar name={user.name} src={user.avatarUrl} className="size-7" />
                                          <div className="min-w-0 space-y-1">
                                             <div className="truncate font-medium text-zinc-200">{user.name}</div>
                                             <div className="ltr truncate text-xs text-zinc-500">{user.email}</div>
                                          </div>
                                       </div>
                                    </TableCell>
                                    <TableCell><RoleBadge role={user.role} /></TableCell>
                                    <TableCell className="ltr text-zinc-400">{user.phone || '-'}</TableCell>
                                    <TableCell className="ltr text-zinc-400">{user.mattermostUsername ? `@${user.mattermostUsername}` : '-'}</TableCell>
                                    <TableCell className="text-zinc-400">{formatJalaliDateTime(user.joinedAt)}</TableCell>
                                    <TableCell>
                                       <select
                                          className={cn(selectClassName, 'min-w-28')}
                                          value={user.role}
                                          disabled={!isWorkspaceAdmin || ownerLocked}
                                          onChange={(event) => void handleRoleChange(user.id, event.target.value)}
                                       >
                                          {userRoleOptions.map((role) => (
                                             <option key={role} value={role}>
                                                {fa.role[role]}
                                             </option>
                                          ))}
                                       </select>
                                    </TableCell>
                                    <TableCell>
                                       <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon"
                                          disabled={!isWorkspaceAdmin || ownerLocked}
                                          aria-label={`حذف ${user.name}`}
                                          className="size-8 text-zinc-500 hover:bg-red-500/10 hover:text-red-300"
                                          onClick={() => void handleRemoveMembership(user)}
                                       >
                                          <Trash2 className="size-4" />
                                       </Button>
                                    </TableCell>
                                 </TableRow>
                              );
                           })
                        )}
                     </TableBody>
                  </Table>
               </div>
            </SettingsPanel>
         </div>
      </div>
   );
}

function SettingsPageTitle({ title }: { title: string }) {
   return (
      <div className="mb-5 flex items-center gap-3">
         <h1 className="text-xl font-semibold tracking-normal text-zinc-100">{title}</h1>
      </div>
   );
}

function SettingsPanel({
   children,
   title,
}: {
   children: ReactNode;
   title: ReactNode;
}) {
   return (
      <section className="overflow-hidden rounded-lg border border-white/8 bg-[#19191b] shadow-sm">
         <div className="border-b border-white/7 px-4 py-2.5 text-sm font-semibold text-zinc-200">{title}</div>
         {children}
      </section>
   );
}

function SettingsField({
   children,
   description,
   label,
}: {
   children: ReactNode;
   description?: ReactNode;
   label: ReactNode;
}) {
   return (
      <div className="grid gap-3 border-t border-white/7 px-4 py-3 first:border-t-0 sm:grid-cols-[200px_minmax(0,1fr)] sm:items-center">
         <div className="min-w-0">
            <div className="text-sm font-medium text-zinc-300">{label}</div>
            {description ? <div className="mt-1 text-sm text-zinc-500">{description}</div> : null}
         </div>
         <div className="min-w-0">{children}</div>
      </div>
   );
}

function SettingsMessage({ children, tone }: { children: ReactNode; tone: 'error' | 'success' }) {
   return (
      <div
         className={cn(
            'mb-5 rounded-lg border px-4 py-3 text-sm',
            tone === 'error'
               ? 'border-red-400/20 bg-red-400/10 text-red-200'
               : 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
         )}
      >
         {children}
      </div>
   );
}

function InfoRows({ children }: { children: ReactNode }) {
   return <div className="divide-y divide-white/7">{children}</div>;
}

function InfoRow({ detail, label, value }: { detail?: ReactNode; label: ReactNode; value: ReactNode }) {
   return (
      <div className="px-4 py-3">
         <div className="text-xs font-medium uppercase text-zinc-600">{label}</div>
         <div className="mt-1 truncate text-sm font-medium text-zinc-200">{value}</div>
         {detail ? <div className="ltr mt-1 truncate text-xs text-zinc-500">{detail}</div> : null}
      </div>
   );
}
