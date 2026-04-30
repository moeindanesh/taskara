'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trophy } from 'lucide-react';
import { LinearAvatar } from '@/components/taskara/linear-ui';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fa } from '@/lib/fa-copy';
import { taskaraRequest } from '@/lib/taskara-client';
import type { PaginatedResponse, TaskaraTask, TaskaraUser } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';

type LeaderboardRow = {
   userId: string;
   name: string;
   email: string;
   avatarUrl?: string | null;
   assignedCount: number;
   doneCount: number;
   speedRatio: number;
};

const pageSize = 200;

function formatFaNumber(value: number) {
   return value.toLocaleString('fa-IR');
}

function formatSpeedRatio(value: number) {
   return `${Math.round(value * 100).toLocaleString('fa-IR')}٪`;
}

function RankTrophy({ rank }: { rank: number }) {
   if (rank === 1) return <Trophy className="size-4 text-amber-300" />;
   if (rank === 2) return <Trophy className="size-4 text-zinc-300" />;
   if (rank === 3) return <Trophy className="size-4 text-amber-700" />;
   return null;
}

async function fetchAllPages<T>(path: string): Promise<T[]> {
   const items: T[] = [];
   let offset = 0;
   const separator = path.includes('?') ? '&' : '?';

   while (true) {
      const response = await taskaraRequest<PaginatedResponse<T>>(`${path}${separator}limit=${pageSize}&offset=${offset}`);
      items.push(...response.items);
      offset += response.items.length;

      if (!response.items.length || offset >= response.total) break;
   }

   return items;
}

export function LeaderboardView() {
   const [users, setUsers] = useState<TaskaraUser[]>([]);
   const [tasks, setTasks] = useState<TaskaraTask[]>([]);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState('');

   const loadLeaderboard = useCallback(async () => {
      setLoading(true);
      setError('');
      try {
         const [workspaceUsers, workspaceTasks] = await Promise.all([
            fetchAllPages<TaskaraUser>('/users'),
            fetchAllPages<TaskaraTask>('/tasks?teamId=all'),
         ]);
         setUsers(workspaceUsers);
         setTasks(workspaceTasks);
      } catch (err) {
         setError(err instanceof Error ? err.message : fa.leaderboard.loadFailed);
      } finally {
         setLoading(false);
      }
   }, []);

   useEffect(() => {
      void loadLeaderboard();
   }, [loadLeaderboard]);

   const rows = useMemo(() => {
      const assignedByUser = new Map<string, number>();
      const doneByUser = new Map<string, number>();

      for (const task of tasks) {
         const assigneeId = task.assignee?.id;
         if (!assigneeId) continue;

         assignedByUser.set(assigneeId, (assignedByUser.get(assigneeId) || 0) + 1);
         if (task.status === 'DONE') {
            doneByUser.set(assigneeId, (doneByUser.get(assigneeId) || 0) + 1);
         }
      }

      return users
         .map<LeaderboardRow>((user) => {
            const assignedCount = assignedByUser.get(user.id) || 0;
            const doneCount = doneByUser.get(user.id) || 0;
            const speedRatio = assignedCount ? doneCount / assignedCount : 0;

            return {
               userId: user.id,
               name: user.name,
               email: user.email,
               avatarUrl: user.avatarUrl,
               assignedCount,
               doneCount,
               speedRatio,
            };
         })
         .sort((a, b) => {
            if (b.doneCount !== a.doneCount) return b.doneCount - a.doneCount;
            if (b.assignedCount !== a.assignedCount) return b.assignedCount - a.assignedCount;
            return a.name.localeCompare(b.name, 'fa');
         });
   }, [tasks, users]);

   return (
      <div className="space-y-5 px-6 py-6">
         <Card className="overflow-hidden border-white/8 bg-[#19191b] text-zinc-100">
            <CardHeader className="relative border-b border-white/7">
               <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-amber-300/10 to-transparent" />
               <CardTitle className="relative flex items-center gap-2">
                  <Trophy className="size-5 text-amber-300" />
                  {fa.nav.leaderboard}
               </CardTitle>
               <CardDescription className="relative text-zinc-500">
                  {fa.pages.leaderboardDescription}
               </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
               {error ? (
                  <p className="mx-5 mt-5 rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                     {error}
                  </p>
               ) : null}
               <div className="overflow-x-auto px-5 py-4">
                  <Table>
                     <TableHeader>
                        <TableRow className="border-white/8 hover:bg-transparent">
                           <TableHead className="w-[90px] text-right text-zinc-500">{fa.table.rank}</TableHead>
                           <TableHead className="text-right text-zinc-500">{fa.settings.name}</TableHead>
                           <TableHead className="text-right text-zinc-500">{fa.table.assigned}</TableHead>
                           <TableHead className="text-right text-zinc-500">{fa.table.done}</TableHead>
                           <TableHead className="text-right text-zinc-500">{fa.table.speed}</TableHead>
                        </TableRow>
                     </TableHeader>
                     <TableBody>
                        {loading ? (
                           <TableRow className="border-white/8">
                              <TableCell colSpan={5} className="py-8 text-center text-zinc-500">
                                 {fa.app.loading}
                              </TableCell>
                           </TableRow>
                        ) : rows.length === 0 ? (
                           <TableRow className="border-white/8">
                              <TableCell colSpan={5} className="py-8 text-center text-zinc-500">
                                 {fa.app.empty}
                              </TableCell>
                           </TableRow>
                        ) : (
                           rows.map((row, index) => {
                              const rank = index + 1;
                              return (
                                 <TableRow
                                    key={row.userId}
                                    className={cn(
                                       'border-white/8 hover:bg-white/[0.025]',
                                       rank === 1 && 'bg-amber-400/[0.06] hover:bg-amber-400/[0.08]'
                                    )}
                                 >
                                    <TableCell className="text-zinc-300">
                                       <span className="inline-flex items-center gap-1.5">
                                          <RankTrophy rank={rank} />
                                          <span className="text-sm">{formatFaNumber(rank)}</span>
                                       </span>
                                    </TableCell>
                                    <TableCell>
                                       <div className="flex min-w-[220px] items-center gap-3">
                                          <LinearAvatar name={row.name} src={row.avatarUrl} className="size-7" />
                                          <div className="min-w-0 space-y-1">
                                             <div className="flex flex-wrap items-center gap-2">
                                                <span className="truncate font-medium text-zinc-200">{row.name}</span>
                                                {rank === 1 ? (
                                                   <Badge className="rounded-full border-amber-300/30 bg-amber-300/12 px-2.5 py-0.5 text-[11px] text-amber-100">
                                                      {fa.leaderboard.topEmployeeBadge}
                                                   </Badge>
                                                ) : null}
                                             </div>
                                             <div className="ltr truncate text-xs text-zinc-500">{row.email}</div>
                                          </div>
                                       </div>
                                    </TableCell>
                                    <TableCell className="text-zinc-300">
                                       {formatFaNumber(row.assignedCount)}
                                    </TableCell>
                                    <TableCell className="text-zinc-100">{formatFaNumber(row.doneCount)}</TableCell>
                                    <TableCell className="text-zinc-300">
                                       <span className="inline-flex items-center gap-2">
                                          <span>{formatSpeedRatio(row.speedRatio)}</span>
                                          <span className="text-xs text-zinc-500">
                                             ({formatFaNumber(row.doneCount)}/{formatFaNumber(row.assignedCount)})
                                          </span>
                                       </span>
                                    </TableCell>
                                 </TableRow>
                              );
                           })
                        )}
                     </TableBody>
                  </Table>
               </div>
            </CardContent>
         </Card>
      </div>
   );
}
