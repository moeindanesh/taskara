'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { useAuthSession } from '@/store/auth-store';
import {
   type GraphLink,
   type GraphNode,
   type PersonGraphNode,
   type TaskGraphNode,
   type TeamOverviewGraph,
   personNodeId,
   personNodeRadius,
   taskNodeId,
   taskNodeRadius,
   workspaceNodeId,
   workspaceNodeRadius,
} from './graph-model';
import { type TodayLoadTask, type WorkspaceDay, currentWorkspaceDay, isInTodayLoad, isOverdue } from './today-load';

/** Roles that hold a seat on the graph whether or not they have work today. */
const alwaysVisibleRoles = new Set(['OWNER', 'ADMIN', 'MEMBER']);

export interface GraphTaskInput extends TodayLoadTask {
   id: string;
   key: string;
   title: string;
   weight?: number | null;
   dueAt?: string | null;
   assignee?: { id: string } | null;
}

export interface GraphPersonInput {
   id: string;
   name: string;
   role: string;
   avatarUrl?: string | null;
}

export interface BuildTeamOverviewGraphInput {
   day: WorkspaceDay;
   people: GraphPersonInput[];
   tasks: GraphTaskInput[];
   workspaceLabel: string;
}

const byName = new Intl.Collator('fa').compare;

/**
 * Projects the workspace into nodes and links.
 *
 * Unassigned work is deliberately absent: the graph answers "who is carrying what today", and the
 * manager cockpit's attention queue is where ownerless tasks surface. Work assigned to someone who
 * is no longer a workspace member is dropped for the same reason — it has no person to hang from.
 */
export function buildTeamOverviewGraph({
   day,
   people,
   tasks,
   workspaceLabel,
}: BuildTeamOverviewGraphInput): TeamOverviewGraph {
   const loadByPerson = new Map<string, TaskGraphNode[]>();
   const members = new Map(people.map((person) => [person.id, person]));

   for (const task of tasks) {
      const assigneeId = task.assignee?.id;
      if (!assigneeId || !members.has(assigneeId) || !isInTodayLoad(task, day)) continue;

      const weight = task.weight ?? null;
      const node: TaskGraphNode = {
         id: taskNodeId(task.id),
         kind: 'task',
         label: task.title,
         radius: taskNodeRadius(weight),
         taskId: task.id,
         taskKey: task.key,
         status: (task.status ?? '').toUpperCase(),
         weight,
         overdue: isOverdue(task, day),
         dueAt: task.dueAt ?? null,
         assigneeId,
      };

      const existing = loadByPerson.get(assigneeId);
      if (existing) existing.push(node);
      else loadByPerson.set(assigneeId, [node]);
   }

   const visiblePeople = people
      .filter((person) => alwaysVisibleRoles.has(person.role) || loadByPerson.has(person.id))
      .sort((left, right) => byName(left.name, right.name));

   const nodes: GraphNode[] = [
      {
         id: workspaceNodeId,
         kind: 'workspace',
         label: workspaceLabel,
         radius: workspaceNodeRadius,
      },
   ];
   const links: GraphLink[] = [];

   for (const person of visiblePeople) {
      const load = (loadByPerson.get(person.id) ?? []).sort((left, right) =>
         left.taskKey.localeCompare(right.taskKey, 'en')
      );
      const node: PersonGraphNode = {
         id: personNodeId(person.id),
         kind: 'person',
         label: person.name,
         radius: personNodeRadius,
         userId: person.id,
         avatarUrl: person.avatarUrl ?? null,
         role: person.role,
         taskCount: load.length,
         totalWeight: load.reduce((total, task) => total + (task.weight ?? 0), 0),
      };

      nodes.push(node);
      links.push({
         id: `membership:${person.id}`,
         source: workspaceNodeId,
         target: node.id,
         kind: 'membership',
      });

      for (const task of load) {
         nodes.push(task);
         links.push({
            id: `assignment:${task.taskId}`,
            source: node.id,
            target: task.id,
            kind: 'assignment',
         });
      }
   }

   return { nodes, links };
}

/** Re-resolves the workspace day roughly every minute so the graph rolls over at local midnight. */
export function useWorkspaceDay(): WorkspaceDay {
   const [day, setDay] = useState(() => currentWorkspaceDay());

   useEffect(() => {
      const timer = window.setInterval(() => {
         setDay((current) => {
            const next = currentWorkspaceDay();
            return next.dateKey === current.dateKey ? current : next;
         });
      }, 60_000);
      return () => window.clearInterval(timer);
   }, []);

   return day;
}

export interface TeamOverviewGraphState extends TeamOverviewGraph {
   day: WorkspaceDay;
   hasBootstrapped: boolean;
   loading: boolean;
   error: string;
}

export function useTeamOverviewGraph(): TeamOverviewGraphState {
   const { orgId } = useParams();
   const { session } = useAuthSession();
   const taskSync = useWorkspaceTaskSync();
   const day = useWorkspaceDay();

   const workspaceLabel = session?.workspace?.name || orgId || '';

   const graph = useMemo(
      () =>
         buildTeamOverviewGraph({
            day,
            people: taskSync.users,
            tasks: taskSync.tasks,
            workspaceLabel,
         }),
      [day, taskSync.tasks, taskSync.users, workspaceLabel]
   );

   return {
      ...graph,
      day,
      hasBootstrapped: taskSync.hasBootstrapped,
      loading: taskSync.loading,
      error: taskSync.error,
   };
}
