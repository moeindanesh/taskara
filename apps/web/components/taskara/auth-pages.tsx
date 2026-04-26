'use client';

import type { FormEvent, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Building2, Loader2, LogIn, Plus, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { taskaraRequest } from '@/lib/taskara-client';
import type {
   TaskaraAuthSession,
   TaskaraAuthWorkspacesResponse,
   TaskaraWorkspaceInvite,
   TaskaraWorkspaceMembership,
} from '@/lib/taskara-types';
import { clearAuthSession, setAuthSession, useAuthSession } from '@/store/auth-store';
import { cn } from '@/lib/utils';
import { TaskaraLogo } from '@/components/taskara/brand-logo';

const inputClassName =
   'h-10 border-white/10 bg-[#111113] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/25';

function nextFromSearch(search: string) {
   const next = new URLSearchParams(search).get('next');
   return next?.startsWith('/') && !next.startsWith('//') ? next : '';
}

function workspaceHome(slug: string) {
   return `/${slug}/team/all/all`;
}

function destinationFor(session: TaskaraAuthSession, next?: string) {
   if (!session.workspace?.slug) return '/onboarding';
   if (next && next.startsWith(`/${session.workspace.slug}/`)) return next;
   return workspaceHome(session.workspace.slug);
}

function sessionForMembership(session: TaskaraAuthSession, membership: TaskaraWorkspaceMembership): TaskaraAuthSession {
   return {
      ...session,
      workspace: membership.workspace,
      role: membership.role,
   };
}

export function LoginPage() {
   const navigate = useNavigate();
   const location = useLocation();
   const { session } = useAuthSession();
   const next = useMemo(() => nextFromSearch(location.search), [location.search]);
   const [form, setForm] = useState({ email: '', password: '' });
   const [error, setError] = useState('');
   const [submitting, setSubmitting] = useState(false);

   useEffect(() => {
      if (session) navigate(`/onboarding${next ? `?next=${encodeURIComponent(next)}` : ''}`, { replace: true });
   }, [navigate, next, session]);

   async function handleSubmit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      setSubmitting(true);
      setError('');

      try {
         const result = await taskaraRequest<TaskaraAuthSession>('/auth/login', {
            method: 'POST',
            body: JSON.stringify({
               email: form.email,
               password: form.password,
            }),
         });
         setAuthSession(result);
         navigate(`/onboarding${next ? `?next=${encodeURIComponent(next)}` : ''}`, { replace: true });
      } catch (err) {
         setError(err instanceof Error ? err.message : 'ورود ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <AuthShell
         title="ورود به تسکارا"
         description="ابتدا وارد حساب خود شوید؛ سپس فضای کاری را انتخاب کنید یا فضای کاری تازه بسازید."
         footer={<Link className="text-xs text-zinc-500 transition hover:text-zinc-200" to={`/signup${next ? `?next=${encodeURIComponent(next)}` : ''}`}>ساخت حساب جدید</Link>}
      >
         <form className="space-y-4" onSubmit={handleSubmit}>
            {error ? <AuthMessage>{error}</AuthMessage> : null}
            <AuthField label="ایمیل">
               <Input
                  autoComplete="email"
                  className={cn(inputClassName, 'ltr')}
                  disabled={submitting}
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
               />
            </AuthField>
            <AuthField label="رمز عبور">
               <Input
                  autoComplete="current-password"
                  className={cn(inputClassName, 'ltr')}
                  disabled={submitting}
                  type="password"
                  value={form.password}
                  onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
               />
            </AuthField>
            <Button className="h-10 w-full bg-zinc-100 text-zinc-950 hover:bg-white" disabled={submitting}>
               {submitting ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
               ورود
            </Button>
         </form>
      </AuthShell>
   );
}

export function SignupPage() {
   const navigate = useNavigate();
   const location = useLocation();
   const { session } = useAuthSession();
   const next = useMemo(() => nextFromSearch(location.search), [location.search]);
   const [form, setForm] = useState({ name: '', email: '', password: '' });
   const [error, setError] = useState('');
   const [submitting, setSubmitting] = useState(false);

   useEffect(() => {
      if (session) navigate(`/onboarding${next ? `?next=${encodeURIComponent(next)}` : ''}`, { replace: true });
   }, [navigate, next, session]);

   async function handleSubmit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      setSubmitting(true);
      setError('');

      try {
         const result = await taskaraRequest<TaskaraAuthSession>('/auth/register', {
            method: 'POST',
            body: JSON.stringify(form),
         });
         setAuthSession(result);
         navigate(`/onboarding${next ? `?next=${encodeURIComponent(next)}` : ''}`, { replace: true });
      } catch (err) {
         setError(err instanceof Error ? err.message : 'ساخت حساب ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <AuthShell
         title="ساخت حساب"
         description="حساب کاربری را بسازید؛ در مرحله بعد فضای کاری را انتخاب یا ایجاد می‌کنید."
         footer={<Link className="text-xs text-zinc-500 transition hover:text-zinc-200" to={`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`}>ورود با حساب موجود</Link>}
      >
         <form className="space-y-4" onSubmit={handleSubmit}>
            {error ? <AuthMessage>{error}</AuthMessage> : null}
            <AuthField label="نام شما">
               <Input
                  autoComplete="name"
                  className={inputClassName}
                  disabled={submitting}
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
               />
            </AuthField>
            <AuthField label="ایمیل">
               <Input
                  autoComplete="email"
                  className={cn(inputClassName, 'ltr')}
                  disabled={submitting}
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
               />
            </AuthField>
            <AuthField label="رمز عبور">
               <Input
                  autoComplete="new-password"
                  className={cn(inputClassName, 'ltr')}
                  disabled={submitting}
                  type="password"
                  value={form.password}
                  onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
               />
            </AuthField>
            <Button className="h-10 w-full bg-zinc-100 text-zinc-950 hover:bg-white" disabled={submitting}>
               {submitting ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
               ساخت حساب
            </Button>
         </form>
      </AuthShell>
   );
}

export function OnboardingPage() {
   const navigate = useNavigate();
   const location = useLocation();
   const { session } = useAuthSession();
   const next = useMemo(() => nextFromSearch(location.search), [location.search]);
   const [workspaces, setWorkspaces] = useState<TaskaraWorkspaceMembership[]>([]);
   const [form, setForm] = useState({ name: '', slug: '' });
   const [error, setError] = useState('');
   const [loading, setLoading] = useState(true);
   const [creating, setCreating] = useState(false);

   useEffect(() => {
      if (!session) {
         navigate('/login?next=/onboarding', { replace: true });
         return;
      }

      let cancelled = false;
      void (async () => {
         setError('');
         try {
            const result = await taskaraRequest<TaskaraAuthWorkspacesResponse>('/auth/workspaces');
            if (cancelled) return;
            setWorkspaces(result.items);
            const first = result.items[0];
            if (first && !session.workspace?.slug) {
               const nextSession = sessionForMembership(session, first);
               setAuthSession(nextSession);
            }
         } catch (err) {
            if (!cancelled) setError(err instanceof Error ? err.message : 'بارگذاری فضای کاری ناموفق بود.');
         } finally {
            if (!cancelled) setLoading(false);
         }
      })();

      return () => {
         cancelled = true;
      };
   }, [navigate, session]);

   function openWorkspace(membership: TaskaraWorkspaceMembership) {
      if (!session) return;
      const nextSession = sessionForMembership(session, membership);
      setAuthSession(nextSession);
      navigate(destinationFor(nextSession, next), { replace: true });
   }

   async function handleCreateWorkspace(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!session) return;
      setCreating(true);
      setError('');

      try {
         const result = await taskaraRequest<TaskaraAuthSession>('/auth/workspaces', {
            method: 'POST',
            body: JSON.stringify(form),
         });
         setAuthSession(result);
         navigate(destinationFor(result, next), { replace: true });
      } catch (err) {
         setError(err instanceof Error ? err.message : 'ساخت فضای کاری ناموفق بود.');
      } finally {
         setCreating(false);
      }
   }

   return (
      <AuthShell
         wide
         title="انتخاب فضای کاری"
         description="بعد از ورود، یکی از فضاهای کاری خود را باز کنید یا فضای کاری تازه بسازید."
         footer={
            <button
               className="text-xs text-zinc-500 transition hover:text-zinc-200"
               type="button"
               onClick={() => {
                  clearAuthSession();
                  navigate('/login', { replace: true });
               }}
            >
               خروج از حساب
            </button>
         }
      >
         <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section className="min-w-0">
               <div className="mb-3 text-sm font-medium text-zinc-300">فضاهای کاری شما</div>
               {error ? <AuthMessage>{error}</AuthMessage> : null}
               <div className="grid gap-2">
                  {loading ? (
                     <div className="rounded-lg border border-white/8 bg-white/[0.03] px-4 py-5 text-sm text-zinc-500">در حال بارگذاری...</div>
                  ) : workspaces.length === 0 ? (
                     <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-zinc-500">
                        هنوز عضو هیچ فضای کاری نیستید.
                     </div>
                  ) : (
                     workspaces.map((membership) => (
                        <button
                           key={membership.membershipId}
                           className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-white/8 bg-white/[0.03] px-4 py-3 text-start transition hover:bg-white/[0.07]"
                           type="button"
                           onClick={() => openWorkspace(membership)}
                        >
                           <span className="flex min-w-0 items-center gap-3">
                              <span className="inline-flex size-9 items-center justify-center rounded-lg bg-white/8 text-zinc-300">
                                 <Building2 className="size-4" />
                              </span>
                              <span className="min-w-0">
                                 <span className="block truncate text-sm font-medium text-zinc-100">{membership.workspace.name}</span>
                                 <span className="ltr block truncate text-xs text-zinc-500">{membership.workspace.slug}</span>
                              </span>
                           </span>
                           <ArrowLeft className="size-4 shrink-0 text-zinc-500" />
                        </button>
                     ))
                  )}
               </div>
            </section>

            <form className="rounded-lg border border-white/8 bg-white/[0.03] p-4" onSubmit={handleCreateWorkspace}>
               <div className="mb-4 flex items-center gap-2 text-sm font-medium text-zinc-200">
                  <Plus className="size-4 text-zinc-500" />
                  ساخت فضای کاری
               </div>
               <div className="space-y-4">
                  <AuthField label="نام فضای کاری">
                     <Input
                        className={inputClassName}
                        disabled={creating}
                        placeholder="Acme"
                        value={form.name}
                        onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                     />
                  </AuthField>
                  <AuthField label="شناسه فضای کاری">
                     <Input
                        className={cn(inputClassName, 'ltr')}
                        disabled={creating}
                        placeholder="acme"
                        value={form.slug}
                        onChange={(event) => setForm((current) => ({ ...current, slug: event.target.value }))}
                     />
                  </AuthField>
                  <Button className="h-10 w-full bg-zinc-100 text-zinc-950 hover:bg-white" disabled={creating}>
                     {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                     ایجاد و ورود
                  </Button>
               </div>
            </form>
         </div>
      </AuthShell>
   );
}

export function AcceptInvitePage() {
   const { token = '' } = useParams();
   const navigate = useNavigate();
   const [invite, setInvite] = useState<TaskaraWorkspaceInvite | null>(null);
   const [form, setForm] = useState({ name: '', password: '' });
   const [error, setError] = useState('');
   const [loading, setLoading] = useState(true);
   const [submitting, setSubmitting] = useState(false);

   useEffect(() => {
      let cancelled = false;
      void (async () => {
         setError('');
         try {
            const result = await taskaraRequest<TaskaraWorkspaceInvite>(`/auth/invites/${encodeURIComponent(token)}`);
            if (cancelled) return;
            setInvite(result);
            setForm((current) => ({ ...current, name: result.name || '' }));
         } catch (err) {
            if (!cancelled) setError(err instanceof Error ? err.message : 'دعوت‌نامه معتبر نیست.');
         } finally {
            if (!cancelled) setLoading(false);
         }
      })();

      return () => {
         cancelled = true;
      };
   }, [token]);

   async function handleSubmit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      setSubmitting(true);
      setError('');

      try {
         const result = await taskaraRequest<TaskaraAuthSession>(`/auth/invites/${encodeURIComponent(token)}/accept`, {
            method: 'POST',
            body: JSON.stringify(form),
         });
         setAuthSession(result);
         navigate(destinationFor(result), { replace: true });
      } catch (err) {
         setError(err instanceof Error ? err.message : 'پذیرش دعوت‌نامه ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <AuthShell
         title="پذیرش دعوت"
         description={invite ? `دعوت به ${invite.workspace?.name || 'تسکارا'} برای ${invite.email}` : 'در حال بررسی دعوت‌نامه.'}
         footer={<Link className="text-xs text-zinc-500 transition hover:text-zinc-200" to="/login">ورود با حساب موجود</Link>}
      >
         <form className="space-y-4" onSubmit={handleSubmit}>
            {error ? <AuthMessage>{error}</AuthMessage> : null}
            <AuthField label="ایمیل">
               <Input className={cn(inputClassName, 'ltr text-zinc-500')} readOnly value={invite?.email || ''} />
            </AuthField>
            <AuthField label="نام شما">
               <Input
                  autoComplete="name"
                  className={inputClassName}
                  disabled={loading || submitting || !invite}
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
               />
            </AuthField>
            <AuthField label="رمز عبور">
               <Input
                  autoComplete="new-password"
                  className={cn(inputClassName, 'ltr')}
                  disabled={loading || submitting || !invite}
                  type="password"
                  value={form.password}
                  onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
               />
            </AuthField>
            <Button className="h-10 w-full bg-zinc-100 text-zinc-950 hover:bg-white" disabled={loading || submitting || !invite}>
               {submitting ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
               ساخت حساب و ورود
            </Button>
         </form>
      </AuthShell>
   );
}

function AuthShell({
   children,
   description,
   footer,
   title,
   wide = false,
}: {
   children: ReactNode;
   description: ReactNode;
   footer?: ReactNode;
   title: ReactNode;
   wide?: boolean;
}) {
   return (
      <div dir="rtl" className="flex min-h-svh items-center justify-center bg-[#080809] px-4 py-10 text-zinc-100">
         <main className={cn('w-full rounded-xl border border-white/10 bg-[#19191b] p-6 shadow-2xl', wide ? 'max-w-[860px]' : 'max-w-[460px]')}>
            <div className="mb-5 flex justify-center">
               <TaskaraLogo className="size-14 rounded-2xl border border-white/10 shadow-[0_18px_48px_rgb(0_0_0/0.35)]" />
            </div>
            <div className="mb-6">
               <div className="mb-2 text-xl font-semibold text-zinc-100">{title}</div>
               <p className="text-sm leading-6 text-zinc-500">{description}</p>
            </div>
            {children}
            {footer ? <div className="mt-5 flex justify-center">{footer}</div> : null}
         </main>
      </div>
   );
}

function AuthField({ children, label }: { children: ReactNode; label: ReactNode }) {
   return (
      <label className="grid gap-2 text-sm text-zinc-300">
         <span>{label}</span>
         {children}
      </label>
   );
}

function AuthMessage({ children }: { children: ReactNode }) {
   return (
      <div className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">
         {children}
      </div>
   );
}
