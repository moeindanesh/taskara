import type { ComponentType } from 'react';
import {
   Activity,
   Bell,
   BookOpen,
   Building2,
   ClipboardList,
   FileChartColumn,
   FolderKanban,
   Headphones,
   ListChecks,
   ListTodo,
   Megaphone,
   ScanEye,
   Settings,
   Share2,
   Users,
   UsersRound,
   Diamond,
} from 'lucide-react';
import type { WorkspaceNavigationIcon } from '@/lib/workspace-navigation';

export const workspaceNavigationIcons: Record<
   WorkspaceNavigationIcon,
   ComponentType<{ className?: string }>
> = {
   attention: Activity,
   cases: Headphones,
   communications: Megaphone,
   'daily-report': ClipboardList,
   departments: Building2,
   inbox: Bell,
   knowledge: BookOpen,
   manager: ScanEye,
   members: Users,
   milestones: Diamond,
   overview: Share2,
   projects: FolderKanban,
   reports: FileChartColumn,
   settings: Settings,
   tasks: ListTodo,
   teams: UsersRound,
   triage: ListChecks,
};
