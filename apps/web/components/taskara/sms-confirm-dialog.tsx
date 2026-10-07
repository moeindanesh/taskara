'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { fa } from '@/lib/fa-copy';

type SmsConfirmDialogProps = {
   open: boolean;
   onOpenChange: (open: boolean) => void;
   title: string;
   description: string;
   confirmLabel: string;
   pending?: boolean;
   onConfirm: () => void;
};

export function SmsConfirmDialog({
   open,
   onOpenChange,
   title,
   description,
   confirmLabel,
   pending = false,
   onConfirm,
}: SmsConfirmDialogProps) {
   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent
            showCloseButton={false}
            className="max-w-[460px] gap-0 overflow-hidden rounded-[18px] border-white/10 bg-[#1d1d20] p-0 text-zinc-100 shadow-[0_18px_70px_rgb(0_0_0/0.55)]"
         >
            <DialogHeader className="border-b border-white/7 px-5 py-4 text-right">
               <DialogTitle className="text-sm font-semibold text-zinc-100">{title}</DialogTitle>
               <DialogDescription className="mt-1 text-sm leading-6 text-zinc-400">{description}</DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-row items-center justify-end gap-2 border-t border-white/7 px-5 py-3">
               <Button
                  type="button"
                  variant="ghost"
                  className="h-8 rounded-full px-4 text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100"
                  disabled={pending}
                  onClick={() => onOpenChange(false)}
               >
                  {fa.app.cancel}
               </Button>
               <Button
                  type="button"
                  className="h-8 rounded-full bg-indigo-700 dark:bg-indigo-500 px-4 text-white hover:bg-indigo-800 dark:hover:bg-indigo-400 disabled:bg-indigo-500/40"
                  disabled={pending}
                  onClick={onConfirm}
               >
                  {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                  {confirmLabel}
               </Button>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}
