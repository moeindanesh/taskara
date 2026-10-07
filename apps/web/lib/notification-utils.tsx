import React from 'react';
import {
   MessageCircle,
   AtSign,
   UserPlus,
   GitPullRequest,
   RotateCcw,
   X,
   Edit,
   Plus,
   Upload,
} from 'lucide-react';
import { NotificationType } from '@/mock-data/inbox';
import { cn } from '@/lib/utils';

export function getNotificationIcon(type: NotificationType, className?: string) {
   switch (type) {
      case 'comment':
         return <MessageCircle className={cn('text-blue-700 dark:text-blue-500', className)} />;
      case 'mention':
         return <AtSign className={cn('text-orange-800 dark:text-orange-500', className)} />;
      case 'assignment':
         return <UserPlus className={cn('text-green-700 dark:text-green-500', className)} />;
      case 'status':
         return <GitPullRequest className={cn('text-purple-700 dark:text-purple-500', className)} />;
      case 'reopened':
         return <RotateCcw className={cn('text-yellow-800 dark:text-yellow-500', className)} />;
      case 'closed':
         return <X className={cn('text-gray-500', className)} />;
      case 'edited':
         return <Edit className={cn('text-indigo-700 dark:text-indigo-500', className)} />;
      case 'created':
         return <Plus className={cn('text-emerald-700 dark:text-emerald-500', className)} />;
      case 'upload':
         return <Upload className={cn('text-pink-700 dark:text-pink-500', className)} />;
      default:
         return <MessageCircle className={cn('text-blue-700 dark:text-blue-500', className)} />;
   }
}
