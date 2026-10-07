import { Accordion, Button, Label, ListBox, Select } from '@heroui/react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Shared HeroUI controls for the support workspace, including portalled overlays. */
export function SupportButton({ className, ...props }: ComponentProps<typeof Button>) {
   return <Button className={cn('support-ui rounded-lg', className)} {...props} />;
}

export function SupportSelect({ label, value, onChange, options, placeholder, className, disabled, showLabel = false }: {
   label: string;
   value: string;
   onChange: (value: string) => void;
   options: readonly { value: string; label: string }[];
   placeholder?: string;
   className?: string;
   disabled?: boolean;
   showLabel?: boolean;
}) {
   return (
      <Select
         aria-label={label}
         className={cn('support-ui min-w-0', className)}
         isDisabled={disabled}
         placeholder={placeholder}
         value={value || null}
         onChange={(key) => onChange(key == null || key === '__all' ? '' : String(key))}
      >
         {showLabel ? <Label>{label}</Label> : null}
         <Select.Trigger className="min-h-9 w-full rounded-lg border border-border bg-background shadow-none">
            <Select.Value className="truncate" />
            <Select.Indicator />
         </Select.Trigger>
         <Select.Popover className="support-ui max-w-[calc(100vw-2rem)]" placement="bottom start">
            <ListBox aria-label={label}>
               {options.map((option) => (
                  <ListBox.Item id={option.value || '__all'} key={option.value || '__all'} textValue={option.label}>
                     <span className="min-w-0 flex-1">{option.label}</span>
                     <ListBox.ItemIndicator />
                  </ListBox.Item>
               ))}
            </ListBox>
         </Select.Popover>
      </Select>
   );
}

export function SupportDisclosure({ title, children, defaultExpanded = false }: {
   title: string;
   children: ReactNode;
   defaultExpanded?: boolean;
}) {
   return (
      <Accordion className="support-ui rounded-xl border border-border bg-background px-4" defaultExpandedKeys={defaultExpanded ? ['content'] : []}>
         <Accordion.Item id="content">
            <Accordion.Heading>
               <Accordion.Trigger className="py-3 text-sm font-medium">
                  {title}<Accordion.Indicator />
               </Accordion.Trigger>
            </Accordion.Heading>
            <Accordion.Panel><Accordion.Body className="pb-4 pt-1">{children}</Accordion.Body></Accordion.Panel>
         </Accordion.Item>
      </Accordion>
   );
}
