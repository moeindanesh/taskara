import { User, users } from './users';
import { Status, status } from './status';
import { Priority, priorities } from './priorities';
import { LabelInterface, labels } from './labels';
import { Project, projects } from './projects';

const exampleRepositoryUrl = import.meta.env.VITE_TASKARA_EXAMPLE_REPOSITORY_URL || 'Repository link';

export type NotificationType =
   | 'comment'
   | 'mention'
   | 'assignment'
   | 'status'
   | 'reopened'
   | 'closed'
   | 'edited'
   | 'created'
   | 'upload';

export interface InboxItem {
   id: string;
   identifier: string;
   title: string;
   description: string;
   status: Status;
   assignee: User | null;
   priority: Priority;
   labels: LabelInterface[];
   createdAt: string;
   cycleId: string;
   project?: Project;
   subissues?: string[];
   dueDate?: string;
   // Propriétés spécifiques à l'inbox (conservées)
   content: string;
   type: NotificationType;
   user: User;
   timestamp: string;
   read: boolean;
}

export const inboxItems: InboxItem[] = [
   {
      id: '1',
      identifier: 'LNUI-101',
      title: 'Refactor Button component for full accessibility compliance',
      description:
         'Refactor the Button component to ensure full accessibility compliance with WCAG 2.1 guidelines',
      status: status[0],
      assignee: users[0],
      priority: priorities[1],
      labels: [labels[0]],
      createdAt: '2024-01-15T10:00:00Z',
      cycleId: '41',
      project: projects[0],

      dueDate: '2024-02-15T00:00:00Z',
      content: "I've attached the new design mockup",
      type: 'comment',
      user: users[0],
      timestamp: '10h',
      read: false,
   },
   {
      id: '2',
      identifier: 'LNUI-204',
      title: 'Optimize animations for smoother UI transitions',
      description:
         'Optimize all animations in the UI to provide smoother transitions and better user experience',
      status: status[1],
      assignee: users[1],
      priority: priorities[1],
      labels: [labels[1]],
      createdAt: '2024-01-12T14:30:00Z',
      cycleId: '41',
      project: projects[0],

      content: 'Section renamed from Animations to UI Transitions',
      type: 'comment',
      user: users[1],
      timestamp: '4d',
      read: false,
   },
   {
      id: '3',
      identifier: 'LNUI-309',
      title: 'Implement dark mode toggle with system preferences support',
      description: 'Add dark mode toggle functionality with automatic system preferences detection',
      status: status[2],
      assignee: users[2],
      priority: priorities[0],
      labels: [labels[2]],
      createdAt: '2024-01-10T09:15:00Z',
      cycleId: '41',
      project: projects[1],

      content: 'Reopened by GitHub',
      type: 'reopened',
      user: users[2],
      timestamp: '6d',
      read: true,
   },
   {
      id: '4',
      identifier: 'LNUI-415',
      title: 'Design new modal system with focus trapping',
      description:
         'Create a new modal system with proper focus management and accessibility features',
      status: status[3],
      assignee: users[3],
      priority: priorities[2],
      labels: [labels[0], labels[2]],
      createdAt: '2024-01-03T16:45:00Z',
      cycleId: '42',
      project: projects[0],

      content: exampleRepositoryUrl,
      type: 'comment',
      user: users[3],
      timestamp: '13d',
      read: false,
   },
   {
      id: '5',
      identifier: 'LNUI-501',
      title: 'Enhance responsiveness of Navbar',
      description: 'Improve the navbar responsiveness across all device sizes and orientations',
      status: status[4],
      assignee: users[4],
      priority: priorities[1],
      labels: [labels[1]],
      createdAt: '2023-12-28T11:20:00Z',
      cycleId: '42',
      project: projects[1],

      content: 'Retested on mobile and it works perfectly now',
      type: 'comment',
      user: users[4],
      timestamp: '18d',
      read: true,
   },
   {
      id: '6',
      identifier: 'LNUI-502',
      title: 'Optimize loading time of Footer',
      description: 'Optimize footer component loading time and reduce bundle size impact',
      status: status[5],
      assignee: users[4],
      priority: priorities[2],
      labels: [labels[3]],
      createdAt: '2023-12-28T11:25:00Z',
      cycleId: '42',
      project: projects[0],

      content: 'Updated performance metrics in the documentation',
      type: 'edited',
      user: users[4],
      timestamp: '18d',
      read: false,
   },
   {
      id: '7',
      identifier: 'LNUI-503',
      title: 'Refactor Sidebar for better accessibility',
      description:
         'Refactor the sidebar component to improve accessibility and keyboard navigation',
      status: status[3],
      assignee: users[2],
      priority: priorities[0],
      labels: [labels[0]],
      createdAt: '2023-12-20T08:00:00Z',
      cycleId: '43',
      project: projects[1],

      content: 'Closed by Linear',
      type: 'closed',
      user: users[2],
      timestamp: '4w',
      read: true,
   },
   {
      id: '8',
      identifier: 'LNUI-504',
      title: 'Implement new Card component design',
      description: 'Implement the new card component design with updated styling and interactions',
      status: status[1],
      assignee: users[2],
      priority: priorities[1],
      labels: [labels[2]],
      createdAt: '2023-12-20T08:15:00Z',
      cycleId: '43',
      project: projects[0],

      content: 'Closed by Linear',
      type: 'closed',
      user: users[2],
      timestamp: '4w',
      read: true,
   },
   {
      id: '9',
      identifier: 'LNUI-505',
      title: 'Improve Tooltip interactivity',
      description: 'Enhance tooltip component with better positioning and interaction patterns',
      status: status[5],
      assignee: users[2],
      priority: priorities[2],
      labels: [labels[1]],
      createdAt: '2023-12-20T08:30:00Z',
      cycleId: '43',
      project: projects[1],

      content: 'Closed by Linear',
      type: 'closed',
      user: users[2],
      timestamp: '4w',
      read: true,
   },
   {
      id: '10',
      identifier: 'LNUI-506',
      title: 'Fix Dropdown menu positioning',
      description: 'Fix dropdown menu positioning issues on mobile devices and small screens',
      status: status[2],
      assignee: users[0],
      priority: priorities[0],
      labels: [labels[0]],
      createdAt: '2023-12-15T13:45:00Z',
      cycleId: '44',
      project: projects[0],

      content:
         'Bug not reproducible on my Firefox mobile. Either it was a temporary issue or a cache problem.',
      type: 'comment',
      user: users[0],
      timestamp: '1mo',
      read: false,
   },
   {
      id: '11',
      identifier: 'LNUI-507',
      title: 'Implement annotation tools for PDF viewer',
      description: 'Add annotation tools functionality to the PDF viewer component',
      status: status[3],
      assignee: users[1],
      priority: priorities[1],
      labels: [labels[2]],
      createdAt: '2023-12-10T10:00:00Z',
      cycleId: '44',
      project: projects[1],

      content: 'Marked as completed by idriss.ben',
      type: 'status',
      user: users[1],
      timestamp: '5w',
      read: false,
   },
   {
      id: '12',
      identifier: 'LNUI-508',
      title: 'Restore previous editor interface',
      description: 'Restore the previous editor interface design based on user feedback',
      status: status[0],
      assignee: users[5],
      priority: priorities[1],
      labels: [labels[1]],
      createdAt: '2023-12-10T10:15:00Z',
      cycleId: '44',
      project: projects[0],

      content: 'I finished reviewing PR #839 | Review summary: Positive points',
      type: 'comment',
      user: users[5],
      timestamp: '5w',
      read: true,
   },
   {
      id: '13',
      identifier: 'LNUI-509',
      title: 'Revamp Button states and interactions',
      description: 'Revamp button component states and interaction patterns for better UX',
      status: status[5],
      assignee: users[5],
      priority: priorities[2],
      labels: [labels[1]],
      createdAt: '2023-12-10T10:30:00Z',
      cycleId: '44',
      project: projects[1],

      content: '🔍 Review completed for PR #808! I did a complete review of your PR',
      type: 'comment',
      user: users[5],
      timestamp: '5w',
      read: true,
   },
   {
      id: '14',
      identifier: 'LNUI-510',
      title: 'Dashboard: adapt breadcrumb text in feature view',
      description:
         'Adapt breadcrumb text display in the dashboard feature view for better navigation',
      status: status[2],
      assignee: users[2],
      priority: priorities[2],
      labels: [labels[1]],
      createdAt: '2023-12-05T15:20:00Z',
      cycleId: '45',
      project: projects[0],

      content: 'Reopened by GitHub',
      type: 'reopened',
      user: users[2],
      timestamp: '6w',
      read: false,
   },
   {
      id: '15',
      identifier: 'LNUI-511',
      title: 'Fix audio file upload from mobile devices',
      description: 'Fix issues with audio file upload functionality on mobile devices',
      status: status[1],
      assignee: users[4],
      priority: priorities[0],
      labels: [labels[0]],
      createdAt: '2023-12-05T15:35:00Z',
      cycleId: '45',
      project: projects[1],

      content:
         "@in now that it's in production, I've tested it and don't have the issue anymore; we can close this ticket",
      type: 'mention',
      user: users[4],
      timestamp: '6w',
      read: false,
   },
   {
      id: '16',
      identifier: 'LNUI-512',
      title: 'Show transcription preview',
      description: 'Add transcription preview functionality to the media player component',
      status: status[4],
      assignee: users[6],
      priority: priorities[1],
      labels: [labels[2]],
      createdAt: '2023-11-28T12:00:00Z',
      cycleId: '45',
      project: projects[0],

      content: 'leo.samu assigned the issue to you',
      type: 'assignment',
      user: users[6],
      timestamp: '7w',
      read: true,
   },
   {
      id: '17',
      identifier: 'LNUI-513',
      title: 'Improve Tooltip interactivity',
      description: 'Enhance tooltip component interactivity and user experience',
      status: status[3],
      assignee: users[2],
      priority: priorities[2],
      labels: [labels[1]],
      createdAt: '2023-11-28T12:15:00Z',
      cycleId: '45',
      project: projects[1],

      content: 'Marked as completed by samuel.baudry',
      type: 'status',
      user: users[2],
      timestamp: '7w',
      read: true,
   },
];

export const filterByReadStatus = (items: InboxItem[], isRead: boolean): InboxItem[] => {
   return items.filter((item) => item.read === isRead);
};

export const filterByType = (items: InboxItem[], type: NotificationType): InboxItem[] => {
   return items.filter((item) => item.type === type);
};

export const filterByUser = (items: InboxItem[], userId: string): InboxItem[] => {
   return items.filter((item) => item.user.id === userId);
};

export const markAsRead = (items: InboxItem[], itemId: string): InboxItem[] => {
   return items.map((item) => (item.id === itemId ? { ...item, read: true } : item));
};

export const markAllAsRead = (items: InboxItem[]): InboxItem[] => {
   return items.map((item) => ({ ...item, read: true }));
};
