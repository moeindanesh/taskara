import { InboxItem, inboxItems as mockNotifications, NotificationType } from '@/mock-data/inbox';
import { create } from 'zustand';

interface NotificationsState {
   // Data
   notifications: InboxItem[];
   selectedNotification: InboxItem | undefined;

   // Actions
   setSelectedNotification: (notification: InboxItem | undefined) => void;
   markAsRead: (id: string) => void;
   markAllAsRead: () => void;
   markAsUnread: (id: string) => void;

   // Filters
   getUnreadNotifications: () => InboxItem[];
   getReadNotifications: () => InboxItem[];
   getNotificationsByType: (type: NotificationType) => InboxItem[];
   getNotificationsByUser: (userId: string) => InboxItem[];

   // Utility functions
   getNotificationById: (id: string) => InboxItem | undefined;
   getUnreadCount: () => number;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
   // Initial state
   notifications: mockNotifications,
   selectedNotification: undefined,

   // Actions
   setSelectedNotification: (notification: InboxItem | undefined) => {
      set({ selectedNotification: notification });
   },

   markAsRead: (id: string) => {
      set((state) => ({
         notifications: state.notifications.map((notification) =>
            notification.id === id ? { ...notification, read: true } : notification
         ),
         selectedNotification:
            state.selectedNotification?.id === id
               ? { ...state.selectedNotification, read: true }
               : state.selectedNotification,
      }));
   },

   markAllAsRead: () => {
      set((state) => ({
         notifications: state.notifications.map((notification) => ({
            ...notification,
            read: true,
         })),
         selectedNotification: state.selectedNotification
            ? { ...state.selectedNotification, read: true }
            : undefined,
      }));
   },

   markAsUnread: (id: string) => {
      set((state) => ({
         notifications: state.notifications.map((notification) =>
            notification.id === id ? { ...notification, read: false } : notification
         ),
         selectedNotification:
            state.selectedNotification?.id === id
               ? { ...state.selectedNotification, read: false }
               : state.selectedNotification,
      }));
   },

   // Filters
   getUnreadNotifications: () => {
      return get().notifications.filter((notification) => !notification.read);
   },

   getReadNotifications: () => {
      return get().notifications.filter((notification) => notification.read);
   },

   getNotificationsByType: (type: NotificationType) => {
      return get().notifications.filter((notification) => notification.type === type);
   },

   getNotificationsByUser: (userId: string) => {
      return get().notifications.filter((notification) => notification.user.id === userId);
   },

   // Utility functions
   getNotificationById: (id: string) => {
      return get().notifications.find((notification) => notification.id === id);
   },

   getUnreadCount: () => {
      return get().notifications.filter((notification) => !notification.read).length;
   },
}));
