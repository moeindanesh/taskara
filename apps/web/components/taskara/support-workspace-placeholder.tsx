import { Headphones, ShieldAlert } from 'lucide-react';
import { fa } from '@/lib/fa-copy';
import { SupportDepartmentsView } from '@/components/taskara/support-departments-view';
import { useSupportWorkspace } from '@/lib/support-workspace-provider';

export function SupportSetupView() {
   useSupportWorkspace();
   return <SupportDepartmentsView setup />;
}

export function SupportNoAccessView() {
   useSupportWorkspace();
   return <SupportPlaceholder icon={ShieldAlert} title={fa.support.noAccessTitle} body={fa.support.noAccessBody} />;
}

export function SupportFeaturePlaceholder({ title }: { title: string }) {
   useSupportWorkspace();
   return <SupportPlaceholder icon={Headphones} title={title} body={fa.support.comingSoon} />;
}

function SupportPlaceholder({
   body,
   footer,
   icon: Icon,
   title,
}: {
   body: string;
   footer?: React.ReactNode;
   icon: React.ComponentType<{ className?: string }>;
   title: string;
}) {
   return (
      <div dir="rtl" className="flex min-h-full items-center justify-center bg-[#101011] p-6 text-zinc-200">
         <div className="w-full max-w-xl rounded-2xl border border-white/8 bg-white/[0.025] p-8 text-center shadow-2xl shadow-black/20">
            <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-indigo-400/10 text-indigo-300">
               <Icon className="size-6" />
            </span>
            <h2 className="mt-5 text-lg font-semibold">{title}</h2>
            <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-zinc-500">{body}</p>
            {footer ? <div className="mt-6">{footer}</div> : null}
         </div>
      </div>
   );
}
