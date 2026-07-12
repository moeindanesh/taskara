'use client';

import { type ChangeEvent, type ComponentType, type FormEvent, type ReactNode, useEffect, useRef, useState, useTransition } from 'react';
import {
   ArrowRight,
   Bot,
   Building2,
   Download,
   ExternalLink,
   FolderKanban,
   ImageOff,
   GitMerge,
   Loader2,
   Save,
   Type,
   Trash2,
   Upload,
   UserRound,
   UsersRound,
} from 'lucide-react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { useAppearance } from '@/components/layout/appearance-provider';
import { MembersView } from '@/components/taskara/members-view';
import { ProjectsView } from '@/components/taskara/projects-view';
import { TeamsView } from '@/components/taskara/teams-view';
import { LinearAvatar } from '@/components/taskara/linear-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { taskaraRequest, uploadMedia } from '@/lib/taskara-client';
import { downloadTaskaraFile } from '@/lib/download-file';
import { formatJalaliDateTime } from '@/lib/jalali';
import { RoleBadge, workspaceRoles } from '@/lib/taskara-presenters';
import type { PaginatedResponse, TaskaraMe, TaskaraProject, TaskaraUser } from '@/lib/taskara-types';
import { fa } from '@/lib/fa-copy';
import { cn } from '@/lib/utils';
import { getAuthSession, setAuthSession } from '@/store/auth-store';
import { EMPTY_SELECT_VALUE, fromSelectValue, toSelectValue } from '@/lib/select-utils';

const settingsSections = ['profile', 'appearance', 'workspace', 'ai', 'members', 'teams', 'projects'] as const;
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

type AiSettingsResponse = {
   hasApiKey: boolean;
   maskedKey: string | null;
   updatedAt: string | null;
   defaultContext: string | null;
   usage: {
      totalRequests: number;
      totalPromptTokens: number;
      totalCompletionTokens: number;
      totalTokens: number;
      totalCostUsd: number;
      costedRequests: number;
      lastRequestAt: string | null;
   };
};

type AiSettingsTestResponse = {
   ok: boolean;
   provider: 'OPENROUTER';
   model: string;
   latencyMs: number;
   responsePreview: string;
};

const inputClassName =
   'border-white/10 bg-[#111113] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/25';
const selectClassName =
   'flex h-9 w-full rounded-md border border-white/10 bg-[#111113] px-3 text-sm text-zinc-200 outline-none transition focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/25 disabled:cursor-not-allowed disabled:opacity-55';
