'use client';

import type { FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Loader2, Plus, Trash2, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LinearAvatar } from '@/components/taskara/linear-ui';
import { taskaraRequest } from '@/lib/taskara-client';
import { formatJalaliDateTime, formatJalaliMonthYear } from '@/lib/jalali';
import { RoleBadge, workspaceRoles } from '@/lib/taskara-presenters';
import type { PaginatedResponse, TaskaraMe, TaskaraUser, TaskaraWorkspaceInvite } from '@/lib/taskara-types';
import { fa } from '@/lib/fa-copy';
import { cn } from '@/lib/utils';

const initialInviteForm = {
   email: '',
   name: '',
   role: 'MEMBER',
};

const inputClassName =
   'border-white/10 bg-[#111113] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/25';
const selectClassName =
   'flex h-9 w-full rounded-md border border-white/10 bg-[#111113] px-3 text-sm text-zinc-200 outline-none transition focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/25 disabled:cursor-not-allowed disabled:opacity-55';

export function MembersView() {
   const [me, setMe] = useState<TaskaraMe | null>(null);
   const [users, setUsers] = useState<TaskaraUser[]>([]);
   const [invites, setInvites] = useState<TaskaraWorkspaceInvite[]>([]);
   const [inviteForm, setInviteForm] = useState(initialInviteForm);
   const [createdInviteUrl, setCreatedInviteUrl] = useState('');
   const [dialogOpen, setDialogOpen] = useState(false);
   const [error, setError] = useState('');
   const [loading, setLoading] = useState(true);
   const [creating, setCreating] = useState(false);
   const [copyingInviteId, setCopyingInviteId] = useState<string | null>(null);
   const isWorkspaceAdmin = me?.role === 'OWNER' || me?.role === 'ADMIN';
   const roleOptions = useMemo(
      () => (me?.role === 'OWNER' ? workspaceRoles : workspaceRoles.filter((role) => role !== 'OWNER')),
      [me?.role]
   );
   const inviteCreated = Boolean(createdInviteUrl);

   const load = useCallback(async () => {
      setError('');
      try {
         const [meResult, userResult, inviteResult] = await Promise.all([
            taskaraRequest<TaskaraMe>('/me'),
            taskaraRequest<PaginatedResponse<TaskaraUser>>('/users?limit=100'),
            taskaraRequest<PaginatedResponse<TaskaraWorkspaceInvite>>('/users/invites').catch(() => ({
               items: [],
               total: 0,
               limit: 0,
               offset: 0,
            })),
         ]);
         setMe(meResult);
         setUsers(userResult.items);
         setInvites(inviteResult.items);
      } catch (err) {
         setError(err instanceof Error ? err.message : 'بارگذاری اعضا ناموفق بود.');
      } finally {
         setLoading(false);
      }
   }, []);

   useEffect(() => {
      void load();
   }, [load]);

   async function handleCreateInvite(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!inviteForm.email.trim()) return;

      setCreating(true);
      setError('');
      setCreatedInviteUrl('');
      try {
         const invite = await taskaraRequest<TaskaraWorkspaceInvite>('/users/invites', {
            method: 'POST',
            body: JSON.stringify({
               email: inviteForm.email.trim(),
               name: inviteForm.name.trim() || undefined,
               role: inviteForm.role,
            }),
         });
         setCreatedInviteUrl(invite.inviteUrl || '');
         setInviteForm(initialInviteForm);
         await load();
      } catch (err) {
         setError(err instanceof Error ? err.message : 'ساخت دعوت‌نامه ناموفق بود.');
      } finally {
         setCreating(false);
      }
   }

   async function handleRevokeInvite(invite: TaskaraWorkspaceInvite) {
      if (!window.confirm(`دعوت ${invite.email} لغو شود؟`)) return;

      try {
         await taskaraRequest(`/users/invites/${invite.id}`, { method: 'DELETE' });
         await load();
      } catch (err) {
         setError(err instanceof Error ? err.message : 'لغو دعوت‌نامه ناموفق بود.');
      }
   }

   function copyInviteUrl() {
      if (!createdInviteUrl) return;
      void navigator.clipboard?.writeText(createdInviteUrl);
   }

   async function handleCopyOpenInvite(invite: TaskaraWorkspaceInvite) {
      setError('');

      if (invite.inviteUrl) {
         await navigator.clipboard?.writeText(invite.inviteUrl);
         return;
      }

      setCopyingInviteId(invite.id);
      try {
         const updatedInvite = await taskaraRequest<TaskaraWorkspaceInvite>(`/users/invites/${invite.id}/link`, {
            method: 'POST',
         });
         setInvites((current) => current.map((item) => (item.id === updatedInvite.id ? updatedInvite : item)));
         if (updatedInvite.inviteUrl) await navigator.clipboard?.writeText(updatedInvite.inviteUrl);
      } catch (err) {
         setError(err instanceof Error ? err.message : 'کپی لینک دعوت‌نامه ناموفق بود.');
      } finally {
         setCopyingInviteId(null);
      }
   }

   return (
      <div className="px-6 py-6">
         <Card className="border-white/8 bg-[#19191b] text-zinc-100">
            <CardHeader className="flex flex-col gap-4 border-b border-white/7 sm:flex-row sm:items-start sm:justify-between">
               <div>
                  <CardTitle>{fa.nav.members}</CardTitle>
                  <CardDescription className="mt-2 text-zinc-500">
                     فهرست کاربران متصل به تسکارا به همراه نقش و بار کاری آن‌ها.
                  </CardDescription>
               </div>
               {isWorkspaceAdmin ? (
                  <Button
                     className="h-9 w-fit border border-white/10 bg-zinc-100 px-3 text-zinc-950 hover:bg-white"
                     type="button"
                     onClick={() => {
                        setCreatedInviteUrl('');
                        setDialogOpen(true);
                     }}
                  >
                     <Plus className="size-4" />
                     افزودن عضو
                  </Button>
               ) : null}
            </CardHeader>
            <CardContent className="p-0">
               {error ? <p className="mx-5 mt-5 rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</p> : null}
               <div className="overflow-x-auto px-5 py-4">
                  <Table>
                     <TableHeader>
                        <TableRow className="border-white/8 hover:bg-transparent">
                           <TableHead className="text-right text-zinc-500">{fa.settings.name}</TableHead>
                           <TableHead className="text-right text-zinc-500">{fa.table.role}</TableHead>
                           <TableHead className="text-right text-zinc-500">{fa.table.mattermost}</TableHead>
                           <TableHead className="text-right text-zinc-500">{fa.table.joinedAt}</TableHead>
                           <TableHead className="text-right text-zinc-500">{fa.table.assigned}</TableHead>
                           <TableHead className="text-right text-zinc-500">{fa.table.reported}</TableHead>
                        </TableRow>
                     </TableHeader>
                     <TableBody>
                        {loading ? (
                           <TableRow className="border-white/8">
                              <TableCell colSpan={6} className="py-8 text-center text-zinc-500">{fa.app.loading}</TableCell>
                           </TableRow>
                        ) : users.length === 0 ? (
                           <TableRow className="border-white/8">
                              <TableCell colSpan={6} className="py-8 text-center text-zinc-500">عضوی برای نمایش وجود ندارد.</TableCell>
                           </TableRow>
                        ) : (
                           users.map((user) => (
                              <TableRow key={user.id} className="border-white/8 hover:bg-white/[0.025]">
                                 <TableCell className="max-w-[320px] whitespace-normal">
                                    <div className="flex min-w-[220px] items-center gap-3">
                                       <LinearAvatar name={user.name} src={user.avatarUrl} className="size-7" />
                                       <div className="min-w-0 space-y-1">
                                          <div className="truncate font-medium text-zinc-200">{user.name}</div>
                                          <div className="ltr truncate text-xs text-zinc-500">{user.email}</div>
                                       </div>
                                    </div>
                                 </TableCell>
                                 <TableCell><RoleBadge role={user.role} /></TableCell>
                                 <TableCell className="ltr text-zinc-400">{user.mattermostUsername ? `@${user.mattermostUsername}` : '-'}</TableCell>
                                 <TableCell className="text-zinc-400">{formatJalaliMonthYear(user.joinedAt)}</TableCell>
                                 <TableCell className="text-zinc-400">{(user._count?.assignedTasks || 0).toLocaleString('fa-IR')}</TableCell>
                                 <TableCell className="text-zinc-400">{(user._count?.reportedTasks || 0).toLocaleString('fa-IR')}</TableCell>
                              </TableRow>
                           ))
                        )}
                     </TableBody>
                  </Table>
               </div>
            </CardContent>
         </Card>

         {isWorkspaceAdmin ? (
            <Card className="mt-5 border-white/8 bg-[#19191b] text-zinc-100">
               <CardHeader className="border-b border-white/7">
                  <CardTitle className="text-base">دعوت‌های باز</CardTitle>
                  <CardDescription className="text-zinc-500">دعوت‌هایی که هنوز پذیرفته نشده‌اند.</CardDescription>
               </CardHeader>
               <CardContent className="p-0">
                  <div className="overflow-x-auto px-5 py-4">
                     <Table>
                        <TableHeader>
                           <TableRow className="border-white/8 hover:bg-transparent">
                              <TableHead className="text-right text-zinc-500">ایمیل</TableHead>
                              <TableHead className="text-right text-zinc-500">{fa.table.role}</TableHead>
                              <TableHead className="text-right text-zinc-500">انقضا</TableHead>
                              <TableHead className="text-right text-zinc-500">{fa.app.more}</TableHead>
                           </TableRow>
                        </TableHeader>
                        <TableBody>
                           {loading ? (
                              <TableRow className="border-white/8">
                                 <TableCell colSpan={4} className="py-8 text-center text-zinc-500">{fa.app.loading}</TableCell>
                              </TableRow>
                           ) : invites.length === 0 ? (
                              <TableRow className="border-white/8">
                                 <TableCell colSpan={4} className="py-8 text-center text-zinc-500">دعوت بازی وجود ندارد.</TableCell>
                              </TableRow>
                           ) : (
                              invites.map((invite) => (
                                 <TableRow key={invite.id} className="border-white/8 hover:bg-white/[0.025]">
                                    <TableCell>
                                       <div className="space-y-1">
                                          <div className="ltr text-sm font-medium text-zinc-200">{invite.email}</div>
                                          {invite.name ? <div className="text-xs text-zinc-500">{invite.name}</div> : null}
                                       </div>
                                    </TableCell>
                                    <TableCell><RoleBadge role={invite.role} /></TableCell>
                                    <TableCell className="text-zinc-400">{formatJalaliDateTime(invite.expiresAt)}</TableCell>
                                    <TableCell>
                                       <div className="flex items-center gap-1">
                                          <Button
                                             type="button"
                                             variant="ghost"
                                             size="icon"
                                             aria-label={`کپی لینک دعوت ${invite.email}`}
                                             title="کپی لینک دعوت"
                                             className="size-8 text-zinc-500 hover:bg-white/6 hover:text-zinc-100"
                                             disabled={copyingInviteId === invite.id}
                                             onClick={() => void handleCopyOpenInvite(invite)}
                                          >
                                             {copyingInviteId === invite.id ? <Loader2 className="size-4 animate-spin" /> : <Copy className="size-4" />}
                                          </Button>
                                          <Button
                                             type="button"
                                             variant="ghost"
                                             size="icon"
                                             aria-label={`لغو دعوت ${invite.email}`}
                                             title="لغو دعوت"
                                             className="size-8 text-zinc-500 hover:bg-red-500/10 hover:text-red-300"
                                             onClick={() => void handleRevokeInvite(invite)}
                                          >
                                             <Trash2 className="size-4" />
                                          </Button>
                                       </div>
                                    </TableCell>
                                 </TableRow>
                              ))
                           )}
                        </TableBody>
                     </Table>
                  </div>
               </CardContent>
            </Card>
         ) : null}

         <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogContent className="max-w-[560px] gap-0 overflow-hidden border-white/10 bg-[#1d1d20] p-0 text-zinc-100">
               <DialogHeader className="border-b border-white/8 px-6 py-5 text-right">
                  <DialogTitle className="text-xl leading-7">افزودن عضو</DialogTitle>
                  <DialogDescription className="max-w-[440px] text-sm leading-7 text-zinc-500">
                     برای کاربر یک لینک دعوت ساخته می‌شود. او با ایمیل خودش و رمز عبور وارد فضای کاری خواهد شد.
                  </DialogDescription>
               </DialogHeader>
               <form onSubmit={handleCreateInvite}>
                  <div className="space-y-5 px-6 py-5">
                     <label className="grid gap-2 text-sm text-zinc-300">
                        <span className="font-medium">ایمیل</span>
                        <Input
                           className={cn(inputClassName, 'h-11 rounded-lg ltr')}
                           disabled={creating || inviteCreated}
                           type="email"
                           value={inviteForm.email}
                           onChange={(event) => setInviteForm((current) => ({ ...current, email: event.target.value }))}
                           placeholder="sara@example.com"
                        />
                     </label>
                     <label className="grid gap-2 text-sm text-zinc-300">
                        <span className="font-medium">نام</span>
                        <Input
                           className={cn(inputClassName, 'h-11 rounded-lg')}
                           disabled={creating || inviteCreated}
                           value={inviteForm.name}
                           onChange={(event) => setInviteForm((current) => ({ ...current, name: event.target.value }))}
                           placeholder="اختیاری"
                        />
                     </label>
                     <label className="grid gap-2 text-sm text-zinc-300">
                        <span className="font-medium">{fa.settings.role}</span>
                        <select
                           className={cn(selectClassName, 'h-11 rounded-lg')}
                           disabled={creating || inviteCreated}
                           value={inviteForm.role}
                           onChange={(event) => setInviteForm((current) => ({ ...current, role: event.target.value }))}
                        >
                           {roleOptions.map((role) => (
                              <option key={role} value={role}>
                                 {fa.role[role]}
                              </option>
                           ))}
                        </select>
                     </label>

                     {createdInviteUrl ? (
                        <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/10 p-4">
                           <div className="mb-3 text-sm font-semibold text-emerald-200">لینک دعوت ساخته شد.</div>
                           <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                              <div
                                 dir="ltr"
                                 className="min-w-0 truncate rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-left text-sm text-zinc-300"
                                 title={createdInviteUrl}
                              >
                                 {createdInviteUrl}
                              </div>
                              <Button
                                 className="h-10 justify-center rounded-lg border-white/10 bg-white/5 px-3 text-zinc-100 hover:bg-white/10"
                                 type="button"
                                 variant="outline"
                                 onClick={copyInviteUrl}
                              >
                                 <Copy className="size-4" />
                                 کپی لینک
                              </Button>
                           </div>
                        </div>
                     ) : null}
                  </div>

                  <div className="flex items-center justify-between gap-3 border-t border-white/8 bg-black/10 px-6 py-4">
                     <Button className="text-zinc-400 hover:bg-white/6 hover:text-zinc-100" type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
                        بستن
                     </Button>
                     {inviteCreated ? (
                        <Button
                           className="border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
                           type="button"
                           variant="outline"
                           onClick={() => {
                              setCreatedInviteUrl('');
                              setInviteForm(initialInviteForm);
                           }}
                        >
                           دعوت عضو دیگر
                        </Button>
                     ) : (
                        <Button className="bg-zinc-100 text-zinc-950 hover:bg-white" disabled={creating || !inviteForm.email.trim()}>
                           {creating ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
                           ساخت لینک دعوت
                        </Button>
                     )}
                  </div>
               </form>
            </DialogContent>
         </Dialog>
      </div>
   );
}
