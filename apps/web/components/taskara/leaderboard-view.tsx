'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, Check, ChevronDown, Trophy } from 'lucide-react';
import moment from 'moment-jalaali';
import { LinearAvatar } from '@/components/taskara/linear-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fa } from '@/lib/fa-copy';
import { taskaraRequest } from '@/lib/taskara-client';
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

type LeaderboardTimeRange = 'daily' | 'weekly' | 'monthly' | 'yearly';

type TimeRangeBounds = {
   start: Date;
   endExclusive: Date;
};

type TimeRangeLabel = {
   title: string;
   detail: string;
};

moment.loadPersian({ dialect: 'persian-modern', usePersianDigits: true });

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

function getTimeRangeBounds(timeRange: LeaderboardTimeRange, now = moment()): TimeRangeBounds {
   const localNow = now.clone().locale('fa');

   if (timeRange === 'daily') {
      const start = localNow.clone().startOf('day');
      const endExclusive = start.clone().add(1, 'day');
      return { start: start.toDate(), endExclusive: endExclusive.toDate() };
   }

   if (timeRange === 'weekly') {
      const start = localNow.clone().startOf('week');
      const endExclusive = start.clone().add(1, 'week');
      return { start: start.toDate(), endExclusive: endExclusive.toDate() };
   }

   if (timeRange === 'monthly') {
      const start = localNow.clone().startOf('jMonth');
      const endExclusive = start.clone().add(1, 'jMonth');
      return { start: start.toDate(), endExclusive: endExclusive.toDate() };
   }

   const start = localNow.clone().startOf('jYear');
   const endExclusive = start.clone().add(1, 'jYear');
   return { start: start.toDate(), endExclusive: endExclusive.toDate() };
}

function getTimeRangeLabels(now = moment()): Record<LeaderboardTimeRange, TimeRangeLabel> {
   const localNow = now.clone().locale('fa');
   const weekStart = localNow.clone().startOf('week');
   const weekEnd = localNow.clone().endOf('week');

   return {
      daily: { title: fa.leaderboard.daily, detail: localNow.format('dddd jD jMMMM') },
      weekly: { title: fa.leaderboard.weekly, detail: `${weekStart.format('jMM/jDD')}-${weekEnd.format('jMM/jDD')}` },
      monthly: { title: fa.leaderboard.monthly, detail: localNow.format('jMMMM') },
      yearly: { title: fa.leaderboard.yearly, detail: localNow.format('jYYYY') },
   };
}

function TimeRangeLabelText({
   label,
   className,
}: {
   label: TimeRangeLabel;
   className?: string;
}) {
   return (
      <span className={cn('inline-flex items-baseline gap-1 whitespace-nowrap [direction:rtl] [unicode-bidi:plaintext]', className)}>
         <span>{label.title}</span>
         <span className="text-[10px] text-zinc-400">({label.detail})</span>
      </span>
   );
}

type LeaderboardResponse = {
   items: LeaderboardRow[];
   total: number;
};

export function LeaderboardView() {
   const [rows, setRows] = useState<LeaderboardRow[]>([]);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState('');
   const [timeRange, setTimeRange] = useState<LeaderboardTimeRange>('daily');
   const timeRangeBounds = useMemo(() => getTimeRangeBounds(timeRange), [timeRange]);

   const loadLeaderboard = useCallback(async (bounds: TimeRangeBounds) => {
      setLoading(true);
      setError('');
      try {
         const query = new URLSearchParams({
            startsAt: bounds.start.toISOString(),
            endsAt: bounds.endExclusive.toISOString(),
            teamId: 'all',
         });
         const response = await taskaraRequest<LeaderboardResponse>(`/leaderboard?${query.toString()}`);
         setRows(response.items);
      } catch (err) {
         setError(err instanceof Error ? err.message : fa.leaderboard.loadFailed);
      } finally {
         setLoading(false);
      }
   }, []);

   useEffect(() => {
      void loadLeaderboard(timeRangeBounds);
   }, [loadLeaderboard, timeRangeBounds]);

   const timeRangeLabels = getTimeRangeLabels();
   const timeRangeLabel = timeRangeLabels[timeRange];

   return (
      <div className="space-y-5 px-6 py-6">
         <Card className="relative overflow-hidden border-white/8 bg-[#19191b] text-zinc-100">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-amber-300/10 to-transparent" />
            <CardHeader className="relative border-b border-white/7">
               <div className="relative flex flex-wrap items-start gap-3">
                  <div className="space-y-1">
                     <CardTitle className="flex items-center gap-2">
                        <Trophy className="size-5 text-amber-300" />
                        {fa.nav.leaderboard}
                     </CardTitle>
                     <CardDescription className="text-zinc-500">
                        {fa.pages.leaderboardDescription}
                     </CardDescription>
                  </div>
                  <div className="ms-auto flex items-center gap-2">
                     <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
                        <CalendarDays className="size-3.5" />
                        {fa.leaderboard.timeFilter}
                     </span>
                     <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                           <Button
                              size="xs"
                              variant="secondary"
                              className="h-8 min-w-[260px] justify-between border border-white/10 bg-black/20 text-xs text-zinc-200 hover:bg-black/30"
                           >
                              <TimeRangeLabelText label={timeRangeLabel} />
                              <ChevronDown className="size-3.5 opacity-60" />
                           </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                           align="end"
                           className="w-[260px] border-white/10 bg-[#1f1f22] text-zinc-100"
                        >
                           <DropdownMenuItem onClick={() => setTimeRange('daily')} className="justify-between [direction:rtl]">
                              <TimeRangeLabelText label={timeRangeLabels.daily} />
                              {timeRange === 'daily' ? <Check className="size-3.5 text-amber-300" /> : null}
                           </DropdownMenuItem>
                           <DropdownMenuItem onClick={() => setTimeRange('weekly')} className="justify-between [direction:rtl]">
                              <TimeRangeLabelText label={timeRangeLabels.weekly} />
                              {timeRange === 'weekly' ? <Check className="size-3.5 text-amber-300" /> : null}
                           </DropdownMenuItem>
                           <DropdownMenuItem onClick={() => setTimeRange('monthly')} className="justify-between [direction:rtl]">
                              <TimeRangeLabelText label={timeRangeLabels.monthly} />
                              {timeRange === 'monthly' ? <Check className="size-3.5 text-amber-300" /> : null}
                           </DropdownMenuItem>
                           <DropdownMenuItem onClick={() => setTimeRange('yearly')} className="justify-between [direction:rtl]">
                              <TimeRangeLabelText label={timeRangeLabels.yearly} />
                              {timeRange === 'yearly' ? <Check className="size-3.5 text-amber-300" /> : null}
                           </DropdownMenuItem>
                        </DropdownMenuContent>
                     </DropdownMenu>
                  </div>
               </div>
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
                           <TableHead className="w-[120px] text-right text-zinc-500">{fa.table.assigned}</TableHead>
                           <TableHead className="w-[120px] text-right text-zinc-500">{fa.table.done}</TableHead>
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
                                    <TableCell className="w-[120px] text-right text-zinc-300">
                                       {formatFaNumber(row.assignedCount)}
                                    </TableCell>
                                    <TableCell className="w-[120px] text-right text-zinc-100">
                                       {formatFaNumber(row.doneCount)}
                                    </TableCell>
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