const aiModelOptions = ['x-ai/grok-4.1-fast', 'deepseek/deepseek-v4-flash'] as const;
const defaultAiModel = aiModelOptions[0];
const menubarReleasesUrl = 'https://github.com/moltycool/taskara/releases';

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
         {requestedSection === 'appearance' ? <AppearanceSettingsPage /> : null}
         {requestedSection === 'workspace' ? <WorkspaceAccessSettingsPage /> : null}
         {requestedSection === 'ai' ? <AiSettingsPage /> : null}
         {requestedSection === 'members' ? <EmbeddedExistingRoute><MembersView /></EmbeddedExistingRoute> : null}
         {requestedSection === 'teams' ? <EmbeddedExistingRoute><TeamsView /></EmbeddedExistingRoute> : null}
         {requestedSection === 'projects' ? <ProjectsSettingsPage /> : null}
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
   const role = getAuthSession()?.role;
   const appHome = role === 'OWNER' || role === 'ADMIN' ? `/${orgId}/cockpit` : `/${orgId}/team/all/all`;
   const navGroups: Array<{ title: string; items: Array<{ title: string; to: string; icon: SettingsIcon; section: SettingsSection }> }> = [
      {
         title: 'تنظیمات فردی',
         items: [
            { title: 'پروفایل', to: `/${orgId}/settings/profile`, icon: UserRound, section: 'profile' },
            { title: 'فونت و اندازه', to: `/${orgId}/settings/appearance`, icon: Type, section: 'appearance' },
         ],
      },
      {
         title: 'مدیریت',
         items: [
            { title: 'فضای کاری', to: `/${orgId}/settings/workspace`, icon: Building2, section: 'workspace' },
            { title: 'هوش مصنوعی', to: `/${orgId}/settings/ai`, icon: Bot, section: 'ai' },
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
               to={appHome}
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

type MergeProjectsResponse = {
   project: { id: string; name: string; keyPrefix: string };
   mergedProjectIds: string[];
   moved: { tasks: number; milestones: number; members: number };
};

function ProjectsSettingsPage() {
   const [me, setMe] = useState<TaskaraMe | null>(null);
   const [projects, setProjects] = useState<TaskaraProject[]>([]);
   const [destinationProjectId, setDestinationProjectId] = useState('');
   const [sourceProjectIds, setSourceProjectIds] = useState<string[]>([]);
   const [loading, setLoading] = useState(true);
   const [merging, setMerging] = useState(false);
   const [error, setError] = useState('');
   const [notice, setNotice] = useState('');
   const [projectsViewKey, setProjectsViewKey] = useState(0);
   const isWorkspaceAdmin = me?.role === 'OWNER' || me?.role === 'ADMIN';

   async function loadMergeOptions() {
      setLoading(true);
      setError('');
      try {
         const [meResult, projectResult] = await Promise.all([
            taskaraRequest<TaskaraMe>('/me'),
            taskaraRequest<TaskaraProject[]>('/projects'),
         ]);
         setMe(meResult);
         setProjects(projectResult);
         setDestinationProjectId((current) => projectResult.some((project) => project.id === current) ? current : '');
         setSourceProjectIds((current) => current.filter((id) => projectResult.some((project) => project.id === id)));
      } catch (err) {
         setError(err instanceof Error ? err.message : 'بارگذاری پروژه‌ها ناموفق بود.');
      } finally {
         setLoading(false);
      }
   }

   useEffect(() => {
      void loadMergeOptions();
   }, []);

   function toggleSourceProject(projectId: string) {
      setSourceProjectIds((current) =>
         current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId]
      );
   }

   async function handleMergeProjects() {
      if (!destinationProjectId || sourceProjectIds.length === 0 || !isWorkspaceAdmin) return;
      const destination = projects.find((project) => project.id === destinationProjectId);
      const sources = projects.filter((project) => sourceProjectIds.includes(project.id));
      const confirmed = window.confirm(
         `${sources.map((project) => project.name).join('، ')} در «${destination?.name || ''}» ادغام شوند؟ پروژه‌های مبدأ پس از انتقال اطلاعات حذف می‌شوند و این عملیات قابل بازگشت نیست.`
      );
      if (!confirmed) return;

      setMerging(true);
      setError('');
      setNotice('');
      try {
         const result = await taskaraRequest<MergeProjectsResponse>('/projects/merge', {
            method: 'POST',
            body: JSON.stringify({ destinationProjectId, sourceProjectIds }),
         });
         setNotice(
            `${result.mergedProjectIds.length.toLocaleString('fa-IR')} پروژه در «${result.project.name}» ادغام شد؛ ${result.moved.tasks.toLocaleString('fa-IR')} تسک و ${result.moved.milestones.toLocaleString('fa-IR')} گام منتقل شد.`
         );
         setDestinationProjectId('');
         setSourceProjectIds([]);
         await loadMergeOptions();
         setProjectsViewKey((current) => current + 1);
      } catch (err) {
         setError(err instanceof Error ? err.message : 'ادغام پروژه‌ها ناموفق بود.');
      } finally {
         setMerging(false);
      }
   }

   const sourceOptions = projects.filter((project) => project.id !== destinationProjectId);

   return (
      <div dir="rtl" className="flex min-h-full flex-col bg-[#101011]">
         <div className="mx-auto w-full max-w-[1180px] px-5 py-6 sm:px-7 lg:py-10">
            <SettingsPageTitle title="پروژه‌ها" />
            {error ? <SettingsMessage tone="error">{error}</SettingsMessage> : null}
            {notice ? <SettingsMessage tone="success">{notice}</SettingsMessage> : null}

            <SettingsPanel title={<span className="inline-flex items-center gap-2"><GitMerge className="size-4" />ادغام پروژه‌ها</span>}>
               <SettingsField
                  label="پروژه مقصد"
                  description="این پروژه باقی می‌ماند و همه اطلاعات پروژه‌های مبدأ را دریافت می‌کند."
               >
                  <Select
                     disabled={loading || merging || !isWorkspaceAdmin}
                     value={destinationProjectId}
                     onValueChange={(projectId) => {
                        setDestinationProjectId(projectId);
                        setSourceProjectIds((current) => current.filter((id) => id !== projectId));
                     }}
                  >
                     <SelectTrigger className={selectClassName}>
                        <SelectValue placeholder="انتخاب پروژه مقصد" />
                     </SelectTrigger>
                     <SelectContent className="border-white/10 bg-[#202023] text-zinc-100">
                        {projects.map((project) => (
                           <SelectItem key={project.id} value={project.id}>
                              {project.name} ({project.keyPrefix})
                           </SelectItem>
                        ))}
                     </SelectContent>
                  </Select>
               </SettingsField>

               <SettingsField
                  className="sm:items-start"
                  label="پروژه‌های مبدأ"
                  description="یک یا چند پروژه را برای انتقال کامل اطلاعات و حذف پس از ادغام انتخاب کنید."
               >
                  {!destinationProjectId ? (
                     <div className="rounded-md border border-dashed border-white/10 px-3 py-4 text-sm text-zinc-500">
                        ابتدا پروژه مقصد را انتخاب کنید.
                     </div>
                  ) : sourceOptions.length === 0 ? (
                     <div className="rounded-md border border-dashed border-white/10 px-3 py-4 text-sm text-zinc-500">
                        پروژه دیگری برای ادغام وجود ندارد.
                     </div>
                  ) : (
                     <div className="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
                        {sourceOptions.map((project) => {
                           const checked = sourceProjectIds.includes(project.id);
                           return (
                              <label
                                 key={project.id}
                                 className={cn(
                                    'flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 text-sm transition',
                                    checked ? 'border-indigo-400/35 bg-indigo-400/10 text-zinc-100' : 'border-white/8 bg-black/15 text-zinc-400 hover:bg-white/5'
                                 )}
                              >
                                 <input
                                    checked={checked}
                                    className="size-4 accent-indigo-500"
                                    disabled={merging || !isWorkspaceAdmin}
                                    type="checkbox"
                                    onChange={() => toggleSourceProject(project.id)}
                                 />
                                 <span className="min-w-0 flex-1 truncate">{project.name}</span>
                                 <span className="ltr text-xs text-zinc-600">{project.keyPrefix}</span>
                              </label>
                           );
                        })}
                     </div>
                  )}
               </SettingsField>

               {!isWorkspaceAdmin && !loading ? (
                  <div className="border-t border-white/7 px-4 py-3 text-sm text-amber-300">
                     فقط مالک یا مدیر فضای کاری می‌تواند پروژه‌ها را ادغام کند.
                  </div>
               ) : null}

               <div className="flex items-center justify-between gap-3 border-t border-white/7 px-4 py-3">
                  <div className="text-xs text-zinc-500">کلید تسک‌های موجود حفظ می‌شود؛ تسک‌های جدید از شماره بعدی پروژه مقصد ادامه پیدا می‌کنند.</div>
                  <Button
                     className="shrink-0 border border-red-400/20 bg-red-500/15 text-red-200 hover:bg-red-500/25"
                     disabled={loading || merging || !destinationProjectId || sourceProjectIds.length === 0 || !isWorkspaceAdmin}
                     type="button"
                     onClick={() => void handleMergeProjects()}
                  >
                     {merging ? <Loader2 className="size-4 animate-spin" /> : <GitMerge className="size-4" />}
                     ادغام {sourceProjectIds.length ? sourceProjectIds.length.toLocaleString('fa-IR') : ''} پروژه
                  </Button>
               </div>
            </SettingsPanel>
         </div>

         <div className="min-h-[520px] flex-1 border-t border-white/7">
            <ProjectsView key={projectsViewKey} />
         </div>
      </div>
   );
}

function ProfileSettingsPage() {
   const [me, setMe] = useState<TaskaraMe | null>(null);
   const [form, setForm] = useState(initialProfileForm);
   const [loading, setLoading] = useState(true);
   const [saving, setSaving] = useState(false);
   const [uploading, setUploading] = useState(false);
   const [projects, setProjects] = useState<TaskaraProject[]>([]);
   const [selectedRaycastProjectId, setSelectedRaycastProjectId] = useState('');
   const [downloadingScript, setDownloadingScript] = useState<'taskara' | 'open' | null>(null);
   const [error, setError] = useState('');
   const [notice, setNotice] = useState('');

   useEffect(() => {
      let cancelled = false;

      void (async () => {
         setError('');
         try {
            const [result, projectResult] = await Promise.all([
               taskaraRequest<TaskaraMe>('/me'),
               taskaraRequest<TaskaraProject[]>('/projects'),
            ]);
            if (cancelled) return;

            setMe(result);
            setProjects(projectResult);
            setSelectedRaycastProjectId((current) => current || projectResult[0]?.id || '');
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

   async function handleDownloadTaskaraScript() {
      if (!selectedRaycastProjectId) {
         setError('برای دانلود اسکریپت ساخت تسک، یک پروژه انتخاب کنید.');
         return;
      }

      setDownloadingScript('taskara');
      setError('');
      setNotice('');
      try {
         await downloadTaskaraFile(
            `/raycast/scripts/taskara.bash?projectId=${encodeURIComponent(selectedRaycastProjectId)}`,
            'taskara.bash'
         );
         setNotice('فایل taskara.bash دانلود شد.');
      } catch (err) {
         setError(err instanceof Error ? err.message : 'دانلود اسکریپت ساخت تسک ناموفق بود.');
      } finally {
         setDownloadingScript(null);
      }
   }

   async function handleDownloadOpenScript() {
      setDownloadingScript('open');
      setError('');
      setNotice('');
      try {
         await downloadTaskaraFile('/raycast/scripts/open-taskara.bash', 'open-taskara.bash');
         setNotice('فایل open-taskara.bash دانلود شد.');
      } catch (err) {
         setError(err instanceof Error ? err.message : 'دانلود اسکریپت باز کردن Taskara ناموفق بود.');
      } finally {
         setDownloadingScript(null);
      }
   }

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

            <SettingsPanel title="اپ منوبار">
               <div className="space-y-3 px-4 py-4 text-sm text-zinc-300">
                  <p className="text-zinc-400">
                     نسخه macOS اپ منوبار را از صفحه ریلیز دانلود کنید.
                  </p>
                  <Button asChild className="w-full border border-white/10 bg-zinc-100 text-zinc-950 hover:bg-white">
                     <a href={menubarReleasesUrl} target="_blank" rel="noreferrer">
                        <Download className="size-4" />
                        دانلود اپ منوبار
                        <ExternalLink className="size-4" />
                     </a>
                  </Button>
               </div>
            </SettingsPanel>

            <SettingsPanel title="Raycast">
               <SettingsField
                  label="پروژه پیش‌فرض"
                  description="این پروژه داخل فایل taskara.bash ذخیره می‌شود و تسک‌های ساخته‌شده از Raycast داخل همان پروژه ایجاد می‌شوند."
               >
                  <Select
                     disabled={loading || projects.length === 0}
                     value={toSelectValue(selectedRaycastProjectId)}
                     onValueChange={(value) => setSelectedRaycastProjectId(fromSelectValue(value))}
                  >
                     <SelectTrigger className={selectClassName}>
                        <SelectValue placeholder="پروژه‌ای پیدا نشد" />
                     </SelectTrigger>
                     <SelectContent className="border-white/10 bg-[#202023] text-zinc-100">
                        {projects.length === 0 ? (
                           <SelectItem disabled value={EMPTY_SELECT_VALUE}>
                              پروژه‌ای پیدا نشد
                           </SelectItem>
                        ) : (
                           projects.map((project) => (
                              <SelectItem key={project.id} value={project.id}>
                                 {project.name} ({project.keyPrefix})
                              </SelectItem>
                           ))
                        )}
                     </SelectContent>
                  </Select>
               </SettingsField>
               <div className="flex flex-wrap items-center gap-2 border-t border-white/7 px-4 py-3">
                  <Button
                     className="h-8 border border-white/10 bg-zinc-100 px-3 text-zinc-950 hover:bg-white"
                     disabled={loading || !selectedRaycastProjectId || downloadingScript !== null}
                     type="button"
                     onClick={() => void handleDownloadTaskaraScript()}
                  >
                     {downloadingScript === 'taskara' ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                     دانلود taskara.bash
                  </Button>
                  <Button
                     className="h-8 border-white/10 bg-transparent text-zinc-400 hover:bg-white/6 hover:text-zinc-100"
                     disabled={loading || downloadingScript !== null}
                     type="button"
                     variant="outline"
                     onClick={() => void handleDownloadOpenScript()}
                  >
                     {downloadingScript === 'open' ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                     دانلود open-taskara.bash
                  </Button>
               </div>
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
   const loadRequestRef = useRef(0);
   const isWorkspaceAdmin = me?.role === 'OWNER' || me?.role === 'ADMIN';
   const roleOptions = me?.role === 'OWNER' ? workspaceRoles : workspaceRoles.filter((role) => role !== 'OWNER');

   async function load() {
      const requestId = ++loadRequestRef.current;
      setError('');
      try {
         const [meResult, usersResult] = await Promise.all([
            taskaraRequest<TaskaraMe>('/me'),
            taskaraRequest<PaginatedResponse<TaskaraUser>>('/users?limit=100'),
         ]);
         if (requestId !== loadRequestRef.current) return;
         setMe(meResult);
         setUsers(usersResult.items);
      } catch (err) {
         if (requestId === loadRequestRef.current) {
            setError(err instanceof Error ? err.message : fa.settings.loadFailed);
         }
      } finally {
         if (requestId === loadRequestRef.current) setLoading(false);
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
                           <Select value={form.role} onValueChange={(role) => setForm((current) => ({ ...current, role }))}>
                              <SelectTrigger className={selectClassName}>
                                 <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="border-white/10 bg-[#202023] text-zinc-100">
                                 {roleOptions.map((role) => (
                                    <SelectItem key={role} value={role}>
                                       {fa.role[role]}
                                    </SelectItem>
                                 ))}
                              </SelectContent>
                           </Select>
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
                                       <Select
                                          disabled={!isWorkspaceAdmin || ownerLocked}
                                          value={user.role}
                                          onValueChange={(role) => void handleRoleChange(user.id, role)}
                                       >
                                          <SelectTrigger className={cn(selectClassName, 'min-w-28')}>
                                             <SelectValue />
                                          </SelectTrigger>
                                          <SelectContent className="border-white/10 bg-[#202023] text-zinc-100">
                                             {userRoleOptions.map((role) => (
                                                <SelectItem key={role} value={role}>
                                                   {fa.role[role]}
                                                </SelectItem>
                                             ))}
                                          </SelectContent>
                                       </Select>
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

function AppearanceSettingsPage() {
   const { settings, setSettings } = useAppearance();

   return (
      <div className="mx-auto w-full max-w-[900px] px-5 py-6 sm:px-7 lg:py-10">
         <SettingsPageTitle title="فونت و اندازه متن" />

         <SettingsPanel title="تایپوگرافی">
            <SettingsField label="فونت برنامه" description="فونت اصلی کل رابط کاربری.">
               <Select
                  value={settings.fontFamily}
                  onValueChange={(fontFamily) =>
                     setSettings({
                        fontFamily: fontFamily as 'iranyekan' | 'peyda' | 'system' | 'mono',
                     })
                  }
               >
                  <SelectTrigger className={selectClassName}>
                     <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-white/10 bg-[#202023] text-zinc-100">
                     <SelectItem value="iranyekan">IRANYekan</SelectItem>
                     <SelectItem value="peyda">Peyda</SelectItem>
                     <SelectItem value="system">سیستمی</SelectItem>
                     <SelectItem value="mono">Monospace</SelectItem>
                  </SelectContent>
               </Select>
            </SettingsField>

            <SettingsField label="اندازه متن عادی" description="از ۸۵٪ تا ۱۳۰٪">
               <div className="flex items-center gap-3">
                  <input
                     className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-[var(--primary)]"
                     max={130}
                     min={85}
                     step={1}
                     type="range"
                     value={Math.round(settings.bodyFontScale * 100)}
                     onChange={(event) =>
                        setSettings({
                           bodyFontScale: Number(event.target.value) / 100,
                        })
                     }
                  />
                  <span className="min-w-[52px] text-left text-xs text-zinc-400">
                     {Math.round(settings.bodyFontScale * 100)}%
                  </span>
               </div>
            </SettingsField>

         </SettingsPanel>
      </div>
   );
}

function AiSettingsPage() {
   const [me, setMe] = useState<TaskaraMe | null>(null);
   const [settings, setSettings] = useState<AiSettingsResponse | null>(null);
   const [apiKeyInput, setApiKeyInput] = useState('');
   const [defaultContextInput, setDefaultContextInput] = useState('');
   const [selectedAiModel, setSelectedAiModel] = useState<string>(defaultAiModel);
   const [loading, setLoading] = useState(true);
   const [saving, setSaving] = useState(false);
   const [savingModel, setSavingModel] = useState(false);
   const [testing, setTesting] = useState(false);
   const [error, setError] = useState('');
   const [notice, setNotice] = useState('');
   const isWorkspaceAdmin = me?.role === 'OWNER' || me?.role === 'ADMIN';

   useEffect(() => {
      let cancelled = false;

      void (async () => {
         setLoading(true);
         setError('');
         try {
            const [meResult, settingsResult] = await Promise.all([
               taskaraRequest<TaskaraMe>('/me'),
               taskaraRequest<AiSettingsResponse>('/ai/settings'),
            ]);
            if (cancelled) return;

            setMe(meResult);
            setSettings(settingsResult);
            setApiKeyInput('');
            setDefaultContextInput(settingsResult.defaultContext || '');
            setSelectedAiModel(meResult.user.aiModel || defaultAiModel);
         } catch (err) {
            if (!cancelled) setError(err instanceof Error ? err.message : 'بارگذاری تنظیمات هوش مصنوعی ناموفق بود.');
         } finally {
            if (!cancelled) setLoading(false);
         }
      })();

      return () => {
         cancelled = true;
      };
   }, []);

   async function handleModelChange(model: string) {
      if (savingModel || selectedAiModel === model) return;

      setSavingModel(true);
      setError('');
      setNotice('');
      try {
         const result = await taskaraRequest<TaskaraMe>('/me', {
            method: 'PATCH',
            body: JSON.stringify({ aiModel: model }),
         });

         setMe(result);
         setSelectedAiModel(result.user.aiModel || defaultAiModel);

         const session = getAuthSession();
         if (session) {
            setAuthSession({
               ...session,
               role: result.role,
               user: result.user,
               workspace: result.workspace,
            });
         }
         setNotice('مدل هوش مصنوعی ذخیره شد.');
      } catch (err) {
         setError(err instanceof Error ? err.message : 'ذخیره مدل هوش مصنوعی ناموفق بود.');
      } finally {
         setSavingModel(false);
      }
   }

   async function handleSaveSettings() {
      if (!isWorkspaceAdmin) return;

      setSaving(true);
      setError('');
      setNotice('');
      try {
         const payload = {
            apiKey: apiKeyInput.trim() || null,
            defaultContext: defaultContextInput.trim() || null,
         };

         const result = await taskaraRequest<AiSettingsResponse>('/ai/settings', {
            method: 'PATCH',
            body: JSON.stringify(payload),
         });

         setSettings(result);
         setApiKeyInput('');
         setDefaultContextInput(result.defaultContext || '');
         setNotice('تنظیمات هوش مصنوعی ذخیره شد.');
      } catch (err) {
         setError(err instanceof Error ? err.message : 'ذخیره تنظیمات هوش مصنوعی ناموفق بود.');
      } finally {
         setSaving(false);
      }
   }

   async function handleTestSettings() {
      if (!isWorkspaceAdmin) return;

      setTesting(true);
      setError('');
      setNotice('');
      try {
         const payload = {
            apiKey: apiKeyInput.trim() || undefined,
         };

         const result = await taskaraRequest<AiSettingsTestResponse>('/ai/settings/test', {
            method: 'POST',
            body: JSON.stringify(payload),
         });

         setNotice(`اتصال موفق بود. OpenRouter / ${result.model} • ${result.latencyMs}ms`);
      } catch (err) {
         setError(err instanceof Error ? err.message : 'تست اتصال ناموفق بود.');
      } finally {
         setTesting(false);
      }
   }

   return (
      <div className="mx-auto w-full max-w-[900px] px-5 py-6 sm:px-7 lg:py-10">
         <SettingsPageTitle title="هوش مصنوعی" />

         {error ? <SettingsMessage tone="error">{error}</SettingsMessage> : null}
         {notice ? <SettingsMessage tone="success">{notice}</SettingsMessage> : null}

         <SettingsPanel title="اتصال سرویس AI">
            <SettingsField
               className="sm:grid-cols-[minmax(0,1fr)_auto]"
               label="وضعیت اتصال"
               description="کلید API برای گزارش‌گیری و دستیار AI ذخیره می‌شود."
            >
               <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <div className="rounded-md border border-white/8 bg-black/20 px-3 py-2">
                     <div className="text-xs text-zinc-500">وضعیت</div>
                     <div className="mt-1 font-medium text-zinc-200">
                        {settings?.hasApiKey ? 'کلید API ثبت شده است.' : 'کلید API ثبت نشده است.'}
                     </div>
                  </div>
                  <div className="rounded-md border border-white/8 bg-black/20 px-3 py-2">
                     <div className="text-xs text-zinc-500">کلید فعلی</div>
                     <div className="mt-1 font-medium text-zinc-200 ltr">
                        {settings?.hasApiKey ? (settings.maskedKey || '******') : '---'}
                     </div>
                  </div>
                  <div className="rounded-md border border-white/8 bg-black/20 px-3 py-2 sm:col-span-2">
                     <div className="text-xs text-zinc-500">آخرین تغییر</div>
                     <div className="mt-1 font-medium text-zinc-200">
                        {settings?.updatedAt ? formatJalaliDateTime(settings.updatedAt) : 'هنوز تنظیمی ذخیره نشده است.'}
                     </div>
                  </div>
               </div>
            </SettingsField>

            <SettingsField
               label="مدل هوش مصنوعی"
               description="این مدل برای درخواست‌های AI کاربر فعلی استفاده می‌شود."
            >
               <div className="flex items-center gap-3">
                  <select
                     className={cn(selectClassName, 'ltr')}
                     disabled={loading || savingModel}
                     value={selectedAiModel}
                     onChange={(event) => void handleModelChange(event.target.value)}
                  >
                     {!aiModelOptions.includes(selectedAiModel as (typeof aiModelOptions)[number]) ? (
                        <option value={selectedAiModel}>{selectedAiModel}</option>
                     ) : null}
                     {aiModelOptions.map((model) => (
                        <option key={model} value={model}>
                           {model}
                        </option>
                     ))}
                  </select>
                  {savingModel ? <Loader2 className="size-4 shrink-0 animate-spin text-zinc-500" /> : null}
               </div>
            </SettingsField>

            <SettingsField
               className="sm:grid-cols-[minmax(0,1fr)_auto]"
               label="مصرف AI"
               description="تجمیع مصرف درخواست‌های AI در این فضای کاری."
            >
               <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <div className="rounded-md border border-white/8 bg-black/20 px-3 py-2">
                     <div className="text-xs text-zinc-500">کل درخواست‌ها</div>
                     <div className="mt-1 font-medium text-zinc-200">
                        {(settings?.usage.totalRequests || 0).toLocaleString('fa-IR')}
                     </div>
                  </div>
                  <div className="rounded-md border border-white/8 bg-black/20 px-3 py-2">
                     <div className="text-xs text-zinc-500">کل توکن</div>
                     <div className="mt-1 font-medium text-zinc-200">
                        {(settings?.usage.totalTokens || 0).toLocaleString('fa-IR')}
                     </div>
                  </div>
                  <div className="rounded-md border border-white/8 bg-black/20 px-3 py-2">
                     <div className="text-xs text-zinc-500">توکن ورودی</div>
                     <div className="mt-1 font-medium text-zinc-200">
                        {(settings?.usage.totalPromptTokens || 0).toLocaleString('fa-IR')}
                     </div>
                  </div>
                  <div className="rounded-md border border-white/8 bg-black/20 px-3 py-2">
                     <div className="text-xs text-zinc-500">توکن خروجی</div>
                     <div className="mt-1 font-medium text-zinc-200">
                        {(settings?.usage.totalCompletionTokens || 0).toLocaleString('fa-IR')}
                     </div>
                  </div>
                  <div className="rounded-md border border-white/8 bg-black/20 px-3 py-2 sm:col-span-2">
                     <div className="text-xs text-zinc-500">هزینه تجمعی (USD)</div>
                     <div className="mt-1 font-medium text-zinc-200 ltr">
                        ${(settings?.usage.totalCostUsd || 0).toFixed(6)}
                     </div>
                     <div className="mt-1 text-xs text-zinc-500">
                        {`دارای هزینه ثبت‌شده: ${(settings?.usage.costedRequests || 0).toLocaleString('fa-IR')} از ${(settings?.usage.totalRequests || 0).toLocaleString('fa-IR')} درخواست`}
                     </div>
                     <div className="mt-1 text-xs text-zinc-500">
                        {settings?.usage.lastRequestAt ? `آخرین مصرف: ${formatJalaliDateTime(settings.usage.lastRequestAt)}` : 'هنوز مصرفی ثبت نشده است.'}
                     </div>
                  </div>
               </div>
            </SettingsField>

            <SettingsField label="API Key" description="اگر خالی ذخیره شود، کلید قبلی حذف خواهد شد.">
               <div className="space-y-2">
                  <Input
                     className={cn(inputClassName, 'ltr')}
                     disabled={loading || !isWorkspaceAdmin}
                     placeholder={settings?.hasApiKey ? 'کلید جدید وارد کنید (اختیاری)' : 'api key'}
                     type="password"
                     value={apiKeyInput}
                     onChange={(event) => setApiKeyInput(event.target.value)}
                  />
               </div>
            </SettingsField>

            <SettingsField
               label="پارامترهای پیش‌فرض AI"
               description="این متن به‌صورت خودکار به همه درخواست‌های AI اضافه می‌شود (مثل قوانین ثابت، فرمت خروجی، یا محدودیت‌ها)."
            >
               <div className="space-y-2">
                  <Textarea
                     className={cn(inputClassName, 'min-h-28')}
                     disabled={loading || !isWorkspaceAdmin}
                     maxLength={8000}
                     placeholder="مثال: همیشه پاسخ را خلاصه بده، اولویت را روی ریسک‌ها بگذار، و خروجی را با بولت‌پوینت ارائه کن."
                     value={defaultContextInput}
                     onChange={(event) => setDefaultContextInput(event.target.value)}
                  />
                  <div className="text-left text-xs text-zinc-500">{defaultContextInput.length.toLocaleString('fa-IR')} / ۸,۰۰۰</div>
               </div>
            </SettingsField>

            {!isWorkspaceAdmin ? (
               <div className="border-t border-white/7 px-4 py-3 text-sm text-amber-300">
                  فقط مالک یا مدیر فضای کاری می‌تواند تنظیمات AI را تغییر دهد.
               </div>
            ) : null}

            <div className="border-t border-white/7 px-4 py-3">
               <div className="flex justify-end gap-2">
                  <Button
                     className="h-9 border-white/10 bg-transparent text-zinc-300 hover:bg-white/6 hover:text-zinc-100"
                     disabled={loading || saving || testing || !isWorkspaceAdmin}
                     type="button"
                     variant="outline"
                     onClick={() => void handleTestSettings()}
                  >
                     {testing ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />}
                     تست اتصال
                  </Button>
                  <Button
                     className="h-9 border border-white/10 bg-zinc-100 px-4 text-zinc-950 hover:bg-white"
                     disabled={loading || saving || testing || !isWorkspaceAdmin}
                     type="button"
                     onClick={() => void handleSaveSettings()}
                  >
                     {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                     ذخیره API Key
                  </Button>
               </div>
            </div>
         </SettingsPanel>
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
   className,
   description,
   label,
}: {
   children: ReactNode;
   className?: string;
   description?: ReactNode;
   label: ReactNode;
}) {
   return (
      <div className={cn('grid gap-3 border-t border-white/7 px-4 py-3 first:border-t-0 sm:grid-cols-[200px_minmax(0,1fr)] sm:items-center', className)}>
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
