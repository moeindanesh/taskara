import { useEffect, useState } from 'react';
import { FileText, X } from 'lucide-react';
import { fa } from '@/lib/fa-copy';

export function ComposerAttachmentPreviewList({ files, onRemove, disabled = false }: {
   files: File[];
   onRemove: (index: number) => void;
   disabled?: boolean;
}) {
   if (!files.length) return null;
   return (
      <div className="mt-3 flex max-h-64 flex-wrap gap-3 overflow-y-auto pb-2">
         {files.map((file, index) => (
            <AttachmentPreview key={`${file.name}-${file.size}-${file.lastModified}-${index}`} file={file} disabled={disabled} onRemove={() => onRemove(index)} />
         ))}
      </div>
   );
}

function AttachmentPreview({ file, disabled, onRemove }: { file: File; disabled: boolean; onRemove: () => void }) {
   const [previewUrl, setPreviewUrl] = useState<string | null>(null);
   const [failed, setFailed] = useState(false);
   const extension = file.name.includes('.') ? file.name.split('.').pop()?.toUpperCase() : '';
   const format = extension || file.type || 'فایل';
   const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(file.name);
   useEffect(() => {
      setFailed(false);
      if (!isImage) { setPreviewUrl(null); return; }
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
   }, [file, isImage]);

   return (
      <div className="relative w-44 overflow-hidden rounded-lg border border-border bg-muted/30" title={file.name}>
         {isImage ? (
            <div className="flex h-24 items-center justify-center bg-muted/40">
               {previewUrl && !failed ? <img src={previewUrl} alt={file.name} className="h-full w-full object-contain" onError={() => setFailed(true)} /> : <FileText className="size-7 text-muted-foreground" />}
            </div>
         ) : <FileText className="mx-3 mt-3 size-6 text-muted-foreground" />}
         <div className="px-3 py-2">
            <div className="truncate text-xs font-medium text-foreground" dir="auto">{file.name}</div>
            <div className="mt-1 truncate text-[11px] text-muted-foreground" dir="auto">{format} · {formatAttachmentSize(file.size)}</div>
         </div>
         <button type="button" aria-label={`${fa.issue.removeAttachment}: ${file.name}`} disabled={disabled} onClick={onRemove} className="absolute end-1 top-1 rounded-full border border-border bg-background p-1 text-foreground hover:bg-muted disabled:opacity-50">
            <X className="size-3" />
         </button>
      </div>
   );
}

function formatAttachmentSize(bytes: number) {
   const units = ['B', 'KB', 'MB', 'GB'];
   let size = bytes;
   let index = 0;
   while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
   return `${size.toLocaleString('fa-IR', { maximumFractionDigits: 1 })} ${units[index]}`;
}
