'use client';

import { useEffect, useState, useTransition } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { taskaraRequest } from '@/lib/taskara-client';
import { formatJalaliDateTime } from '@/lib/jalali';
import { RoleBadge, workspaceRoles } from '@/lib/taskara-presenters';
import type { PaginatedResponse, TaskaraMe, TaskaraTeam, TaskaraTeamMember, TaskaraUser } from '@/lib/taskara-types';
import { fa } from '@/lib/fa-copy';

const initialTeamForm = {
   name: '',
   slug: '',
   description: '',
};

const initialMemberForm = {
   userId: '',
   role: 'MEMBER',
};

export function TeamsView() {
   const [me, setMe] = useState<TaskaraMe | null>(null);
   const [teams, setTeams] = useState<TaskaraTeam[]>([]);
   const [users, setUsers] = useState<TaskaraUser[]>([]);
   const [selectedTeamId, setSelectedTeamId] = useState('');
   const [members, setMembers] = useState<TaskaraTeamMember[]>([]);
   const [form, setForm] = useState(initialTeamForm);
   const [memberForm, setMemberForm] = useState(initialMemberForm);
   const [error, setError] = useState('');
   const [loading, setLoading] = useState(true);
   const [membersLoading, setMembersLoading] = useState(false);
   const [isPending, startTransition] = useTransition();
   const isWorkspaceAdmin = me?.role === 'OWNER' || me?.role === 'ADMIN';
   const selectedTeam = teams.find((team) => team.id === selectedTeamId) || null;
   const memberUserIds = new Set(members.map((member) => member.userId));
   const availableUsers = users.filter((user) => !memberUserIds.has(user.id));

   async function load() {
      setError('');
      try {
         const [meResult, teamResult, userResult] = await Promise.all([
            taskaraRequest<TaskaraMe>('/me'),
            taskaraRequest<TaskaraTeam[]>('/teams'),
            taskaraRequest<PaginatedResponse<TaskaraUser>>('/users?limit=200'),
         ]);
         setMe(meResult);
         setTeams(teamResult);
         setUsers(userResult.items);
         setSelectedTeamId((current) => current || teamResult[0]?.id || '');
      } catch (err) {
         setError(err instanceof Error ? err.message : 'بارگذاری تیم‌ها ناموفق بود.');
      } finally {
         setLoading(false);
      }
   }

   useEffect(() => {
      void load();
   }, []);

   async function loadMembers(teamId: string) {
      if (!teamId) {
         setMembers([]);
         return;
      }

      setMembersLoading(true);
      try {
         const result = await taskaraRequest<PaginatedResponse<TaskaraTeamMember>>(`/teams/${encodeURIComponent(teamId)}/members`);
         setMembers(result.items);
      } catch (err) {
         setError(err instanceof Error ? err.message : 'بارگذاری اعضای تیم ناموفق بود.');
      } finally {
         setMembersLoading(false);
      }
   }

   useEffect(() => {
      void loadMembers(selectedTeamId);
   }, [selectedTeamId]);

   async function handleCreateTeam(event: React.FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!form.name.trim()) return;

      try {
         await taskaraRequest('/teams', {
            method: 'POST',
            body: JSON.stringify({
               name: form.name.trim(),
               slug: form.slug.trim() || undefined,
               description: form.description.trim() || undefined,
            }),
         });
         setForm(initialTeamForm);
         window.dispatchEvent(new CustomEvent('taskara:teams-updated'));
         startTransition(() => {
            void load();
         });
      } catch (err) {
         setError(err instanceof Error ? err.message : 'ایجاد تیم ناموفق بود.');
      }
   }

   async function refreshTeamsAndMembers() {
      const teamResult = await taskaraRequest<TaskaraTeam[]>('/teams');
      setTeams(teamResult);
      if (selectedTeamId) await loadMembers(selectedTeamId);
   }

   async function handleAddMember(event: React.FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!selectedTeam || !memberForm.userId) return;

      try {
         await taskaraRequest(`/teams/${encodeURIComponent(selectedTeam.id)}/members`, {
            method: 'POST',
            body: JSON.stringify(memberForm),
         });
         setMemberForm(initialMemberForm);
         await refreshTeamsAndMembers();
      } catch (err) {
         setError(err instanceof Error ? err.message : 'افزودن عضو به تیم ناموفق بود.');
      }
   }

   async function handleTeamRoleChange(userId: string, role: string) {
      if (!selectedTeam) return;

      try {
         await taskaraRequest(`/teams/${encodeURIComponent(selectedTeam.id)}/members/${encodeURIComponent(userId)}/role`, {
            method: 'PATCH',
            body: JSON.stringify({ role }),
         });
         await loadMembers(selectedTeam.id);
      } catch (err) {
         setError(err instanceof Error ? err.message : fa.settings.roleUpdateFailed);
      }
   }

   async function handleRemoveTeamMember(member: TaskaraTeamMember) {
      if (!selectedTeam || !window.confirm(`${member.user.name} از تیم حذف شود؟`)) return;

      try {
         await taskaraRequest(`/teams/${encodeURIComponent(selectedTeam.id)}/members/${encodeURIComponent(member.userId)}`, {
            method: 'DELETE',
         });
         await refreshTeamsAndMembers();
      } catch (err) {
         setError(err instanceof Error ? err.message : 'حذف عضو تیم ناموفق بود.');
      }
   }

   return (
      <div className="space-y-4 px-5 py-5">
         {error ? <p className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</p> : null}

         <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
            <div className="space-y-4">
               {isWorkspaceAdmin ? (
                  <Card>
                     <CardHeader>
                        <CardTitle>تیم جدید</CardTitle>
                        <CardDescription>برای تقسیم پروژه‌ها و اعضا به زیرگروه‌ها از تیم استفاده کنید.</CardDescription>
                     </CardHeader>
                     <CardContent>
                        <form className="space-y-4" onSubmit={handleCreateTeam}>
                           <label className="grid gap-2 text-sm">
                              <span>نام تیم</span>
                              <Input
                                 value={form.name}
                                 onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                                 placeholder="مثلا تیم پلتفرم"
                              />
                           </label>
                           <label className="grid gap-2 text-sm">
                              <span>{fa.table.slug}</span>
                              <Input
                                 className="ltr"
                                 value={form.slug}
                                 onChange={(event) => setForm((current) => ({ ...current, slug: event.target.value }))}
                                 placeholder="team-slug"
                              />
                           </label>
                           <label className="grid gap-2 text-sm">
                              <span>توضیح</span>
                              <Textarea
                                 value={form.description}
                                 onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                                 rows={5}
                                 placeholder="مسئولیت یا حوزه مالکیت تیم"
                              />
                           </label>
                           <Button className="w-full" disabled={isPending}>
                              {isPending ? fa.settings.creating : 'ایجاد تیم'}
                           </Button>
                        </form>
                     </CardContent>
                  </Card>
               ) : null}

               <Card>
                  <CardHeader>
                     <CardTitle>مدیریت اعضای تیم</CardTitle>
                     <CardDescription>یک تیم را انتخاب کنید و اعضای آن را مدیریت کنید.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                     <label className="grid gap-2 text-sm">
                        <span>{fa.table.team}</span>
                        <select
                           className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                           value={selectedTeamId}
                           onChange={(event) => setSelectedTeamId(event.target.value)}
                        >
                           {teams.map((team) => (
                              <option key={team.id} value={team.id}>
                                 {team.name}
                              </option>
                           ))}
                        </select>
                     </label>

                     {isWorkspaceAdmin ? (
                        <form className="space-y-4" onSubmit={handleAddMember}>
                           <label className="grid gap-2 text-sm">
                              <span>{fa.table.user}</span>
                              <select
                                 className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                                 value={memberForm.userId}
                                 onChange={(event) => setMemberForm((current) => ({ ...current, userId: event.target.value }))}
                              >
                                 <option value="">انتخاب کاربر</option>
                                 {availableUsers.map((user) => (
                                    <option key={user.id} value={user.id}>
                                       {user.name} - {user.email}
                                    </option>
                                 ))}
                              </select>
                           </label>
                           <label className="grid gap-2 text-sm">
                              <span>{fa.settings.role}</span>
                              <select
                                 className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                                 value={memberForm.role}
                                 onChange={(event) => setMemberForm((current) => ({ ...current, role: event.target.value }))}
                              >
                                 {workspaceRoles.map((role) => (
                                    <option key={role} value={role}>
                                       {fa.role[role]}
                                    </option>
                                 ))}
                              </select>
                           </label>
                           <Button className="w-full" disabled={!selectedTeam || !memberForm.userId}>
                              افزودن عضو
                           </Button>
                        </form>
                     ) : null}
                  </CardContent>
               </Card>
            </div>

            <div className="space-y-4">
               <Card>
                  <CardHeader>
                     <CardTitle>فهرست تیم‌ها</CardTitle>
                     <CardDescription>مرور تیم‌های موجود و نسبت اعضا به پروژه‌ها.</CardDescription>
                  </CardHeader>
                  <CardContent>
                     <Table>
                        <TableHeader>
                           <TableRow>
                              <TableHead className="text-right">{fa.table.team}</TableHead>
                              <TableHead className="text-right">{fa.table.slug}</TableHead>
                              <TableHead className="text-right">{fa.table.members}</TableHead>
                              <TableHead className="text-right">{fa.table.projects}</TableHead>
                           </TableRow>
                        </TableHeader>
                        <TableBody>
                           {loading ? (
                              <TableRow>
                                 <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">{fa.app.loading}</TableCell>
                              </TableRow>
                           ) : teams.length === 0 ? (
                              <TableRow>
                                 <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">هنوز تیمی ثبت نشده است.</TableCell>
                              </TableRow>
                           ) : (
                              teams.map((team) => (
                                 <TableRow key={team.id} className={team.id === selectedTeamId ? 'bg-muted/40' : undefined}>
                                    <TableCell className="max-w-[320px] whitespace-normal">
                                       <button
                                          type="button"
                                          className="space-y-1 text-right"
                                          onClick={() => setSelectedTeamId(team.id)}
                                       >
                                          <div className="font-medium">{team.name}</div>
                                          {team.description ? <div className="text-xs text-muted-foreground">{team.description}</div> : null}
                                       </button>
                                    </TableCell>
                                    <TableCell className="ltr">{team.slug}</TableCell>
                                    <TableCell>{(team._count?.members || 0).toLocaleString('fa-IR')}</TableCell>
                                    <TableCell>{(team._count?.projects || 0).toLocaleString('fa-IR')}</TableCell>
                                 </TableRow>
                              ))
                           )}
                        </TableBody>
                     </Table>
                  </CardContent>
               </Card>

               <Card>
                  <CardHeader>
                     <CardTitle>{selectedTeam ? `اعضای ${selectedTeam.name}` : 'اعضای تیم'}</CardTitle>
                     <CardDescription>نقش‌های داخلی تیم و تاریخ عضویت.</CardDescription>
                  </CardHeader>
                  <CardContent>
                     <Table>
                        <TableHeader>
                           <TableRow>
                              <TableHead className="text-right">{fa.table.user}</TableHead>
                              <TableHead className="text-right">{fa.table.role}</TableHead>
                              <TableHead className="text-right">{fa.table.joinedAt}</TableHead>
                              <TableHead className="text-right">{fa.app.more}</TableHead>
                           </TableRow>
                        </TableHeader>
                        <TableBody>
                           {membersLoading ? (
                              <TableRow>
                                 <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">{fa.app.loading}</TableCell>
                              </TableRow>
                           ) : !selectedTeam ? (
                              <TableRow>
                                 <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">تیمی برای مدیریت وجود ندارد.</TableCell>
                              </TableRow>
                           ) : members.length === 0 ? (
                              <TableRow>
                                 <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">این تیم هنوز عضوی ندارد.</TableCell>
                              </TableRow>
                           ) : (
                              members.map((member) => (
                                 <TableRow key={member.membershipId}>
                                    <TableCell>
                                       <div className="space-y-1">
                                          <div className="font-medium">{member.user.name}</div>
                                          <div className="ltr text-xs text-muted-foreground">{member.user.email}</div>
                                       </div>
                                    </TableCell>
                                    <TableCell>
                                       {isWorkspaceAdmin ? (
                                          <select
                                             className="flex h-9 w-full min-w-28 rounded-md border border-input bg-background px-3 text-sm"
                                             value={member.role}
                                             onChange={(event) => void handleTeamRoleChange(member.userId, event.target.value)}
                                          >
                                             {workspaceRoles.map((role) => (
                                                <option key={role} value={role}>
                                                   {fa.role[role]}
                                                </option>
                                             ))}
                                          </select>
                                       ) : (
                                          <RoleBadge role={member.role} />
                                       )}
                                    </TableCell>
                                    <TableCell>{formatJalaliDateTime(member.joinedAt)}</TableCell>
                                    <TableCell>
                                       <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon"
                                          disabled={!isWorkspaceAdmin}
                                          aria-label={`حذف ${member.user.name}`}
                                          onClick={() => void handleRemoveTeamMember(member)}
                                       >
                                          <Trash2 className="size-4 text-destructive" />
                                       </Button>
                                    </TableCell>
                                 </TableRow>
                              ))
                           )}
                        </TableBody>
                     </Table>
                  </CardContent>
               </Card>
            </div>
         </div>
      </div>
   );
}
