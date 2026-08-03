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
import { type HiddenPeopleControls, useHiddenPeople } from './hidden-people';
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
   /** Undefined on snapshots cached before agents existed; read as HUMAN. */
   kind?: string;
   avatarUrl?: string | null;
}

function isAgent(person: GraphPersonInput): boolean {
   return person.kind === 'AGENT';
}

export interface BuildTeamOverviewGraphInput {
   day: WorkspaceDay;
   /** People the reader has taken off their own graph; they keep their seat, just not on screen. */
   hiddenPersonIds?: ReadonlySet<string>;
   people: GraphPersonInput[];
   tasks: GraphTaskInput[];
   workspaceLabel: string;
}

/** A person who has a seat on the graph but is currently hidden, for the panel that restores them. */
export interface HiddenPerson {
   userId: string;
   name: string;
   avatarUrl: string | null;
   agent: boolean;
   /** Today Load size, so the panel says what is being kept off the graph, not just who. */
   taskCount: number;
}

export interface TeamOverviewGraphBuild extends TeamOverviewGraph {
   hidden: HiddenPerson[];
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
   hiddenPersonIds,
   people,
   tasks,
   workspaceLabel,
}: BuildTeamOverviewGraphInput): TeamOverviewGraphBuild {
   const loadByPerson = new Map<string, TaskGraphNode[]>();
   const members = new Map(people.map((person) => [person.id, person]));

   for (const task of tasks) {
      const assigneeId = task.assignee?.id;
      const assignee = assigneeId ? members.get(assigneeId) : undefined;
      if (!assigneeId || !assignee || !isInTodayLoad(task, day)) continue;

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
         agent: isAgent(assignee),
      };

      const existing = loadByPerson.get(assigneeId);
      if (existing) existing.push(node);
      else loadByPerson.set(assigneeId, [node]);
   }

   // An agent is a teammate, so it keeps its seat whether or not it is holding work — a colleague
   // who flickers off the graph the moment they go idle is not a colleague. Guests keep the
   // conditional seat they always had: they are outside contributors, visible while they carry work.
   const seatedPeople = people
      .filter((person) => isAgent(person) || alwaysVisibleRoles.has(person.role) || loadByPerson.has(person.id))
      .sort((left, right) => byName(left.name, right.name));

   // Hiding someone takes their cluster with them: the load hangs off the person, so with nobody to
   // hang from it has nowhere to be. Only people who would otherwise be drawn are reported as
   // hidden — a stale id from someone who has since left the workspace is nothing to offer back.
   const visiblePeople = hiddenPersonIds?.size
      ? seatedPeople.filter((person) => !hiddenPersonIds.has(person.id))
      : seatedPeople;
   const hidden: HiddenPerson[] = hiddenPersonIds?.size
      ? seatedPeople
           .filter((person) => hiddenPersonIds.has(person.id))
           .map((person) => ({
              userId: person.id,
              name: person.name,
              avatarUrl: person.avatarUrl ?? null,
              agent: isAgent(person),
              taskCount: loadByPerson.get(person.id)?.length ?? 0,
           }))
      : [];

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
         agent: isAgent(person),
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

   return { nodes, links, hidden };
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

export interface TeamOverviewGraphState extends TeamOverviewGraphBuild, Omit<HiddenPeopleControls, 'hidden'> {
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
   // The slug, not the display name: a workspace can be renamed without the reader's hidden list
   // quietly resetting.
   const { hidden, hidePerson, showAllPeople, showPerson } = useHiddenPeople(session?.workspace?.slug || orgId || '');

   const graph = useMemo(
      () =>
         buildTeamOverviewGraph({
            day,
            hiddenPersonIds: hidden,
            people: taskSync.users,
            tasks: taskSync.tasks,
            workspaceLabel,
         }),
      [day, hidden, taskSync.tasks, taskSync.users, workspaceLabel]
   );

   return {
      ...graph,
      day,
      hasBootstrapped: taskSync.hasBootstrapped,
      hidePerson,
      loading: taskSync.loading,
      error: taskSync.error,
      showAllPeople,
      showPerson,
   };
}
