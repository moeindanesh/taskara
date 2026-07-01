'use client';

import type { CSSProperties, JSX, ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin';
import { AutoLinkPlugin, createLinkMatcherWithRegExp } from '@lexical/react/LexicalAutoLinkPlugin';
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin';
import { LexicalComposer, type InitialConfigType } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { DraggableBlockPlugin_EXPERIMENTAL } from '@lexical/react/LexicalDraggableBlockPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { TablePlugin } from '@lexical/react/LexicalTablePlugin';
import {
   LexicalTypeaheadMenuPlugin,
   MenuOption,
   useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { $createCodeNode, $isCodeNode, CodeNode } from '@lexical/code-core';
import { $isLinkNode, AutoLinkNode, LinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link';
import {
   $insertList,
   $isListItemNode,
   $isListNode,
   INSERT_CHECK_LIST_COMMAND,
   INSERT_ORDERED_LIST_COMMAND,
   INSERT_UNORDERED_LIST_COMMAND,
   ListItemNode,
   ListNode,
} from '@lexical/list';
import {
   BOLD_STAR,
   BOLD_UNDERSCORE,
   CHECK_LIST,
   CODE,
   $convertFromMarkdownString,
   HEADING,
   INLINE_CODE,
   ITALIC_STAR,
   ITALIC_UNDERSCORE,
   LINK,
   ORDERED_LIST,
   QUOTE,
   STRIKETHROUGH,
   UNORDERED_LIST,
} from '@lexical/markdown';
import {
   $createHeadingNode,
   $createQuoteNode,
   $isHeadingNode,
   DRAG_DROP_PASTE,
   HeadingNode,
   QuoteNode,
} from '@lexical/rich-text';
import { $setBlocksType } from '@lexical/selection';
import {
   $computeTableMapSkipCellCheck,
   INSERT_TABLE_COMMAND,
   TableCellHeaderStates,
   TableCellNode,
   TableNode,
   TableRowNode,
   $createTableCellNode,
   $createTableNode,
   $createTableRowNode,
   $deleteTableColumnAtSelection,
   $deleteTableRowAtSelection,
   $getTableCellNodeFromLexicalNode,
   $getTableColumnIndexFromTableCellNode,
   $getTableNodeFromLexicalNodeOrThrow,
   $getTableRowIndexFromTableCellNode,
   $insertTableColumnAtSelection,
   $insertTableRowAtSelection,
} from '@lexical/table';
import {
   $applyNodeReplacement,
   $createParagraphNode,
   $createRangeSelection,
   $createTextNode,
   $findMatchingParent,
   $getNodeByKey,
   $getRoot,
   $getSelection,
   $insertNodes,
   $isBlockElementNode,
   $isElementNode,
   $isNodeSelection,
   $isParagraphNode,
   $isRangeSelection,
   $isTextNode,
   $normalizeSelection__EXPERIMENTAL,
   $setSelection,
   BLUR_COMMAND,
   CLICK_COMMAND,
   COMMAND_PRIORITY_CRITICAL,
   COMMAND_PRIORITY_EDITOR,
   COMMAND_PRIORITY_HIGH,
   COMMAND_PRIORITY_LOW,
   CONTROLLED_TEXT_INSERTION_COMMAND,
   DecoratorNode,
   FORMAT_ELEMENT_COMMAND,
   FOCUS_COMMAND,
   FORMAT_TEXT_COMMAND,
   getDOMSelection,
   getTextDirection,
   INDENT_CONTENT_COMMAND,
   INSERT_TAB_COMMAND,
   KEY_DOWN_COMMAND,
   KEY_ENTER_COMMAND,
   KEY_ESCAPE_COMMAND,
   KEY_BACKSPACE_COMMAND,
   KEY_DELETE_COMMAND,
   KEY_TAB_COMMAND,
   mergeRegister,
   OUTDENT_CONTENT_COMMAND,
   PASTE_COMMAND,
   SELECTION_CHANGE_COMMAND,
   TextNode,
   type DOMConversionMap,
   type DOMConversionOutput,
   type DOMExportOutput,
   type ElementNode,
   type EditorConfig,
   type EditorState,
   type EditorThemeClasses,
   type LexicalCommand,
   type LexicalEditor,
   type LexicalNode,
   type LexicalUpdateJSON,
   type NodeKey,
   type RangeSelection,
   type SerializedLexicalNode,
   type SerializedTextNode,
   type Spread,
   type TextFormatType,
} from 'lexical';
import {
   AlignCenter,
   AlignJustify,
   AlignLeft,
   AlignRight,
   ArrowDown,
   ArrowLeft,
   ArrowRight,
   ArrowUp,
   AtSign,
   Bold,
   Columns3,
   Code2,
   GripVertical,
   Heading1,
   Heading2,
   Heading3,
   ImagePlus,
   Italic,
   Link2,
   Link2Off,
   Loader2,
   List,
   ListChecks,
   ListOrdered,
   Paperclip,
   Pilcrow,
   Quote,
   Rows3,
   Strikethrough,
   Subscript,
   Superscript,
   Table2,
   Trash2,
   Underline,
} from 'lucide-react';
import {
   ContextMenu,
   ContextMenuContent,
   ContextMenuItem,
   ContextMenuLabel,
   ContextMenuSeparator,
   ContextMenuShortcut,
   ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { markCachedAvatarImageFailed, useCachedAvatarImage } from '@/lib/avatar-cache';
import type { TaskaraUser } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';

type MentionUser = Pick<TaskaraUser, 'avatarUrl' | 'email' | 'id' | 'name'>;

type DescriptionEditorProps = {
   value: string;
   onChange: (value: string) => void;
   ariaLabel?: string;
   autoFocus?: boolean;
   className?: string;
   contentClassName?: string;
   focusToken?: number;
   onBlur?: (value: string) => void;
   onCancel?: () => void;
   onFocus?: () => void;
   placeholder: string;
   placeholderClassName?: string;
   showToolbar?: boolean;
   slashCommands?: DescriptionSlashCommand[];
   toolbarClassName?: string;
   uploadInlineImages?: (files: File[]) => Promise<DescriptionInlineImage[]>;
   onInlineImageUploadError?: (error: unknown) => void;
   uploadInlineFiles?: (files: File[]) => Promise<DescriptionInlineFile[]>;
   onInlineFileUploadError?: (error: unknown) => void;
   users?: MentionUser[];
   variant?: 'framed' | 'plain';
};

export type DescriptionSlashCommand = {
   command: (editor: LexicalEditor) => void;
   description: string;
   icon: ReactNode;
   key: string;
   keywords: string[];
   shortcut?: string;
   title: string;
};

type DescriptionInlineImage = {
   altText?: string;
   height?: number;
   src: string;
   width?: number;
};

type InlineFileKind = 'file' | 'media';

type DescriptionInlineFile = {
   kind?: InlineFileKind;
   mimeType?: string | null;
   name?: string;
   sizeBytes?: number | null;
   src: string;
};

type SerializedMentionNode = Spread<
   {
      mentionName: string;
      mentionUserId?: string;
      type: 'mention';
      version: 1;
   },
   SerializedTextNode
>;

type SerializedInlineImageNode = Spread<
   {
      altText: string;
      height?: number;
      src: string;
      type: 'inline-image';
      version: 1;
      width?: number;
   },
   SerializedLexicalNode
>;

type SerializedInlineFileNode = Spread<
   {
      kind: InlineFileKind;
      mimeType?: string;
      name: string;
      sizeBytes?: number;
      src: string;
      type: 'inline-file';
      version: 1;
   },
   SerializedLexicalNode
>;

type SerializedInlineUploadPlaceholderNode = Spread<
   {
      fileName: string;
      type: 'inline-upload-placeholder';
      uploadKind: 'file' | 'image';
      version: 1;
   },
   SerializedLexicalNode
>;

const externalSyncTag = 'taskara-description-editor:external-sync';
const autoDirectionSyncTag = 'taskara-description-editor:auto-direction-sync';
const descriptionMarkdownTransformers = [
   HEADING,
   QUOTE,
   CODE,
   UNORDERED_LIST,
   ORDERED_LIST,
   CHECK_LIST,
   BOLD_STAR,
   BOLD_UNDERSCORE,
   ITALIC_STAR,
   ITALIC_UNDERSCORE,
   STRIKETHROUGH,
   INLINE_CODE,
   LINK,
];
const draggableBlockMenuClassName = 'taskara-description-block-drag-menu';
const urlAutoLinkMatcher = createLinkMatcherWithRegExp(
   /((https?:\/\/|www\.)[^\s<>"']+)/i,
   (text) => (text.startsWith('http') ? text : `https://${text}`)
);
const emailAutoLinkMatcher = createLinkMatcherWithRegExp(
   /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/,
   (text) => `mailto:${text}`
);
const autoLinkMatchers = [urlAutoLinkMatcher, emailAutoLinkMatcher];

const editorTheme: EditorThemeClasses = {
   code:
      'my-4 block overflow-x-auto rounded-lg border border-white/10 bg-[#101011] px-4 py-3 text-left font-mono text-[0.9em] leading-6 text-zinc-200 [direction:ltr] [tab-size:3] first:mt-0 last:mb-0',
   heading: {
      h1: 'taskara-editor-heading mb-3 mt-7 text-2xl leading-9 text-zinc-100 first:mt-0',
      h2: 'taskara-editor-heading mb-2.5 mt-6 text-xl leading-8 text-zinc-100 first:mt-0',
      h3: 'taskara-editor-heading mb-2 mt-5 text-lg leading-7 text-zinc-100 first:mt-0',
   },
   image: 'mx-1 inline-flex max-w-full align-middle',
   indent: 'lexical-indent',
   link: 'text-indigo-300 underline decoration-indigo-300/35 underline-offset-2 transition hover:text-indigo-200 hover:decoration-indigo-200/70',
   list: {
      checklist: 'my-3 p-0 first:mt-0 last:mb-0',
      listitem: 'mx-5 my-1.5 ps-1 leading-7 marker:text-zinc-500',
      listitemChecked:
         "relative mx-1 my-1.5 block min-h-7 list-none py-0 pl-1 pr-7 leading-7 text-zinc-500 line-through before:absolute before:right-0 before:top-[0.85rem] before:block before:size-4 before:-translate-y-1/2 before:rounded before:border before:border-indigo-500/70 before:bg-indigo-600 before:content-[''] after:absolute after:right-[0.28rem] after:top-[0.85rem] after:block after:h-1.5 after:w-2 after:-translate-y-1/2 after:-rotate-45 after:border-b-2 after:border-l-2 after:border-white after:content-[''] dark:before:border-indigo-400/60 dark:before:bg-indigo-500/45",
      listitemUnchecked:
         "relative mx-1 my-1.5 block min-h-7 list-none py-0 pl-1 pr-7 leading-7 before:absolute before:right-0 before:top-[0.85rem] before:block before:size-4 before:-translate-y-1/2 before:rounded before:border before:border-zinc-300 before:bg-white before:content-[''] dark:before:border-white/20 dark:before:bg-white/5",
      nested: {
         listitem: 'list-none before:hidden after:hidden',
      },
      ol: 'my-3 list-decimal p-0 [list-style-position:outside] marker:text-zinc-500 first:mt-0 last:mb-0',
      olDepth: [
         'my-3 list-decimal p-0 [list-style-position:outside] first:mt-0 last:mb-0',
         'my-3 p-0 [list-style-position:outside] [list-style-type:upper-alpha] first:mt-0 last:mb-0',
         'my-3 p-0 [list-style-position:outside] [list-style-type:lower-alpha] first:mt-0 last:mb-0',
         'my-3 p-0 [list-style-position:outside] [list-style-type:upper-roman] first:mt-0 last:mb-0',
         'my-3 p-0 [list-style-position:outside] [list-style-type:lower-roman] first:mt-0 last:mb-0',
      ],
      ul: 'my-3 list-disc p-0 [list-style-position:outside] marker:text-zinc-500 first:mt-0 last:mb-0',
   },
   ltr: 'text-left',
   paragraph: 'my-3 whitespace-pre-wrap leading-7 first:mt-0 last:mb-0',
   quote: 'my-4 border-s-2 border-white/14 ps-4 leading-7 text-zinc-400 first:mt-0 last:mb-0',
   root: 'taskara-prose-editor text-right [--lexical-indent-base-value:2.25rem]',
   rtl: 'text-right',
   tab: 'relative no-underline',
   table:
      'my-4 w-full border-collapse overflow-hidden rounded-lg border border-white/10 text-sm text-zinc-200 [direction:rtl]',
   tableCell:
      'min-w-24 border border-white/10 bg-white/[0.015] px-3 py-2 align-top outline-none',
   tableCellHeader:
      'min-w-24 border border-white/10 bg-white/[0.06] px-3 py-2 align-top font-semibold text-zinc-100 outline-none',
   tableCellSelected: 'bg-indigo-500/15',
   tableRow: 'border-white/10',
   tableScrollableWrapper: 'my-4 overflow-x-auto',
   tableSelected: 'ring-1 ring-indigo-400/50',
   tableSelection: 'bg-indigo-500/20',
   text: {
      bold: 'taskara-editor-text-bold text-zinc-100',
      code: 'rounded bg-white/8 px-1 py-0.5 font-mono text-[0.92em] text-zinc-100',
      italic: 'italic text-zinc-200',
      strikethrough: 'text-zinc-400 line-through decoration-zinc-500',
      underline: 'underline underline-offset-2',
      underlineStrikethrough: 'underline line-through underline-offset-2',
   },
};

function $convertInlineImageElement(domNode: Node): DOMConversionOutput | null {
   const image = domNode as HTMLImageElement;
   const src = image.getAttribute('src');
   if (!src || src.startsWith('file:///')) return null;

   const width = positiveNumber(image.getAttribute('width')) || positiveNumber(image.style.width);
   const height = positiveNumber(image.getAttribute('height')) || positiveNumber(image.style.height);

   return {
      node: $createInlineImageNode({
         altText: image.alt || '',
         height,
         src,
         width,
      }),
   };
}

function $convertInlineFileElement(domNode: Node): DOMConversionOutput | null {
   const anchor = domNode as HTMLAnchorElement;
   if (anchor.tagName !== 'A') return null;
   if (anchor.getAttribute('data-taskara-inline-file') !== 'true') return null;

   const src = anchor.getAttribute('href');
   if (!src || src.startsWith('file:///')) return null;

   const fileName = anchor.getAttribute('data-taskara-inline-name') || anchor.textContent?.trim() || '';
   const mimeType = anchor.getAttribute('data-taskara-inline-mime') || undefined;
   const sizeBytes = positiveNumber(anchor.getAttribute('data-taskara-inline-size'));
   const kind = inferInlineFileKind(mimeType, fileName, anchor.getAttribute('data-taskara-inline-kind'));

   return {
      node: $createInlineFileNode({
         kind,
         mimeType,
         name: fileName || inlineFileDisplayName(undefined, src),
         sizeBytes,
         src,
      }),
   };
}

function SelectableInlineAsset({
   children,
   className,
   nodeKey,
   title,
}: {
   children: ReactNode;
   className?: string;
   nodeKey: NodeKey;
   title?: string;
}) {
   const [editor] = useLexicalComposerContext();
   const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
   const isEditable = useLexicalEditable();
   const rootRef = useRef<HTMLSpanElement | null>(null);

   useEffect(() => {
      return mergeRegister(
         editor.registerCommand<MouseEvent>(
            CLICK_COMMAND,
            (event) => {
               const target = event.target;
               if (!isEditable || !(target instanceof Node) || !rootRef.current?.contains(target)) return false;
               event.preventDefault();
               if (event.shiftKey) {
                  setSelected(!isSelected);
               } else {
                  clearSelection();
                  setSelected(true);
               }
               return true;
            },
            COMMAND_PRIORITY_LOW
         ),
         editor.registerCommand(
            KEY_DELETE_COMMAND,
            (event) => {
               if (!isSelected) return false;
               const selection = $getSelection();
               if (!$isNodeSelection(selection)) return false;

               event.preventDefault();
               let deleted = false;
               editor.update(() => {
                  const node = $getNodeByKey(nodeKey);
                  if (
                     $isInlineImageNode(node) ||
                     $isInlineFileNode(node) ||
                     $isInlineUploadPlaceholderNode(node)
                  ) {
                     node.remove();
                     deleted = true;
                  }
               });
               return deleted;
            },
            COMMAND_PRIORITY_LOW
         ),
         editor.registerCommand(
            KEY_BACKSPACE_COMMAND,
            (event) => {
               if (!isSelected) return false;
               const selection = $getSelection();
               if (!$isNodeSelection(selection)) return false;

               event.preventDefault();
               let deleted = false;
               editor.update(() => {
                  const node = $getNodeByKey(nodeKey);
                  if (
                     $isInlineImageNode(node) ||
                     $isInlineFileNode(node) ||
                     $isInlineUploadPlaceholderNode(node)
                  ) {
                     node.remove();
                     deleted = true;
                  }
               });
               return deleted;
            },
            COMMAND_PRIORITY_LOW
         )
      );
   }, [clearSelection, editor, isEditable, isSelected, nodeKey, setSelected]);

   return (
      <span
         ref={rootRef}
         className={cn(
            'mx-0.5 inline-flex max-w-full align-middle transition',
            isSelected ? 'ring-2 ring-indigo-400/70 ring-offset-1 ring-offset-[#111113]' : '',
            className
         )}
         contentEditable={false}
         dir="ltr"
         draggable={false}
         title={title}
         onMouseDown={(event) => event.preventDefault()}
      >
         {children}
      </span>
   );
}

function InlineImageComponent({
   altText,
   height,
   nodeKey,
   src,
   width,
}: {
   altText: string;
   height?: number;
   nodeKey: NodeKey;
   src: string;
   width?: number;
}) {
   return (
      <SelectableInlineAsset nodeKey={nodeKey} title={altText || 'تصویر'}>
         <img
            alt={altText}
            className="inline max-h-80 max-w-full rounded-md border border-white/10 bg-black/20 object-contain align-middle"
            draggable={false}
            loading="lazy"
            src={src}
            style={{
               height: height ? `${height}px` : undefined,
               width: width ? `${width}px` : undefined,
            }}
         />
      </SelectableInlineAsset>
   );
}

function InlineFileComponent({
   kind,
   mimeType,
   name,
   nodeKey,
   sizeBytes,
   src,
}: {
   kind: InlineFileKind;
   mimeType?: string;
   name: string;
   nodeKey: NodeKey;
   sizeBytes?: number;
   src: string;
}) {
   const fileKind = inferInlineFileKind(mimeType, name, kind);
   const fileSize = formatFileSize(sizeBytes);
   const displayName = inlineFileDisplayName(name, src);

   return (
      <SelectableInlineAsset nodeKey={nodeKey} title={displayName}>
         <span className="inline-flex max-w-[320px] items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.045] px-2 py-1 text-xs leading-5 text-zinc-300">
            <Paperclip className="size-3.5 shrink-0 text-zinc-500" />
            <span className="min-w-0 truncate">{displayName}</span>
            <span className="shrink-0 text-[11px] text-zinc-500">
               {fileKind === 'media' ? 'رسانه' : 'فایل'}
               {fileSize ? ` • ${fileSize}` : ''}
            </span>
         </span>
      </SelectableInlineAsset>
   );
}

function InlineUploadPlaceholderComponent({
   fileName,
   nodeKey,
   uploadKind,
}: {
   fileName: string;
   nodeKey: NodeKey;
   uploadKind: 'file' | 'image';
}) {
   const fallbackName = uploadKind === 'image' ? 'تصویر' : 'فایل';

   return (
      <SelectableInlineAsset nodeKey={nodeKey} title="در حال بارگذاری">
         <span className="inline-flex max-w-[320px] items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-xs leading-5 text-zinc-500">
            {uploadKind === 'image' ? <ImagePlus className="size-3.5 shrink-0" /> : <Paperclip className="size-3.5 shrink-0" />}
            <span className="min-w-0 truncate">{fileName.trim() || fallbackName}</span>
            <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
               <Loader2 className="size-3 animate-spin" />
               <span className="animate-pulse">در حال بارگذاری</span>
            </span>
         </span>
      </SelectableInlineAsset>
   );
}

class InlineImageNode extends DecoratorNode<JSX.Element> {
   __altText: string;
   __height?: number;
   __src: string;
   __width?: number;

   static getType(): string {
      return 'inline-image';
   }

   static clone(node: InlineImageNode): InlineImageNode {
      return new InlineImageNode(node.__src, node.__altText, node.__width, node.__height, node.__key);
   }

   static importDOM(): DOMConversionMap | null {
      return {
         img: () => ({
            conversion: $convertInlineImageElement,
            priority: 0,
         }),
      };
   }

   static importJSON(serializedNode: SerializedInlineImageNode): InlineImageNode {
      return $createInlineImageNode(serializedNode).updateFromJSON(serializedNode);
   }

   constructor(src: string, altText: string, width?: number, height?: number, key?: NodeKey) {
      super(key);
      this.__src = src;
      this.__altText = altText;
      this.__width = width;
      this.__height = height;
   }

   isInline(): true {
      return true;
   }

   createDOM(config: EditorConfig): HTMLElement {
      const dom = document.createElement('span');
      const className = config.theme.image;
      if (className) dom.className = className;
      return dom;
   }

   updateDOM(): false {
      return false;
   }

   exportDOM(): DOMExportOutput {
      const image = document.createElement('img');
      image.setAttribute('src', this.__src);
      image.setAttribute('alt', this.__altText);
      if (this.__width) image.setAttribute('width', String(this.__width));
      if (this.__height) image.setAttribute('height', String(this.__height));
      image.style.maxWidth = '100%';
      image.style.verticalAlign = 'middle';
      return { element: image };
   }

   updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedInlineImageNode>): this {
      return super.updateFromJSON(serializedNode).setImage(serializedNode);
   }

   exportJSON(): SerializedInlineImageNode {
      return {
         ...super.exportJSON(),
         altText: this.__altText,
         height: this.__height,
         src: this.__src,
         type: 'inline-image',
         version: 1,
         width: this.__width,
      };
   }

   decorate(): JSX.Element {
      return (
         <InlineImageComponent
            altText={this.__altText}
            height={this.__height}
            nodeKey={this.getKey()}
            src={this.__src}
            width={this.__width}
         />
      );
   }

   setImage({ altText = '', height, src, width }: DescriptionInlineImage): this {
      const writable = this.getWritable();
      writable.__altText = altText;
      writable.__height = height;
      writable.__src = src;
      writable.__width = width;
      return writable;
   }
}

function $createInlineImageNode({ altText = '', height, src, width }: DescriptionInlineImage): InlineImageNode {
   return $applyNodeReplacement(new InlineImageNode(src, altText, width, height));
}

function $isInlineImageNode(node: LexicalNode | null | undefined): node is InlineImageNode {
   return node instanceof InlineImageNode;
}

class InlineFileNode extends DecoratorNode<JSX.Element> {
   __kind: InlineFileKind;
   __mimeType?: string;
   __name: string;
   __sizeBytes?: number;
   __src: string;

   static getType(): string {
      return 'inline-file';
   }

   static clone(node: InlineFileNode): InlineFileNode {
      return new InlineFileNode(node.__src, node.__name, node.__kind, node.__mimeType, node.__sizeBytes, node.__key);
   }

   static importDOM(): DOMConversionMap | null {
      return {
         a: () => ({
            conversion: $convertInlineFileElement,
            priority: 1,
         }),
      };
   }

   static importJSON(serializedNode: SerializedInlineFileNode): InlineFileNode {
      return $createInlineFileNode(serializedNode).updateFromJSON(serializedNode);
   }

   constructor(src: string, name: string, kind: InlineFileKind, mimeType?: string, sizeBytes?: number, key?: NodeKey) {
      super(key);
      this.__src = src;
      this.__name = name;
      this.__kind = kind;
      this.__mimeType = mimeType;
      this.__sizeBytes = sizeBytes;
   }

   isInline(): true {
      return true;
   }

   createDOM(config: EditorConfig): HTMLElement {
      const dom = document.createElement('span');
      const className = config.theme.image;
      if (className) dom.className = className;
      return dom;
   }

   updateDOM(): false {
      return false;
   }

   exportDOM(): DOMExportOutput {
      const anchor = document.createElement('a');
      anchor.setAttribute('href', this.__src);
      anchor.setAttribute('data-taskara-inline-file', 'true');
      anchor.setAttribute('data-taskara-inline-kind', this.__kind);
      anchor.setAttribute('data-taskara-inline-name', this.__name);
      if (this.__mimeType) anchor.setAttribute('data-taskara-inline-mime', this.__mimeType);
      if (typeof this.__sizeBytes === 'number' && Number.isFinite(this.__sizeBytes) && this.__sizeBytes > 0) {
         anchor.setAttribute('data-taskara-inline-size', String(this.__sizeBytes));
      }
      anchor.textContent = this.__name;
      return { element: anchor };
   }

   updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedInlineFileNode>): this {
      return super.updateFromJSON(serializedNode).setFile(serializedNode);
   }

   exportJSON(): SerializedInlineFileNode {
      return {
         ...super.exportJSON(),
         kind: this.__kind,
         mimeType: this.__mimeType,
         name: this.__name,
         sizeBytes: this.__sizeBytes,
         src: this.__src,
         type: 'inline-file',
         version: 1,
      };
   }

   decorate(): JSX.Element {
      return (
         <InlineFileComponent
            kind={this.__kind}
            mimeType={this.__mimeType}
            name={this.__name}
            nodeKey={this.getKey()}
            sizeBytes={this.__sizeBytes}
            src={this.__src}
         />
      );
   }

   setFile({ kind, mimeType, name, sizeBytes, src }: DescriptionInlineFile & { kind: InlineFileKind; name: string }): this {
      const writable = this.getWritable();
      writable.__kind = kind;
      writable.__mimeType = normalizeNullableText(mimeType) || undefined;
      writable.__name = name.trim() || 'فایل';
      writable.__sizeBytes = sanitizeSizeBytes(sizeBytes);
      writable.__src = src;
      return writable;
   }
}

class InlineUploadPlaceholderNode extends DecoratorNode<JSX.Element> {
   __fileName: string;
   __uploadKind: 'file' | 'image';

   static getType(): string {
      return 'inline-upload-placeholder';
   }

   static clone(node: InlineUploadPlaceholderNode): InlineUploadPlaceholderNode {
      return new InlineUploadPlaceholderNode(node.__fileName, node.__uploadKind, node.__key);
   }

   static importJSON(serializedNode: SerializedInlineUploadPlaceholderNode): InlineUploadPlaceholderNode {
      return $createInlineUploadPlaceholderNode(serializedNode).updateFromJSON(serializedNode);
   }

   constructor(fileName: string, uploadKind: 'file' | 'image', key?: NodeKey) {
      super(key);
      this.__fileName = fileName;
      this.__uploadKind = uploadKind;
   }

   isInline(): true {
      return true;
   }

   createDOM(config: EditorConfig): HTMLElement {
      const dom = document.createElement('span');
      const className = config.theme.image;
      if (className) dom.className = className;
      return dom;
   }

   updateDOM(): false {
      return false;
   }

   updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedInlineUploadPlaceholderNode>): this {
      return super.updateFromJSON(serializedNode).setState(serializedNode.fileName, serializedNode.uploadKind);
   }

   exportJSON(): SerializedInlineUploadPlaceholderNode {
      return {
         ...super.exportJSON(),
         fileName: this.__fileName,
         type: 'inline-upload-placeholder',
         uploadKind: this.__uploadKind,
         version: 1,
      };
   }

   decorate(): JSX.Element {
      return (
         <InlineUploadPlaceholderComponent
            fileName={this.__fileName}
            nodeKey={this.getKey()}
            uploadKind={this.__uploadKind}
         />
      );
   }

   setState(fileName: string, uploadKind: 'file' | 'image'): this {
      const writable = this.getWritable();
      writable.__fileName = fileName;
      writable.__uploadKind = uploadKind;
      return writable;
   }
}

function $createInlineFileNode(file: DescriptionInlineFile & { kind?: InlineFileKind; name?: string }): InlineFileNode {
   const fileName = file.name?.trim() || inlineFileDisplayName(undefined, file.src);
   const kind = inferInlineFileKind(file.mimeType, fileName, file.kind);
   return $applyNodeReplacement(
      new InlineFileNode(file.src, fileName, kind, normalizeNullableText(file.mimeType), sanitizeSizeBytes(file.sizeBytes))
   );
}

function $isInlineFileNode(node: LexicalNode | null | undefined): node is InlineFileNode {
   return node instanceof InlineFileNode;
}

function $createInlineUploadPlaceholderNode({
   fileName,
   uploadKind,
}: {
   fileName: string;
   uploadKind: 'file' | 'image';
}): InlineUploadPlaceholderNode {
   return $applyNodeReplacement(new InlineUploadPlaceholderNode(fileName, uploadKind));
}

function $isInlineUploadPlaceholderNode(node: LexicalNode | null | undefined): node is InlineUploadPlaceholderNode {
   return node instanceof InlineUploadPlaceholderNode;
}

class MentionNode extends TextNode {
   __mentionName: string;
   __mentionUserId?: string;

   static getType(): string {
      return 'mention';
   }

   static clone(node: MentionNode): MentionNode {
      return new MentionNode(node.__mentionName, node.__mentionUserId, node.__key);
   }

   static importJSON(serializedNode: SerializedMentionNode): MentionNode {
      return $createMentionNode(serializedNode.mentionName, serializedNode.mentionUserId).updateFromJSON(serializedNode);
   }

   constructor(mentionName: string, mentionUserId?: string, key?: NodeKey) {
      super(`@${mentionName}`, key);
      this.__mentionName = mentionName;
      this.__mentionUserId = mentionUserId;
   }

   createDOM(config: EditorConfig, editor?: LexicalEditor): HTMLElement {
      const dom = super.createDOM(config, editor);
      dom.className =
         'mx-0.5 inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 align-baseline text-[0.92em] !font-medium text-indigo-700 dark:border-indigo-400/25 dark:bg-indigo-400/12 dark:text-indigo-200';
      dom.dir = 'auto';
      return dom;
   }

   updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedMentionNode>): this {
      return super.updateFromJSON(serializedNode).setMention(serializedNode.mentionName, serializedNode.mentionUserId);
   }

   exportJSON(): SerializedMentionNode {
      return {
         ...super.exportJSON(),
         mentionName: this.__mentionName,
         mentionUserId: this.__mentionUserId,
         type: 'mention',
         version: 1,
      };
   }

   canInsertTextBefore(): boolean {
      return false;
   }

   canInsertTextAfter(): boolean {
      return false;
   }

   isTextEntity(): true {
      return true;
   }

   setMention(mentionName: string, mentionUserId?: string): this {
      const writable = this.getWritable();
      writable.__mentionName = mentionName;
      writable.__mentionUserId = mentionUserId;
      writable.__text = `@${mentionName}`;
      return writable;
   }
}

function $createMentionNode(mentionName: string, mentionUserId?: string): MentionNode {
   const mentionNode = new MentionNode(mentionName, mentionUserId).setMode('segmented');
   return $applyNodeReplacement(mentionNode);
}

function isSerializedEditorValue(value: string) {
   if (!value.trim().startsWith('{')) return false;

   try {
      const parsed = JSON.parse(value) as { root?: { children?: unknown[]; type?: unknown } } | null;
      return Boolean(parsed?.root && parsed.root.type === 'root' && Array.isArray(parsed.root.children));
   } catch {
      return false;
   }
}

function $setPlainTextValue(value: string) {
   const root = $getRoot();
   const lines = value.split('\n');

   root.clear();
   lines.forEach((line, index) => {
      const paragraph = $createParagraphNode();
      if (line) paragraph.append($createTextNode(line));
      if (index === 0 || line || lines.length > 1) root.append(paragraph);
   });
   if (root.getChildrenSize() === 0) root.append($createParagraphNode());
}

function serializeEditorState(editorState: EditorState) {
   let isEmpty = true;
   editorState.read(() => {
      isEmpty = $isNodeEmpty($getRoot());
   });

   return isEmpty ? '' : JSON.stringify(editorState.toJSON());
}

function $isNodeEmpty(node: LexicalNode): boolean {
   if ($isInlineImageNode(node) || $isInlineFileNode(node) || $isInlineUploadPlaceholderNode(node)) return false;
   if ($isElementNode(node)) return node.getChildren().every((child) => $isNodeEmpty(child));
   return node.getTextContent().trim().length === 0;
}

function syncEditorValue(editor: LexicalEditor, value: string) {
   if (isSerializedEditorValue(value)) {
      try {
         editor.setEditorState(editor.parseEditorState(value), { tag: externalSyncTag });
         return;
      } catch {
         // Fall through to a plain text load for legacy or malformed content.
      }
   }

   editor.update(() => $setPlainTextValue(value), { tag: externalSyncTag });
}

function DescriptionEditorBridge({
   value,
   onBlur,
   onCancel,
   onChange,
   onFocus,
}: Pick<DescriptionEditorProps, 'value' | 'onBlur' | 'onCancel' | 'onChange' | 'onFocus'>) {
   const [editor] = useLexicalComposerContext();
   const latestValueRef = useRef(value);
   const onBlurRef = useRef(onBlur);
   const onCancelRef = useRef(onCancel);
   const onChangeRef = useRef(onChange);
   const onFocusRef = useRef(onFocus);

   useEffect(() => {
      onBlurRef.current = onBlur;
      onCancelRef.current = onCancel;
      onChangeRef.current = onChange;
      onFocusRef.current = onFocus;
   }, [onBlur, onCancel, onChange, onFocus]);

   useEffect(() => {
      if (value === latestValueRef.current) return;
      latestValueRef.current = value;
      syncEditorValue(editor, value);
   }, [editor, value]);

   useEffect(() => {
      return editor.registerUpdateListener(({ editorState, tags }) => {
         if (tags.has(externalSyncTag)) return;
         const serializedValue = serializeEditorState(editorState);
         if (serializedValue === latestValueRef.current) return;
         latestValueRef.current = serializedValue;
         onChangeRef.current(serializedValue);
      });
   }, [editor]);

   useEffect(() => {
      return editor.registerCommand(
         FOCUS_COMMAND,
         () => {
            onFocusRef.current?.();
            return false;
         },
         COMMAND_PRIORITY_LOW
      );
   }, [editor]);

   useEffect(() => {
      return editor.registerCommand(
         BLUR_COMMAND,
         () => {
            const serializedValue = serializeEditorState(editor.getEditorState());
            latestValueRef.current = serializedValue;
            onBlurRef.current?.(serializedValue);
            return false;
         },
         COMMAND_PRIORITY_LOW
      );
   }, [editor]);

   useEffect(() => {
      if (!onCancel) return;

      return editor.registerCommand(
         KEY_ESCAPE_COMMAND,
         (event) => {
            event.preventDefault();
            event.stopPropagation();
            onCancelRef.current?.();
            return true;
         },
         COMMAND_PRIORITY_HIGH
      );
   }, [editor, onCancel]);

   return null;
}

function DescriptionToolbar({ className }: { className?: string }) {
   const [editor] = useLexicalComposerContext();

   return (
      <div
         className={cn(
            'flex min-h-10 flex-wrap items-center justify-end gap-1 border-b border-white/8 bg-[#18181a] px-2 py-1.5 text-zinc-500',
            className
         )}
         dir="rtl"
      >
         <ToolbarButton
            label="منشن"
            onClick={() => editor.focus(() => editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, '@'))}
         >
            <AtSign className="size-3.5" />
         </ToolbarButton>
         <span className="mx-1 h-4 w-px bg-white/10" />
         <ToolbarButton
            label="چک لیست"
            onClick={() => editor.focus(() => editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined))}
         >
            <ListChecks className="size-3.5" />
         </ToolbarButton>
         <ToolbarButton
            label="جدول"
            onClick={() =>
               editor.focus(() =>
                  editor.dispatchCommand(INSERT_TABLE_COMMAND, { columns: '3', includeHeaders: true, rows: '3' })
               )
            }
         >
            <Table2 className="size-3.5" />
         </ToolbarButton>
         <ToolbarButton
            label="فهرست شماره دار"
            onClick={() => editor.focus(() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined))}
         >
            <ListOrdered className="size-3.5" />
         </ToolbarButton>
         <ToolbarButton
            label="فهرست"
            onClick={() => editor.focus(() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined))}
         >
            <List className="size-3.5" />
         </ToolbarButton>
         <span className="mx-1 h-4 w-px bg-white/10" />
         <ToolbarButton label="کد" onClick={() => editor.focus(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code'))}>
            <Code2 className="size-3.5" />
         </ToolbarButton>
         <ToolbarButton
            label="خط خورده"
            onClick={() => editor.focus(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough'))}
         >
            <Strikethrough className="size-3.5" />
         </ToolbarButton>
         <ToolbarButton label="کج" onClick={() => editor.focus(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic'))}>
            <Italic className="size-3.5" />
         </ToolbarButton>
         <ToolbarButton label="پررنگ" onClick={() => editor.focus(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold'))}>
            <Bold className="size-3.5" />
         </ToolbarButton>
      </div>
   );
}

function ToolbarButton({
   children,
   label,
   onClick,
}: {
   children: ReactNode;
   label: string;
   onClick: () => void;
}) {
   return (
      <Tooltip>
         <TooltipTrigger asChild>
            <button
               aria-label={label}
               className="inline-flex size-7 items-center justify-center rounded-md border border-transparent text-zinc-500 transition hover:border-white/8 hover:bg-white/8 hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-indigo-400/60 focus-visible:outline-none"
               title={label}
               type="button"
               onClick={onClick}
               onMouseDown={(event) => event.preventDefault()}
            >
               {children}
            </button>
         </TooltipTrigger>
         <TooltipContent className="border-white/10 bg-[#202023] text-zinc-300" side="top">
            {label}
         </TooltipContent>
      </Tooltip>
   );
}

class MentionOption extends MenuOption {
   user: MentionUser;

   constructor(user: MentionUser) {
      super(user.id);
      this.user = user;
      this.title = user.name;
   }
}

function MentionsPlugin({ users = [] }: { users?: MentionUser[] }): JSX.Element | null {
   const [editor] = useLexicalComposerContext();
   const [queryString, setQueryString] = useState<string | null>(null);
   const checkForMentionMatch = useBasicTypeaheadTriggerMatch('@', {
      allowWhitespace: false,
      maxLength: 40,
      minLength: 0,
   });

   const options = useMemo(() => {
      const query = (queryString || '').trim().toLocaleLowerCase('fa-IR');

      return users
         .filter((user) => {
            if (!query) return true;
            return (
               user.name.toLocaleLowerCase('fa-IR').includes(query) ||
               (user.email || '').toLocaleLowerCase('fa-IR').includes(query)
            );
         })
         .slice(0, 6)
         .map((user) => new MentionOption(user));
   }, [queryString, users]);

   const onSelectOption = useCallback(
      (selectedOption: MentionOption, textNodeContainingQuery: TextNode | null, closeMenu: () => void) => {
         editor.update(() => {
            const mentionNode = $createMentionNode(selectedOption.user.name, selectedOption.user.id);
            if (textNodeContainingQuery) {
               textNodeContainingQuery.replace(mentionNode);
            }
            mentionNode.selectNext();
            const selection = $getSelection();
            if ($isRangeSelection(selection)) selection.insertText(' ');
            closeMenu();
         });
      },
      [editor]
   );

   return (
      <LexicalTypeaheadMenuPlugin<MentionOption>
         ignoreEntityBoundary
         options={options}
         triggerFn={checkForMentionMatch}
         onQueryChange={setQueryString}
         onSelectOption={onSelectOption}
         menuRenderFn={(anchorElementRef, { options, selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => {
            return (
               <MentionMenu
                  anchorElementRef={anchorElementRef}
                  options={options}
                  selectedIndex={selectedIndex}
                  selectOptionAndCleanUp={selectOptionAndCleanUp}
                  setHighlightedIndex={setHighlightedIndex}
               />
            );
         }}
      />
   );
}

function MentionMenu({
   anchorElementRef,
   options,
   selectedIndex,
   selectOptionAndCleanUp,
   setHighlightedIndex,
}: {
   anchorElementRef: RefObject<HTMLElement | null>;
   options: MentionOption[];
   selectedIndex: number | null;
   selectOptionAndCleanUp: (option: MentionOption) => void;
   setHighlightedIndex: (index: number) => void;
}) {
   const anchor = anchorElementRef.current;
   const portalTarget = anchor?.ownerDocument.body;
   if (!anchor || !portalTarget || !options.length) return null;

   return createPortal(
      <div
         className="z-50 overflow-hidden rounded-lg border border-white/10 bg-[#202023] p-1.5 text-right shadow-2xl"
         dir="rtl"
         style={getFloatingMenuStyle(anchor)}
      >
         {options.map((option, index) => (
            <button
               key={option.key}
               ref={option.setRefElement}
               aria-selected={selectedIndex === index}
               className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-right text-sm text-zinc-300 outline-none transition',
                  selectedIndex === index ? 'bg-indigo-500/20 text-zinc-100' : 'hover:bg-white/8'
               )}
               role="option"
               type="button"
               onClick={() => selectOptionAndCleanUp(option)}
               onMouseDown={(event) => event.preventDefault()}
               onMouseEnter={() => setHighlightedIndex(index)}
            >
               <MentionAvatar user={option.user} />
               <span className="min-w-0 flex-1 truncate">{option.user.name}</span>
            </button>
         ))}
      </div>,
      portalTarget
   );
}

type FloatingMenuStyleOptions = {
   estimatedHeight?: number;
   maxHeight?: number;
   minWidth?: number;
   preferredWidth?: number;
};

class SlashCommandOption extends MenuOption {
   command: (editor: LexicalEditor) => void;
   description: string;
   iconNode: ReactNode;
   searchText: string;
   shortcut?: string;

   constructor({
      command,
      description,
      icon,
      key,
      keywords,
      shortcut,
      title,
   }: {
      command: (editor: LexicalEditor) => void;
      description: string;
      icon: ReactNode;
      key: string;
      keywords: string[];
      shortcut?: string;
      title: string;
   }) {
      super(key);
      this.command = command;
      this.description = description;
      this.iconNode = icon;
      this.shortcut = shortcut;
      this.title = title;
      this.searchText = [title, description, ...keywords].join(' ').toLocaleLowerCase('en-US');
   }
}

function $formatCurrentSelection(format: TextFormatType) {
   const selection = $getSelection();
   if ($isRangeSelection(selection)) selection.formatText(format);
}

function $setSelectionToCodeBlock() {
   const selection = $getSelection();
   if (!$isRangeSelection(selection)) return;

   const selectedListItems = $getSelectedListItems(selection);
   if (selectedListItems.length > 0) {
      const codeNode = $createCodeNode('markdown');
      codeNode.append($createTextNode(selectedListItems.map((item) => item.getTextContent()).join('\n')));

      const listRoots = Array.from(
         new Set(
            selectedListItems
               .map((item) => $findMatchingParent(item, (node) => $isListNode(node)))
               .filter((node): node is ListNode => Boolean(node))
         )
      );

      const firstListRoot = listRoots[0];
      if (firstListRoot) {
         firstListRoot.replace(codeNode);
         listRoots.slice(1).forEach((listRoot) => listRoot.remove());
         codeNode.selectStart();
         return;
      }
   }

   $setBlocksType(selection, () => $createCodeNode('markdown'));
}

function $getSelectedListItems(selection: RangeSelection): ListItemNode[] {
   const items = new Map<string, ListItemNode>();

   for (const node of selection.getNodes()) {
      const item = $isListItemNode(node)
         ? node
         : $findMatchingParent(node, (parentNode) => $isListItemNode(parentNode));
      if ($isListItemNode(item) && item.getTextContent().trim()) {
         items.set(item.getKey(), item);
      }
   }

   return Array.from(items.values()).sort((left, right) => {
      if (left.isBefore(right)) return -1;
      if (right.isBefore(left)) return 1;
      return 0;
   });
}

function createSlashCommandOptions({
   customCommands = [],
   editor,
   onFileUploadError,
   onImageUploadError,
   query,
   uploadFiles,
   uploadImages,
}: {
   customCommands?: DescriptionSlashCommand[];
   editor: LexicalEditor;
   onFileUploadError?: (error: unknown) => void;
   onImageUploadError?: (error: unknown) => void;
   query: string;
   uploadFiles?: (files: File[]) => Promise<DescriptionInlineFile[]>;
   uploadImages?: (files: File[]) => Promise<DescriptionInlineImage[]>;
}) {
   const dynamicOptions = createDynamicSlashCommandOptions(query);
   const customOptions = customCommands.map(
      (command) =>
         new SlashCommandOption({
            command: command.command,
            description: command.description,
            icon: command.icon,
            key: command.key,
            keywords: command.keywords,
            shortcut: command.shortcut,
            title: command.title,
         })
   );
   const baseOptions = [
      new SlashCommandOption({
         command: (activeEditor) => activeEditor.update(() => $formatCurrentSelection('bold')),
         description: 'پررنگ کردن متن انتخاب‌شده',
         icon: <Bold className="size-4" />,
         key: 'bold',
         keywords: ['bold', 'format', 'strong', 'پررنگ'],
         shortcut: '⌘B',
         title: 'پررنگ',
      }),
      new SlashCommandOption({
         command: (activeEditor) => activeEditor.update(() => $formatCurrentSelection('italic')),
         description: 'کج کردن متن انتخاب‌شده',
         icon: <Italic className="size-4" />,
         key: 'italic',
         keywords: ['italic', 'format', 'کج'],
         shortcut: '⌘I',
         title: 'کج',
      }),
      new SlashCommandOption({
         command: (activeEditor) => activeEditor.update(() => $formatCurrentSelection('underline')),
         description: 'زیرخط برای متن انتخاب‌شده',
         icon: <Underline className="size-4" />,
         key: 'underline',
         keywords: ['underline', 'format', 'زیرخط'],
         shortcut: '⌘U',
         title: 'زیرخط',
      }),
      new SlashCommandOption({
         command: (activeEditor) => activeEditor.update(() => $formatCurrentSelection('strikethrough')),
         description: 'خط زدن متن انتخاب‌شده',
         icon: <Strikethrough className="size-4" />,
         key: 'strikethrough',
         keywords: ['strike', 'strikethrough', 'format', 'خط'],
         title: 'خط خورده',
      }),
      new SlashCommandOption({
         command: (activeEditor) => activeEditor.update(() => $formatCurrentSelection('code')),
         description: 'نمایش متن به صورت کد',
         icon: <Code2 className="size-4" />,
         key: 'code',
         keywords: ['code', 'format', 'کد'],
         title: 'کد',
      }),
      new SlashCommandOption({
         command: (activeEditor) => activeEditor.update($setSelectionToCodeBlock),
         description: 'بلوک کد چندخطی با فونت ثابت',
         icon: <Code2 className="size-4" />,
         key: 'code-block',
         keywords: ['code block', 'fence', 'pre', 'markdown', 'کد'],
         shortcut: '```',
         title: 'بلوک کد',
      }),
      new SlashCommandOption({
         command: (activeEditor) => activeEditor.update(() => $setBlocksType($getSelection(), () => $createParagraphNode())),
         description: 'بلوک متن ساده',
         icon: <Pilcrow className="size-4" />,
         key: 'paragraph',
         keywords: ['text', 'normal', 'body', 'paragraph', 'متن'],
         title: 'متن ساده',
      }),
      new SlashCommandOption({
         command: (activeEditor) => activeEditor.update(() => $setBlocksType($getSelection(), () => $createHeadingNode('h1'))),
         description: 'تیتر بزرگ بخش',
         icon: <Heading1 className="size-4" />,
         key: 'heading-1',
         keywords: ['h1', 'title', 'heading', 'تیتر'],
         shortcut: '# Space',
         title: 'تیتر ۱',
      }),
      new SlashCommandOption({
         command: (activeEditor) => activeEditor.update(() => $setBlocksType($getSelection(), () => $createHeadingNode('h2'))),
         description: 'تیتر متوسط بخش',
         icon: <Heading2 className="size-4" />,
         key: 'heading-2',
         keywords: ['h2', 'subtitle', 'heading', 'تیتر'],
         shortcut: '## Space',
         title: 'تیتر ۲',
      }),
      new SlashCommandOption({
         command: (activeEditor) => activeEditor.update(() => $setBlocksType($getSelection(), () => $createHeadingNode('h3'))),
         description: 'تیتر کوچک بخش',
         icon: <Heading3 className="size-4" />,
         key: 'heading-3',
         keywords: ['h3', 'subheading', 'heading', 'تیتر'],
         shortcut: '### Space',
         title: 'تیتر ۳',
      }),
      new SlashCommandOption({
         command: (activeEditor) => activeEditor.update(() => $insertList('bullet')),
         description: 'ساخت فهرست نقطه‌ای',
         icon: <List className="size-4" />,
         key: 'bulleted-list',
         keywords: ['unordered', 'ul', 'list', 'bullet', 'فهرست'],
         shortcut: '- Space',
         title: 'فهرست نقطه‌ای',
      }),
      new SlashCommandOption({
         command: (activeEditor) => activeEditor.update(() => $insertList('number')),
         description: 'ساخت فهرست شماره‌دار',
         icon: <ListOrdered className="size-4" />,
         key: 'numbered-list',
         keywords: ['ordered', 'ol', 'list', 'number', 'فهرست'],
         shortcut: '1. Space',
         title: 'فهرست شماره‌دار',
      }),
      new SlashCommandOption({
         command: (activeEditor) => activeEditor.update(() => $insertList('check')),
         description: 'ساخت چک‌لیست',
         icon: <ListChecks className="size-4" />,
         key: 'checklist',
         keywords: ['todo', 'task', 'checkbox', 'checklist', 'چک'],
         shortcut: '[]',
         title: 'چک‌لیست',
      }),
      new SlashCommandOption({
         command: (activeEditor) => activeEditor.update(() => $setBlocksType($getSelection(), () => $createQuoteNode())),
         description: 'ساخت نقل‌قول',
         icon: <Quote className="size-4" />,
         key: 'blockquote',
         keywords: ['quote', 'blockquote', 'callout', 'نقل'],
         shortcut: '> Space',
         title: 'نقل‌قول',
      }),
      new SlashCommandOption({
         command: (activeEditor) =>
            activeEditor.update(() => $insertNodes([createTableNodeWithText([['', '', ''], ['', '', ''], ['', '', '']], true), $createParagraphNode()])),
         description: 'ساخت جدول ۳ در ۳',
         icon: <Table2 className="size-4" />,
         key: 'table',
         keywords: ['grid', 'markdown', 'cells', 'table', 'جدول'],
         shortcut: '| header |',
         title: 'جدول',
      }),
      new SlashCommandOption({
         command: (activeEditor) => insertLinkWithPrompt(activeEditor),
         description: 'لینک دادن به متن انتخاب‌شده',
         icon: <Link2 className="size-4" />,
         key: 'link',
         keywords: ['link', 'url', 'href', 'لینک'],
         shortcut: '⌘K',
         title: 'لینک',
      }),
      new SlashCommandOption({
         command: (activeEditor) => insertImageUrlWithPrompt(activeEditor),
         description: 'درج تصویر با آدرس',
         icon: <ImagePlus className="size-4" />,
         key: 'image-url',
         keywords: ['image', 'photo', 'picture', 'url', 'تصویر'],
         title: 'تصویر از لینک',
      }),
      ...(uploadImages
         ? [
              new SlashCommandOption({
                 command: (activeEditor) =>
                    selectAndUploadInlineImages(activeEditor, uploadImages, onImageUploadError),
                 description: 'بارگذاری تصویر در صفحه',
                 icon: <ImagePlus className="size-4" />,
                 key: 'image-upload',
                 keywords: ['image', 'photo', 'upload', 'file', 'تصویر'],
                 title: 'بارگذاری تصویر',
              }),
           ]
         : []),
      ...(uploadFiles
         ? [
              new SlashCommandOption({
                 command: (activeEditor) => selectAndUploadInlineFiles(activeEditor, uploadFiles, onFileUploadError),
                 description: 'بارگذاری فایل یا رسانه',
                 icon: <Paperclip className="size-4" />,
                 key: 'file-upload',
                 keywords: ['file', 'media', 'upload', 'attachment', 'پیوست'],
                 title: 'بارگذاری فایل',
              }),
           ]
         : []),
      new SlashCommandOption({
         command: (activeEditor) => activeEditor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) selection.insertText('@');
         }),
         description: 'منشن یک عضو فضای کاری',
         icon: <AtSign className="size-4" />,
         key: 'mention',
         keywords: ['user', 'member', 'person', 'mention', 'منشن'],
         shortcut: '@',
         title: 'منشن',
      }),
      ...(['right', 'center', 'left', 'justify'] as const).map((alignment) =>
         new SlashCommandOption({
            command: (activeEditor) => activeEditor.dispatchCommand(FORMAT_ELEMENT_COMMAND, alignment),
            description: 'تنظیم چینش بلوک فعلی',
            icon: alignmentIcon(alignment),
            key: `align-${alignment}`,
            keywords: ['align', 'justify', alignment, 'چینش'],
            title: alignmentLabel(alignment),
         })
      ),
   ];

   if (!query) return [...dynamicOptions, ...customOptions, ...baseOptions];
   const normalizedQuery = query.toLocaleLowerCase('fa-IR');
   return [
      ...dynamicOptions,
      ...customOptions.filter((option) => option.searchText.includes(normalizedQuery)),
      ...baseOptions.filter((option) => option.searchText.includes(normalizedQuery)),
   ];
}

function createDynamicSlashCommandOptions(query: string) {
   const tableMatch = query.match(/^([1-9]\d?)(?:x([1-9]\d?)?)?$/i);
   if (!tableMatch) return [];

   const rows = tableMatch[1];
   const columnOptions = tableMatch[2] ? [tableMatch[2]] : ['2', '3', '4', '5', '6'];
   return columnOptions.map(
      (columns) =>
         new SlashCommandOption({
            command: (activeEditor) =>
               activeEditor.dispatchCommand(INSERT_TABLE_COMMAND, {
                  columns,
                  includeHeaders: true,
                  rows,
               }),
            description: `ساخت جدول ${rows} در ${columns}`,
            icon: <Table2 className="size-4" />,
            key: `table-${rows}x${columns}`,
            keywords: ['table', 'grid', 'جدول'],
            title: `جدول ${rows}x${columns}`,
      })
   );
}

function alignmentIcon(alignment: 'center' | 'justify' | 'left' | 'right') {
   if (alignment === 'center') return <AlignCenter className="size-4" />;
   if (alignment === 'justify') return <AlignJustify className="size-4" />;
   if (alignment === 'left') return <AlignLeft className="size-4" />;
   return <AlignRight className="size-4" />;
}

function alignmentLabel(alignment: 'center' | 'justify' | 'left' | 'right') {
   if (alignment === 'center') return 'وسط‌چین';
   if (alignment === 'justify') return 'تمام‌چین';
   if (alignment === 'left') return 'چپ‌چین';
   return 'راست‌چین';
}

function normalizeLinkUrl(value: string) {
   const trimmed = value.trim();
   if (!trimmed) return '';
   if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
   if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return `mailto:${trimmed}`;
   return `https://${trimmed}`;
}

function insertLinkWithPrompt(editor: LexicalEditor) {
   const url = typeof window === 'undefined' ? '' : window.prompt('آدرس لینک را وارد کنید', 'https://');
   const normalizedUrl = normalizeLinkUrl(url || '');
   if (!normalizedUrl) return;
   editor.focus(() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, normalizedUrl));
}

function removeLink(editor: LexicalEditor) {
   editor.focus(() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, null));
}

function insertImageUrlWithPrompt(editor: LexicalEditor) {
   const src = typeof window === 'undefined' ? '' : window.prompt('آدرس تصویر را وارد کنید', 'https://');
   const normalizedSrc = normalizeLinkUrl(src || '');
   if (!normalizedSrc) return;

   editor.update(() => {
      $insertNodes([
         $createInlineImageNode({ altText: '', src: normalizedSrc }),
         $createTextNode(' '),
      ]);
   });
}

function cloneCurrentRangeSelectionSnapshot(editor: LexicalEditor): RangeSelection | null {
   let snapshot: RangeSelection | null = null;
   editor.getEditorState().read(() => {
      const selection = $getSelection();
      snapshot = $isRangeSelection(selection) ? selection.clone() : null;
   });
   return snapshot;
}

function selectAndUploadInlineImages(
   editor: LexicalEditor,
   uploadImages: (files: File[]) => Promise<DescriptionInlineImage[]>,
   onUploadError?: (error: unknown) => void
) {
   const input = document.createElement('input');
   input.type = 'file';
   input.accept = 'image/*';
   input.multiple = true;
   input.onchange = () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      const selectionSnapshot = cloneCurrentRangeSelectionSnapshot(editor);
      void uploadAndInsertInlineImages(editor, files, uploadImages, onUploadError, selectionSnapshot);
   };
   input.click();
}

function selectAndUploadInlineFiles(
   editor: LexicalEditor,
   uploadFiles: (files: File[]) => Promise<DescriptionInlineFile[]>,
   onUploadError?: (error: unknown) => void
) {
   const input = document.createElement('input');
   input.type = 'file';
   input.multiple = true;
   input.onchange = () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      const selectionSnapshot = cloneCurrentRangeSelectionSnapshot(editor);
      void uploadAndInsertInlineFiles(editor, files, uploadFiles, onUploadError, selectionSnapshot);
   };
   input.click();
}

function SlashCommandsPlugin({
   customCommands,
   onFileUploadError,
   onImageUploadError,
   uploadFiles,
   uploadImages,
}: {
   customCommands?: DescriptionSlashCommand[];
   onFileUploadError?: (error: unknown) => void;
   onImageUploadError?: (error: unknown) => void;
   uploadFiles?: (files: File[]) => Promise<DescriptionInlineFile[]>;
   uploadImages?: (files: File[]) => Promise<DescriptionInlineImage[]>;
}): JSX.Element | null {
   const [editor] = useLexicalComposerContext();
   const [queryString, setQueryString] = useState<string | null>(null);
   const checkForSlashMatch = useBasicTypeaheadTriggerMatch('/', {
      allowWhitespace: true,
      maxLength: 40,
      minLength: 0,
   });

   const options = useMemo(() => {
      const query = (queryString || '').trim().toLocaleLowerCase('en-US');
      return createSlashCommandOptions({
         customCommands,
         editor,
         onFileUploadError,
         onImageUploadError,
         query,
         uploadFiles,
         uploadImages,
      });
   }, [customCommands, editor, onFileUploadError, onImageUploadError, queryString, uploadFiles, uploadImages]);

   const onSelectOption = useCallback(
      (selectedOption: SlashCommandOption, textNodeContainingQuery: TextNode | null, closeMenu: () => void) => {
         editor.update(() => {
            if (textNodeContainingQuery) {
               const parent = textNodeContainingQuery.getParent();
               textNodeContainingQuery.remove();
               parent?.selectEnd();
            }
            closeMenu();
         });
         selectedOption.command(editor);
      },
      [editor]
   );

   return (
      <LexicalTypeaheadMenuPlugin<SlashCommandOption>
         ignoreEntityBoundary
         options={options}
         triggerFn={checkForSlashMatch}
         onQueryChange={setQueryString}
         onSelectOption={onSelectOption}
         menuRenderFn={(anchorElementRef, { options, selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => {
            return (
               <SlashCommandMenu
                  anchorElementRef={anchorElementRef}
                  options={options}
                  selectedIndex={selectedIndex}
                  selectOptionAndCleanUp={selectOptionAndCleanUp}
                  setHighlightedIndex={setHighlightedIndex}
               />
            );
         }}
      />
   );
}

function MarkdownTablePastePlugin(): null {
   const [editor] = useLexicalComposerContext();

   useEffect(() => {
      return editor.registerCommand(
         PASTE_COMMAND,
         (event) => {
            if (!('clipboardData' in event) || !event.clipboardData) return false;
            const text = event.clipboardData.getData('text/plain');
            const table = parseMarkdownTable(text);
            if (!table) return false;

            event.preventDefault();
            editor.update(() => {
               $insertNodes([createTableNodeWithText(table.rows, table.hasHeader), $createParagraphNode()]);
            });
            return true;
         },
         COMMAND_PRIORITY_HIGH
      );
   }, [editor]);

   return null;
}

function MarkdownPastePlugin(): null {
   const [editor] = useLexicalComposerContext();

   useEffect(() => {
      return editor.registerCommand(
         PASTE_COMMAND,
         (event) => {
            if (!('clipboardData' in event) || !event.clipboardData) return false;
            const text = event.clipboardData.getData('text/plain');
            if (!shouldImportMarkdownPaste(text)) return false;

            let canReplaceDocument = false;
            editor.getEditorState().read(() => {
               canReplaceDocument = isEditorEmptyForMarkdownImport();
            });
            if (!canReplaceDocument) return false;

            event.preventDefault();
            editor.update(() => {
               $convertFromMarkdownString(text, descriptionMarkdownTransformers, undefined, true);
            });
            return true;
         },
         COMMAND_PRIORITY_EDITOR
      );
   }, [editor]);

   return null;
}

function isEditorEmptyForMarkdownImport() {
   return $isNodeEmpty($getRoot());
}

function shouldImportMarkdownPaste(input: string) {
   const text = input.trim();
   if (text.length < 3) return false;
   if (parseMarkdownTable(text)) return false;

   const lines = text.split(/\r?\n/);
   if (lines.length < 2 && !/^\s{0,3}(#{1,6}|>|[-*+]\s|\d+\.\s|\[(?: |x)\]\s|```)/m.test(text)) return false;

   const markdownSignals = [
      /^\s{0,3}#{1,6}\s+\S/m,
      /^\s{0,3}>\s+\S/m,
      /^\s{0,3}(?:[-*+])\s+\S/m,
      /^\s{0,3}\d+\.\s+\S/m,
      /^\s{0,3}(?:[-*+]\s*)?\[(?: |x)\]\s+\S/im,
      /^\s{0,3}```[\w-]*\s*$/m,
      /\[[^\]\n]+]\((?:https?:\/\/|mailto:|\/|#)[^)]+\)/,
      /(^|[^*])\*\*[^*\n][\s\S]*?[^*\n]\*\*/,
      /(^|[^~])~~[^~\n][\s\S]*?[^~\n]~~/,
   ];

   return markdownSignals.some((pattern) => pattern.test(text));
}

function parseMarkdownTable(input: string): { hasHeader: boolean; rows: string[][] } | null {
   const lines = input
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
   if (lines.length < 2 || !lines.every((line) => line.includes('|'))) return null;

   const separatorIndex = lines.findIndex((line, index) => index > 0 && isMarkdownTableSeparator(line));
   if (separatorIndex !== 1) return null;

   const rows = [lines[0], ...lines.slice(separatorIndex + 1)]
      .map(splitMarkdownTableRow)
      .filter((row) => row.length > 0);
   if (rows.length < 2) return null;

   const columnCount = Math.max(...rows.map((row) => row.length));
   if (columnCount < 2) return null;

   return {
      hasHeader: true,
      rows: rows.map((row) => {
         const normalized = row.slice(0, columnCount);
         while (normalized.length < columnCount) normalized.push('');
         return normalized;
      }),
   };
}

function isMarkdownTableSeparator(line: string): boolean {
   const cells = splitMarkdownTableRow(line);
   return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function splitMarkdownTableRow(line: string): string[] {
   const trimmed = line.replace(/^\|/, '').replace(/\|$/, '');
   const cells: string[] = [];
   let current = '';
   let escaped = false;

   for (const char of trimmed) {
      if (escaped) {
         current += char;
         escaped = false;
         continue;
      }
      if (char === '\\') {
         escaped = true;
         continue;
      }
      if (char === '|') {
         cells.push(current.trim());
         current = '';
         continue;
      }
      current += char;
   }

   cells.push(current.trim());
   return cells;
}

function createTableNodeWithText(rows: string[][], hasHeader: boolean): TableNode {
   const tableNode = $createTableNode();
   rows.forEach((row, rowIndex) => {
      const tableRowNode = $createTableRowNode();
      row.forEach((cell) => {
         const headerState = hasHeader && rowIndex === 0 ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS;
         const cellNode = $createTableCellNode(headerState);
         const paragraphNode = $createParagraphNode();
         if (cell) paragraphNode.append($createTextNode(cell));
         cellNode.append(paragraphNode);
         tableRowNode.append(cellNode);
      });
      tableNode.append(tableRowNode);
   });
   return tableNode;
}

function SlashCommandMenu({
   anchorElementRef,
   options,
   selectedIndex,
   selectOptionAndCleanUp,
   setHighlightedIndex,
}: {
   anchorElementRef: RefObject<HTMLElement | null>;
   options: SlashCommandOption[];
   selectedIndex: number | null;
   selectOptionAndCleanUp: (option: SlashCommandOption) => void;
   setHighlightedIndex: (index: number) => void;
}) {
   const anchor = anchorElementRef.current;
   const portalTarget = anchor?.ownerDocument.body;
   const menuRef = useRef<HTMLDivElement | null>(null);
   const selectedOptionRef = useRef<HTMLButtonElement | null>(null);

   useEffect(() => {
      selectedOptionRef.current?.scrollIntoView({ block: 'nearest' });
   }, [selectedIndex]);

   if (!anchor || !portalTarget || !options.length) return null;

   return createPortal(
      <div
         ref={menuRef}
         className="z-50 overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-[#202023] p-1.5 text-right shadow-2xl"
         dir="rtl"
         role="listbox"
         style={getFloatingMenuStyle(anchor, {
            estimatedHeight: 420,
            maxHeight: 448,
            minWidth: 272,
            preferredWidth: 320,
         })}
         onWheel={(event) => event.stopPropagation()}
      >
         {options.map((option, index) => (
            <button
               key={option.key}
               ref={(element) => {
                  option.setRefElement(element);
                  if (selectedIndex === index) selectedOptionRef.current = element;
               }}
               aria-selected={selectedIndex === index}
               className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-right text-sm text-zinc-300 outline-none transition',
                  selectedIndex === index ? 'bg-white/10 text-zinc-100' : 'hover:bg-white/8'
               )}
               role="option"
               type="button"
               onClick={() => selectOptionAndCleanUp(option)}
               onMouseDown={(event) => event.preventDefault()}
               onMouseEnter={() => setHighlightedIndex(index)}
            >
               <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-white/7 text-zinc-400">
                  {option.iconNode}
               </span>
               <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-zinc-100">{option.title}</span>
                  <span className="block truncate text-xs text-zinc-500">{option.description}</span>
               </span>
               {option.shortcut ? (
                  <kbd className="shrink-0 rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-zinc-500">
                     {option.shortcut}
                  </kbd>
               ) : null}
            </button>
         ))}
      </div>,
      portalTarget
   );
}

function getFloatingMenuStyle(anchor: HTMLElement, options: FloatingMenuStyleOptions = {}): CSSProperties {
   const ownerWindow = anchor.ownerDocument.defaultView || window;
   const rect = getActiveSelectionRect(ownerWindow) || anchor.getBoundingClientRect();
   const width = Math.min(
      options.preferredWidth ?? 240,
      Math.max(options.minWidth ?? 184, ownerWindow.innerWidth - 24)
   );
   const viewportPadding = 12;
   const maxRight = Math.max(viewportPadding, ownerWindow.innerWidth - width - viewportPadding);
   const right = Math.min(Math.max(viewportPadding, ownerWindow.innerWidth - rect.right), maxRight);
   const estimatedHeight = options.estimatedHeight ?? 260;
   const gap = 8;
   const preferredMaxHeight = options.maxHeight ?? estimatedHeight;
   const spaceBelow = ownerWindow.innerHeight - rect.bottom - gap - viewportPadding;
   const spaceAbove = rect.top - gap - viewportPadding;
   const opensAbove = spaceBelow < Math.min(estimatedHeight, preferredMaxHeight) && spaceAbove > spaceBelow;
   const availableHeight = opensAbove ? spaceAbove : spaceBelow;
   const maxHeight = Math.max(160, Math.min(preferredMaxHeight, Math.max(0, availableHeight)));

   return {
      bottom: opensAbove ? ownerWindow.innerHeight - rect.top + gap : undefined,
      maxHeight,
      overflowY: 'auto',
      position: 'fixed',
      right,
      top: opensAbove ? undefined : Math.min(rect.bottom + gap, ownerWindow.innerHeight - viewportPadding - maxHeight),
      width,
   };
}

function getActiveSelectionRect(ownerWindow: Window): DOMRect | null {
   const selection = ownerWindow.getSelection();
   if (!selection || selection.rangeCount === 0) return null;

   const range = selection.getRangeAt(0).cloneRange();
   const rect = range.getBoundingClientRect();
   if (rect.width > 0 || rect.height > 0) return rect;

   const rangeRects = range.getClientRects();
   return rangeRects.length ? rangeRects[rangeRects.length - 1] || null : null;
}

function MentionAvatar({ user }: { user: MentionUser }) {
   const avatarImage = useCachedAvatarImage(user.avatarUrl);

   return (
      <span className="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/8 text-[11px] !font-medium text-zinc-300">
         {avatarImage.src ? (
            <img
               alt=""
               className="size-full object-cover"
               src={avatarImage.src}
               onError={() => markCachedAvatarImageFailed(avatarImage.originalSrc)}
            />
         ) : (
            user.name.trim().slice(0, 1)
         )}
      </span>
   );
}

function $getCurrentTableCell() {
   const selection = $getSelection();
   if (!$isRangeSelection(selection)) return null;
   return $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
}

function $toggleCurrentTableRowHeader() {
   const tableCellNode = $getCurrentTableCell();
   if (!tableCellNode) return;

   const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
   const tableRowIndex = $getTableRowIndexFromTableCellNode(tableCellNode);
   const [gridMap] = $computeTableMapSkipCellCheck(tableNode, null, null);
   const nextStyle = tableCellNode.getHeaderStyles() ^ TableCellHeaderStates.ROW;
   const rowCells = new Set<TableCellNode>();

   for (const mapCell of gridMap[tableRowIndex] || []) {
      if (mapCell?.cell && !rowCells.has(mapCell.cell)) {
         rowCells.add(mapCell.cell);
         mapCell.cell.setHeaderStyles(nextStyle, TableCellHeaderStates.ROW);
      }
   }
}

function $toggleCurrentTableColumnHeader() {
   const tableCellNode = $getCurrentTableCell();
   if (!tableCellNode) return;

   const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
   const tableColumnIndex = $getTableColumnIndexFromTableCellNode(tableCellNode);
   const [gridMap] = $computeTableMapSkipCellCheck(tableNode, null, null);
   const nextStyle = tableCellNode.getHeaderStyles() ^ TableCellHeaderStates.COLUMN;
   const columnCells = new Set<TableCellNode>();

   for (const row of gridMap) {
      const mapCell = row[tableColumnIndex];
      if (mapCell?.cell && !columnCells.has(mapCell.cell)) {
         columnCells.add(mapCell.cell);
         mapCell.cell.setHeaderStyles(nextStyle, TableCellHeaderStates.COLUMN);
      }
   }
}

function $deleteCurrentTable() {
   const tableCellNode = $getCurrentTableCell();
   if (!tableCellNode) return;
   $getTableNodeFromLexicalNodeOrThrow(tableCellNode).remove();
}

function DescriptionContextMenu({
   onFileUploadError,
   onImageUploadError,
   uploadFiles,
   uploadImages,
}: {
   onFileUploadError?: (error: unknown) => void;
   onImageUploadError?: (error: unknown) => void;
   uploadFiles?: (files: File[]) => Promise<DescriptionInlineFile[]>;
   uploadImages?: (files: File[]) => Promise<DescriptionInlineImage[]>;
}): JSX.Element {
   const [editor] = useLexicalComposerContext();
   const [isInTable, setIsInTable] = useState(false);

   const updateTableState = useCallback(() => {
      editor.getEditorState().read(() => {
         setIsInTable(Boolean($getCurrentTableCell()));
      });
   }, [editor]);

   useEffect(() => {
      updateTableState();
      return mergeRegister(
         editor.registerUpdateListener(() => updateTableState()),
         editor.registerCommand(
            SELECTION_CHANGE_COMMAND,
            () => {
               updateTableState();
               return false;
            },
            COMMAND_PRIORITY_LOW
         )
      );
   }, [editor, updateTableState]);

   const formatText = useCallback(
      (format: TextFormatType) => {
         editor.focus(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, format));
      },
      [editor]
   );

   const setParagraph = useCallback(() => {
      editor.update(() => {
         $setBlocksType($getSelection(), () => $createParagraphNode());
      });
   }, [editor]);

   const setHeading = useCallback(
      (level: 'h1' | 'h2' | 'h3') => {
         editor.update(() => {
            $setBlocksType($getSelection(), () => $createHeadingNode(level));
         });
      },
      [editor]
   );

   const setQuote = useCallback(() => {
      editor.update(() => {
         $setBlocksType($getSelection(), () => $createQuoteNode());
      });
   }, [editor]);

   const setCodeBlock = useCallback(() => {
      editor.update($setSelectionToCodeBlock);
   }, [editor]);

   const insertTable = useCallback(() => {
      editor.focus(() =>
         editor.dispatchCommand(INSERT_TABLE_COMMAND, { columns: '3', includeHeaders: true, rows: '3' })
      );
   }, [editor]);

   const runTableCommand = useCallback(
      (command: () => void) => {
         editor.update(command);
      },
      [editor]
   );

   return (
      <ContextMenuContent
         className="max-h-[500px] w-fit max-w-[calc(100vw-1.5rem)] overflow-y-auto border-white/10 bg-[#202023] p-1.5 text-zinc-300 shadow-2xl sm:max-w-[22rem]"
         collisionPadding={20}
         dir="rtl"
      >
         <ContextMenuLabel className="px-2 py-1 text-xs font-normal text-zinc-500">متن</ContextMenuLabel>
         <EditorContextMenuItem icon={<Bold className="size-4" />} shortcut="⌘B" onSelect={() => formatText('bold')}>
            پررنگ
         </EditorContextMenuItem>
         <EditorContextMenuItem icon={<Italic className="size-4" />} shortcut="⌘I" onSelect={() => formatText('italic')}>
            کج
         </EditorContextMenuItem>
         <EditorContextMenuItem icon={<Underline className="size-4" />} shortcut="⌘U" onSelect={() => formatText('underline')}>
            زیرخط
         </EditorContextMenuItem>
         <EditorContextMenuItem icon={<Strikethrough className="size-4" />} onSelect={() => formatText('strikethrough')}>
            خط خورده
         </EditorContextMenuItem>
         <EditorContextMenuItem icon={<Code2 className="size-4" />} onSelect={() => formatText('code')}>
            کد
         </EditorContextMenuItem>
         <EditorContextMenuItem icon={<Link2 className="size-4" />} shortcut="⌘K" onSelect={() => insertLinkWithPrompt(editor)}>
            لینک
         </EditorContextMenuItem>
         <EditorContextMenuItem icon={<Link2Off className="size-4" />} onSelect={() => removeLink(editor)}>
            حذف لینک
         </EditorContextMenuItem>
         <EditorContextMenuItem
            icon={<AtSign className="size-4" />}
            shortcut="@"
            onSelect={() => editor.focus(() => editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, '@'))}
         >
            منشن
         </EditorContextMenuItem>

         <ContextMenuSeparator className="bg-white/8" />
         <ContextMenuLabel className="px-2 py-1 text-xs font-normal text-zinc-500">بلوک</ContextMenuLabel>
         <EditorContextMenuItem icon={<Pilcrow className="size-4" />} onSelect={setParagraph}>
            متن ساده
         </EditorContextMenuItem>
         <EditorContextMenuItem icon={<Heading1 className="size-4" />} onSelect={() => setHeading('h1')}>
            تیتر ۱
         </EditorContextMenuItem>
         <EditorContextMenuItem icon={<Heading2 className="size-4" />} onSelect={() => setHeading('h2')}>
            تیتر ۲
         </EditorContextMenuItem>
         <EditorContextMenuItem icon={<Heading3 className="size-4" />} onSelect={() => setHeading('h3')}>
            تیتر ۳
         </EditorContextMenuItem>
         <EditorContextMenuItem icon={<Quote className="size-4" />} onSelect={setQuote}>
            نقل‌قول
         </EditorContextMenuItem>
         <EditorContextMenuItem icon={<Code2 className="size-4" />} onSelect={setCodeBlock}>
            بلوک کد
         </EditorContextMenuItem>

         <ContextMenuSeparator className="bg-white/8" />
         <ContextMenuLabel className="px-2 py-1 text-xs font-normal text-zinc-500">ساختار</ContextMenuLabel>
         <EditorContextMenuItem
            icon={<List className="size-4" />}
            shortcut="-"
            onSelect={() => editor.focus(() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined))}
         >
            فهرست نقطه‌ای
         </EditorContextMenuItem>
         <EditorContextMenuItem
            icon={<ListOrdered className="size-4" />}
            shortcut="1."
            onSelect={() => editor.focus(() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined))}
         >
            فهرست شماره‌دار
         </EditorContextMenuItem>
         <EditorContextMenuItem
            icon={<ListChecks className="size-4" />}
            shortcut="[]"
            onSelect={() => editor.focus(() => editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined))}
         >
            چک‌لیست
         </EditorContextMenuItem>
         <EditorContextMenuItem icon={<Table2 className="size-4" />} onSelect={insertTable}>
            جدول
         </EditorContextMenuItem>
         <EditorContextMenuItem icon={<ImagePlus className="size-4" />} onSelect={() => insertImageUrlWithPrompt(editor)}>
            تصویر از لینک
         </EditorContextMenuItem>
         {uploadImages ? (
            <EditorContextMenuItem
               icon={<ImagePlus className="size-4" />}
               onSelect={() => selectAndUploadInlineImages(editor, uploadImages, onImageUploadError)}
            >
               بارگذاری تصویر
            </EditorContextMenuItem>
         ) : null}
         {uploadFiles ? (
            <EditorContextMenuItem icon={<Paperclip className="size-4" />} onSelect={() => selectAndUploadInlineFiles(editor, uploadFiles, onFileUploadError)}>
               بارگذاری فایل
            </EditorContextMenuItem>
         ) : null}

         {isInTable ? (
            <>
               <ContextMenuSeparator className="bg-white/8" />
               <ContextMenuLabel className="px-2 py-1 text-xs font-normal text-zinc-500">جدول</ContextMenuLabel>
               <EditorContextMenuItem icon={<ArrowUp className="size-4" />} onSelect={() => runTableCommand(() => $insertTableRowAtSelection(false))}>
                  ردیف بالا
               </EditorContextMenuItem>
               <EditorContextMenuItem icon={<ArrowDown className="size-4" />} onSelect={() => runTableCommand(() => $insertTableRowAtSelection(true))}>
                  ردیف پایین
               </EditorContextMenuItem>
               <EditorContextMenuItem icon={<ArrowRight className="size-4" />} onSelect={() => runTableCommand(() => $insertTableColumnAtSelection(false))}>
                  ستون راست
               </EditorContextMenuItem>
               <EditorContextMenuItem icon={<ArrowLeft className="size-4" />} onSelect={() => runTableCommand(() => $insertTableColumnAtSelection(true))}>
                  ستون چپ
               </EditorContextMenuItem>
               <EditorContextMenuItem icon={<Rows3 className="size-4" />} onSelect={() => runTableCommand($toggleCurrentTableRowHeader)}>
                  هدر ردیف
               </EditorContextMenuItem>
               <EditorContextMenuItem icon={<Columns3 className="size-4" />} onSelect={() => runTableCommand($toggleCurrentTableColumnHeader)}>
                  هدر ستون
               </EditorContextMenuItem>
               <EditorContextMenuItem icon={<Trash2 className="size-4" />} onSelect={() => runTableCommand($deleteTableRowAtSelection)}>
                  حذف ردیف
               </EditorContextMenuItem>
               <EditorContextMenuItem icon={<Trash2 className="size-4" />} onSelect={() => runTableCommand($deleteTableColumnAtSelection)}>
                  حذف ستون
               </EditorContextMenuItem>
               <EditorContextMenuItem icon={<Trash2 className="size-4" />} onSelect={() => runTableCommand($deleteCurrentTable)}>
                  حذف جدول
               </EditorContextMenuItem>
            </>
         ) : null}
      </ContextMenuContent>
   );
}

function EditorContextMenuItem({
   children,
   disabled = false,
   icon,
   onSelect,
   shortcut,
}: {
   children: ReactNode;
   disabled?: boolean;
   icon: ReactNode;
   onSelect: () => void;
   shortcut?: string;
}) {
   return (
      <ContextMenuItem
         className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm text-zinc-300 outline-none focus:bg-white/[0.08] focus:text-zinc-100"
         disabled={disabled}
         onSelect={onSelect}
      >
         <span className="flex size-4 shrink-0 items-center justify-center text-zinc-500">{icon}</span>
         <span className="min-w-0 flex-1 truncate">{children}</span>
         {shortcut ? <ContextMenuShortcut className="ms-2 tracking-normal text-zinc-600">{shortcut}</ContextMenuShortcut> : null}
      </ContextMenuItem>
   );
}

function FloatingTextFormatToolbarPlugin(): JSX.Element | null {
   const [editor] = useLexicalComposerContext();
   const [toolbarState, setToolbarState] = useState({
      isBold: false,
      isCode: false,
      isItalic: false,
      isLink: false,
      isStrikethrough: false,
      isSubscript: false,
      isSuperscript: false,
      isUnderline: false,
      visible: false,
   });
   const [style, setStyle] = useState<CSSProperties | null>(null);

   const updateToolbar = useCallback(() => {
      const rootElement = editor.getRootElement();
      const ownerWindow = rootElement?.ownerDocument.defaultView || window;
      const nativeSelection = getDOMSelection(ownerWindow);

      editor.getEditorState().read(() => {
         const selection = $getSelection();
         if (
            editor.isComposing() ||
            !rootElement ||
            !nativeSelection ||
            nativeSelection.isCollapsed ||
            !$isRangeSelection(selection) ||
            !rootElement.contains(nativeSelection.anchorNode)
         ) {
            setToolbarState((current) => ({ ...current, visible: false }));
            return;
         }

         const text = selection.getTextContent().replace(/\n/g, '').trim();
         if (!text) {
            setToolbarState((current) => ({ ...current, visible: false }));
            return;
         }

         const nodes = selection.getNodes();
         const hasTextNode = nodes.some((node) => $isTextNode(node) || $isParagraphNode(node) || $isHeadingNode(node));
         if (!hasTextNode) {
            setToolbarState((current) => ({ ...current, visible: false }));
            return;
         }

         const rangeRect = getActiveSelectionRect(ownerWindow);
         if (!rangeRect) {
            setToolbarState((current) => ({ ...current, visible: false }));
            return;
         }

         const width = 376;
         const viewportPadding = 12;
         const left = Math.min(
            Math.max(viewportPadding, rangeRect.left + rangeRect.width / 2 - width / 2),
            Math.max(viewportPadding, ownerWindow.innerWidth - width - viewportPadding)
         );
         const topCandidate = rangeRect.top - 48;
         setStyle({
            left,
            position: 'fixed',
            top: topCandidate < viewportPadding ? rangeRect.bottom + 8 : topCandidate,
            width,
         });
         setToolbarState({
            isBold: selection.hasFormat('bold'),
            isCode: selection.hasFormat('code'),
            isItalic: selection.hasFormat('italic'),
            isLink: nodes.some((node) => $isLinkNode(node) || $isLinkNode(node.getParent())),
            isStrikethrough: selection.hasFormat('strikethrough'),
            isSubscript: selection.hasFormat('subscript'),
            isSuperscript: selection.hasFormat('superscript'),
            isUnderline: selection.hasFormat('underline'),
            visible: true,
         });
      });
   }, [editor]);

   useEffect(() => {
      document.addEventListener('selectionchange', updateToolbar);
      window.addEventListener('resize', updateToolbar);
      return () => {
         document.removeEventListener('selectionchange', updateToolbar);
         window.removeEventListener('resize', updateToolbar);
      };
   }, [updateToolbar]);

   useEffect(() => {
      return mergeRegister(
         editor.registerUpdateListener(() => updateToolbar()),
         editor.registerCommand(
            SELECTION_CHANGE_COMMAND,
            () => {
               updateToolbar();
               return false;
            },
            COMMAND_PRIORITY_LOW
         )
      );
   }, [editor, updateToolbar]);

   if (!toolbarState.visible || !style) return null;

   return createPortal(
      <div
         className="z-50 flex items-center justify-center gap-1 rounded-lg border border-white/10 bg-[#202023] p-1.5 text-zinc-400 shadow-2xl"
         dir="rtl"
         style={style}
      >
         <FloatingToolbarButton active={toolbarState.isBold} label="پررنگ" onSelect={() => editor.focus(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold'))}>
            <Bold className="size-4" />
         </FloatingToolbarButton>
         <FloatingToolbarButton active={toolbarState.isItalic} label="کج" onSelect={() => editor.focus(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic'))}>
            <Italic className="size-4" />
         </FloatingToolbarButton>
         <FloatingToolbarButton active={toolbarState.isUnderline} label="زیرخط" onSelect={() => editor.focus(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline'))}>
            <Underline className="size-4" />
         </FloatingToolbarButton>
         <FloatingToolbarButton active={toolbarState.isStrikethrough} label="خط خورده" onSelect={() => editor.focus(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough'))}>
            <Strikethrough className="size-4" />
         </FloatingToolbarButton>
         <FloatingToolbarButton active={toolbarState.isCode} label="کد" onSelect={() => editor.focus(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code'))}>
            <Code2 className="size-4" />
         </FloatingToolbarButton>
         <FloatingToolbarButton active={toolbarState.isSubscript} label="زیرنویس" onSelect={() => editor.focus(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'subscript'))}>
            <Subscript className="size-4" />
         </FloatingToolbarButton>
         <FloatingToolbarButton active={toolbarState.isSuperscript} label="بالانویس" onSelect={() => editor.focus(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'superscript'))}>
            <Superscript className="size-4" />
         </FloatingToolbarButton>
         <span className="mx-1 h-5 w-px bg-white/10" />
         <FloatingToolbarButton active={toolbarState.isLink} label="لینک" onSelect={() => insertLinkWithPrompt(editor)}>
            <Link2 className="size-4" />
         </FloatingToolbarButton>
         <FloatingToolbarButton label="حذف لینک" onSelect={() => removeLink(editor)}>
            <Link2Off className="size-4" />
         </FloatingToolbarButton>
      </div>,
      document.body
   );
}

function FloatingToolbarButton({
   active = false,
   children,
   label,
   onSelect,
}: {
   active?: boolean;
   children: ReactNode;
   label: string;
   onSelect: () => void;
}) {
   const runCommand = () => {
      onSelect();
   };

   return (
      <button
         aria-label={label}
         className={cn(
            'flex size-7 items-center justify-center rounded-md transition hover:bg-white/10 hover:text-zinc-100',
            active ? 'bg-indigo-500/20 text-indigo-200' : 'text-zinc-400'
         )}
         type="button"
         onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
         }}
         onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            runCommand();
         }}
         onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            runCommand();
         }}
      >
         {children}
      </button>
   );
}

function CompactChecklistShortcutPlugin() {
   const [editor] = useLexicalComposerContext();

   useEffect(() => {
      return editor.registerCommand(
         KEY_DOWN_COMMAND,
         (event) => {
            if (event.key !== ']') return false;

            const selection = $getSelection();
            if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.type !== 'text') {
               return false;
            }

            const textNode = selection.anchor.getNode();
            const parent = textNode.getParent();
            if (
               !textNode.isSimpleText() ||
               selection.anchor.offset !== textNode.getTextContentSize() ||
               !parent ||
               parent.getTextContent() !== '['
            ) {
               return false;
            }

            event.preventDefault();
            textNode.remove();
            parent.selectEnd();
            $insertList('check');
            return true;
         },
         COMMAND_PRIORITY_HIGH
      );
   }, [editor]);

   return null;
}

type DirectionUpdate = {
   direction: 'ltr' | 'rtl';
   key: NodeKey;
};

function $resolveDirectionFromText(node: ElementNode): 'ltr' | 'rtl' {
   const detectedDirection = getTextDirection(node.getTextContent().trimStart());
   if (detectedDirection) return detectedDirection;
   return node.getDirection() ?? 'rtl';
}

function $collectDirectionUpdates(node: ElementNode, updates: DirectionUpdate[]) {
   if (node.getType() !== 'root' && !node.isInline()) {
      const direction = $resolveDirectionFromText(node);
      if (node.getDirection() !== direction) {
         updates.push({ direction, key: node.getKey() });
      }
   }

   for (const child of node.getChildren()) {
      if (!$isElementNode(child)) continue;
      $collectDirectionUpdates(child, updates);
   }
}

function AutoDirectionPlugin() {
   const [editor] = useLexicalComposerContext();

   const syncDirections = useCallback(
      (editorState: EditorState) => {
         const updates = editorState.read(() => {
            const nextUpdates: DirectionUpdate[] = [];
            $collectDirectionUpdates($getRoot(), nextUpdates);
            return nextUpdates;
         });

         if (!updates.length) return;

         editor.update(
            () => {
               for (const update of updates) {
                  const node = $getNodeByKey(update.key);
                  if ($isElementNode(node)) {
                     node.setDirection(update.direction);
                  }
               }
            },
            { tag: autoDirectionSyncTag }
         );
      },
      [editor]
   );

   useEffect(() => {
      syncDirections(editor.getEditorState());
   }, [editor, syncDirections]);

   useEffect(() => {
      return editor.registerUpdateListener(({ editorState, tags }) => {
         if (tags.has(autoDirectionSyncTag) || editor.isComposing()) return;
         syncDirections(editorState);
      });
   }, [editor, syncDirections]);

   return null;
}

function DescriptionFocusPlugin({ focusToken }: { focusToken?: number }) {
   const [editor] = useLexicalComposerContext();
   const previousTokenRef = useRef(focusToken);

   useEffect(() => {
      if (focusToken === undefined || previousTokenRef.current === focusToken) return;
      previousTokenRef.current = focusToken;
      window.requestAnimationFrame(() => {
         editor.focus();
      });
   }, [editor, focusToken]);

   return null;
}

type CanIndentPredicate = (node: ElementNode) => boolean;

function $defaultCanIndent(node: ElementNode) {
   return node.canBeEmpty();
}

function $getNearestBlockElementAncestorOrThrow(node: LexicalNode): ElementNode {
   const block = $findMatchingParent(
      node,
      (parentNode): parentNode is ElementNode => $isElementNode(parentNode) && !parentNode.isInline()
   );
   if (!block) throw new Error('Expected node to have a block element ancestor.');
   return block;
}

function $handlePlaygroundIndentAndOutdent(indentOrOutdent: (block: ElementNode) => void): boolean {
   const selection = $getSelection();
   if (!$isRangeSelection(selection)) return false;

   const alreadyHandled = new Set<string>();
   const nodes = selection.getNodes();
   for (const node of nodes) {
      const key = node.getKey();
      if (alreadyHandled.has(key)) continue;

      const parentBlock = $findMatchingParent(
         node,
         (parentNode): parentNode is ElementNode => $isElementNode(parentNode) && !parentNode.isInline()
      );
      if (!parentBlock) continue;

      const parentKey = parentBlock.getKey();
      if (parentBlock.canIndent() && !alreadyHandled.has(parentKey)) {
         alreadyHandled.add(parentKey);
         indentOrOutdent(parentBlock);
      }
   }

   return alreadyHandled.size > 0;
}

function $indentOverTab(selection: RangeSelection): boolean {
   const anchorTopLevel = selection.anchor.getNode().getTopLevelElement();
   if ($isCodeNode(anchorTopLevel)) return false;

   const nodes = selection.getNodes();
   const canIndentBlockNodes = nodes.filter((node) => $isBlockElementNode(node) && node.canIndent());
   if (canIndentBlockNodes.length > 0) return true;

   const { anchor, focus } = selection;
   const first = focus.isBefore(anchor) ? focus : anchor;
   const firstNode = first.getNode();
   const firstBlock = $getNearestBlockElementAncestorOrThrow(firstNode);
   if (!firstBlock.canIndent()) return false;

   const firstBlockKey = firstBlock.getKey();
   let selectionAtStart = $createRangeSelection();
   selectionAtStart.anchor.set(firstBlockKey, 0, 'element');
   selectionAtStart.focus.set(firstBlockKey, 0, 'element');
   selectionAtStart = $normalizeSelection__EXPERIMENTAL(selectionAtStart);
   return selectionAtStart.anchor.is(first);
}

function registerPlaygroundTabIndentation(
   editor: LexicalEditor,
   maxIndent?: number,
   $canIndent: CanIndentPredicate = $defaultCanIndent
) {
   return mergeRegister(
      editor.registerCommand<KeyboardEvent>(
         KEY_TAB_COMMAND,
         (event) => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return false;

            event.preventDefault();
            const command: LexicalCommand<void> = $indentOverTab(selection)
               ? event.shiftKey
                  ? OUTDENT_CONTENT_COMMAND
                  : INDENT_CONTENT_COMMAND
               : INSERT_TAB_COMMAND;
            return editor.dispatchCommand(command, undefined);
         },
         COMMAND_PRIORITY_EDITOR
      ),
      editor.registerCommand(
         INDENT_CONTENT_COMMAND,
         () => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return false;

            return $handlePlaygroundIndentAndOutdent((block) => {
               if (!$canIndent(block)) return;
               const newIndent = block.getIndent() + 1;
               if (!maxIndent || newIndent < maxIndent) block.setIndent(newIndent);
            });
         },
         COMMAND_PRIORITY_CRITICAL
      )
   );
}

function PlaygroundTabIndentationPlugin({ maxIndent = 7 }: { maxIndent?: number }) {
   const [editor] = useLexicalComposerContext();

   useEffect(() => registerPlaygroundTabIndentation(editor, maxIndent), [editor, maxIndent]);

   return null;
}

function DescriptionDraggableBlockPlugin({ anchorElem }: { anchorElem: HTMLElement }) {
   const menuRef = useRef<HTMLDivElement | null>(null);
   const targetLineRef = useRef<HTMLDivElement | null>(null);
   const isOnMenu = useCallback((element: HTMLElement) => {
      return Boolean(element.closest(`.${draggableBlockMenuClassName}`));
   }, []);

   return (
      <DraggableBlockPlugin_EXPERIMENTAL
         anchorElem={anchorElem}
         menuRef={menuRef}
         targetLineRef={targetLineRef}
         menuComponent={
            <div
               ref={menuRef}
               className={cn(
                  draggableBlockMenuClassName,
                  'pointer-events-none absolute inset-x-0 top-0 z-20 h-6 w-full opacity-0 will-change-transform'
               )}
               aria-hidden
            >
               <span className="pointer-events-auto absolute -right-4 top-0 flex size-6 cursor-grab items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-400 shadow-sm transition-colors hover:border-zinc-300 hover:text-zinc-700 active:cursor-grabbing dark:border-white/10 dark:bg-zinc-950/95 dark:text-zinc-500 dark:shadow-lg dark:shadow-black/30 dark:hover:border-white/20 dark:hover:text-zinc-200">
                  <GripVertical className="size-4" strokeWidth={2} />
               </span>
            </div>
         }
         targetLineComponent={
            <div
               ref={targetLineRef}
               className="pointer-events-none absolute left-0 top-0 z-10 h-1 rounded-full bg-indigo-400 opacity-0 shadow-[0_0_0_1px_rgba(129,140,248,0.35)] will-change-transform"
            />
         }
         isOnMenu={isOnMenu}
      />
   );
}

function HeadingEnterPlugin() {
   const [editor] = useLexicalComposerContext();

   useEffect(() => {
      return editor.registerCommand(
         KEY_ENTER_COMMAND,
         (event) => {
            if (event?.shiftKey) return false;

            const selection = $getSelection();
            if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

            const anchorNode = selection.anchor.getNode();
            const block = anchorNode.getTopLevelElementOrThrow();
            if (!$isHeadingNode(block)) return false;

            const direction = block.getDirection();
            const paragraph = $createParagraphNode();
            paragraph.setDirection(direction);

            if (block.getTextContent().trim().length === 0) {
               event?.preventDefault();
               block.replace(paragraph);
               paragraph.selectStart();
               return true;
            }

            if (!isSelectionAtEndOfBlock(selection, block)) return false;

            event?.preventDefault();
            block.insertAfter(paragraph, true);
            paragraph.selectStart();
            return true;
         },
         COMMAND_PRIORITY_HIGH
      );
   }, [editor]);

   return null;
}

function InlineAssetsPlugin({
   onFileUploadError,
   onImageUploadError,
   uploadFiles,
   uploadImages,
}: {
   onFileUploadError?: (error: unknown) => void;
   onImageUploadError?: (error: unknown) => void;
   uploadFiles?: (files: File[]) => Promise<DescriptionInlineFile[]>;
   uploadImages?: (files: File[]) => Promise<DescriptionInlineImage[]>;
}) {
   const [editor] = useLexicalComposerContext();
   const onFileUploadErrorRef = useRef(onFileUploadError);
   const onImageUploadErrorRef = useRef(onImageUploadError);
   const uploadFilesRef = useRef(uploadFiles);
   const uploadImagesRef = useRef(uploadImages);

   useEffect(() => {
      onFileUploadErrorRef.current = onFileUploadError;
      onImageUploadErrorRef.current = onImageUploadError;
      uploadFilesRef.current = uploadFiles;
      uploadImagesRef.current = uploadImages;
   }, [onFileUploadError, onImageUploadError, uploadFiles, uploadImages]);

   useEffect(() => {
      return editor.registerCommand(
         DRAG_DROP_PASTE,
         (files) => {
            const imageFiles = files.filter(isInlineImageFile);
            const nonImageFiles = files.filter((file) => !isInlineImageFile(file));
            const uploadImages = uploadImagesRef.current;
            const uploadFiles = uploadFilesRef.current;

            let handled = false;
            const selectionSnapshot = cloneCurrentRangeSelectionSnapshot(editor);

            if (imageFiles.length && uploadImages) {
               handled = true;
               void uploadAndInsertInlineImages(
                  editor,
                  imageFiles,
                  uploadImages,
                  onImageUploadErrorRef.current,
                  selectionSnapshot
               );
            }

            if (nonImageFiles.length && uploadFiles) {
               handled = true;
               void uploadAndInsertInlineFiles(
                  editor,
                  nonImageFiles,
                  uploadFiles,
                  onFileUploadErrorRef.current,
                  imageFiles.length ? null : selectionSnapshot
               );
            }

            if (!handled && files.length && uploadFiles) {
               handled = true;
               void uploadAndInsertInlineFiles(
                  editor,
                  files,
                  uploadFiles,
                  onFileUploadErrorRef.current,
                  selectionSnapshot
               );
            }

            return handled;
         },
         COMMAND_PRIORITY_EDITOR
      );
   }, [editor]);

   return null;
}

function insertInlineUploadPlaceholders(
   editor: LexicalEditor,
   files: File[],
   uploadKind: 'file' | 'image',
   selectionSnapshot: RangeSelection | null
): NodeKey[] {
   const placeholderKeys: NodeKey[] = [];

   editor.update(() => {
      if (selectionSnapshot) $setSelection(selectionSnapshot.clone());
      const nodes: LexicalNode[] = [];

      files.forEach((file) => {
         const placeholder = $createInlineUploadPlaceholderNode({
            fileName: file.name || '',
            uploadKind,
         });
         placeholderKeys.push(placeholder.getKey());
         nodes.push(placeholder, $createTextNode(' '));
      });

      if (nodes.length) $insertNodes(nodes);
   });

   return placeholderKeys;
}

function removeInlineUploadPlaceholder(placeholder: InlineUploadPlaceholderNode) {
   const nextSibling = placeholder.getNextSibling();
   placeholder.remove();
   if ($isTextNode(nextSibling) && nextSibling.getTextContent() === ' ') nextSibling.remove();
}

async function uploadAndInsertInlineImages(
   editor: LexicalEditor,
   files: File[],
   uploadImages: (files: File[]) => Promise<DescriptionInlineImage[]>,
   onUploadError: ((error: unknown) => void) | undefined,
   selectionSnapshot: RangeSelection | null
) {
   const placeholderKeys = insertInlineUploadPlaceholders(editor, files, 'image', selectionSnapshot);

   try {
      const images = await uploadImages(files);
      editor.update(() => {
         placeholderKeys.forEach((placeholderKey, index) => {
            const placeholder = $getNodeByKey(placeholderKey);
            if (!$isInlineUploadPlaceholderNode(placeholder)) return;

            const image = images[index];
            if (!image?.src) {
               removeInlineUploadPlaceholder(placeholder);
               return;
            }

            placeholder.replace(
               $createInlineImageNode({
                  ...image,
                  altText: image.altText || files[index]?.name || '',
               })
            );
         });
      });
   } catch (error) {
      editor.update(() => {
         placeholderKeys.forEach((placeholderKey) => {
            const placeholder = $getNodeByKey(placeholderKey);
            if ($isInlineUploadPlaceholderNode(placeholder)) removeInlineUploadPlaceholder(placeholder);
         });
      });
      onUploadError?.(error);
   }
}

async function uploadAndInsertInlineFiles(
   editor: LexicalEditor,
   files: File[],
   uploadFiles: (files: File[]) => Promise<DescriptionInlineFile[]>,
   onUploadError: ((error: unknown) => void) | undefined,
   selectionSnapshot: RangeSelection | null
) {
   const placeholderKeys = insertInlineUploadPlaceholders(editor, files, 'file', selectionSnapshot);

   try {
      const inlineFiles = await uploadFiles(files);
      editor.update(() => {
         placeholderKeys.forEach((placeholderKey, index) => {
            const placeholder = $getNodeByKey(placeholderKey);
            if (!$isInlineUploadPlaceholderNode(placeholder)) return;

            const node = createInlineNodeFromUploadedFile(inlineFiles[index], files[index]);
            if (!node) {
               removeInlineUploadPlaceholder(placeholder);
               return;
            }

            placeholder.replace(node);
         });
      });
   } catch (error) {
      editor.update(() => {
         placeholderKeys.forEach((placeholderKey) => {
            const placeholder = $getNodeByKey(placeholderKey);
            if ($isInlineUploadPlaceholderNode(placeholder)) removeInlineUploadPlaceholder(placeholder);
         });
      });
      onUploadError?.(error);
   }
}

function isSelectionAtEndOfBlock(selection: RangeSelection, block: HeadingNode) {
   if (selection.anchor.type === 'element' && selection.anchor.key === block.getKey()) {
      return selection.anchor.offset === block.getChildrenSize();
   }

   const lastDescendant = block.getLastDescendant();
   return (
      lastDescendant !== null &&
      selection.anchor.key === lastDescendant.getKey() &&
      selection.anchor.offset === lastDescendant.getTextContentSize()
   );
}

function isInlineImageFile(file: File) {
   return isInlineImageMimeType(file.type) || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg'].includes(fileExtension(file.name));
}

function fileExtension(name: string) {
   const extension = name.split('.').pop();
   return extension && extension !== name ? extension.toLowerCase() : '';
}

function isInlineImageMimeType(mimeType: string | null | undefined) {
   return normalizeNullableText(mimeType)?.toLowerCase().startsWith('image/') || false;
}

function isInlineMediaMimeType(mimeType: string | null | undefined) {
   const normalized = normalizeNullableText(mimeType)?.toLowerCase();
   return normalized ? normalized.startsWith('audio/') || normalized.startsWith('video/') : false;
}

function inferInlineFileKind(
   mimeType: string | null | undefined,
   fileName: string | null | undefined,
   kindHint: string | null | undefined
): InlineFileKind {
   if (kindHint === 'media') return 'media';
   if (isInlineMediaMimeType(mimeType)) return 'media';

   const extension = fileExtension(fileName || '');
   if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'mp4', 'mov', 'webm', 'mkv'].includes(extension)) {
      return 'media';
   }
   return 'file';
}

function inlineFileDisplayName(name: string | null | undefined, src: string) {
   const preferredName = name?.trim();
   if (preferredName) return preferredName;

   try {
      const pathname = new URL(src, 'https://taskara.local').pathname;
      const candidate = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '').trim();
      return candidate || 'فایل';
   } catch {
      return 'فایل';
   }
}

function formatFileSize(sizeBytes: number | null | undefined): string | null {
   if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;
   if (sizeBytes < 1024) return `${Math.round(sizeBytes)} B`;

   const units = ['KB', 'MB', 'GB', 'TB'];
   let value = sizeBytes / 1024;
   let unit = units[0];
   for (let index = 1; index < units.length && value >= 1024; index += 1) {
      value /= 1024;
      unit = units[index];
   }

   const precision = value >= 10 ? 1 : 2;
   return `${value.toFixed(precision)} ${unit}`;
}

function sanitizeSizeBytes(sizeBytes: number | null | undefined): number | undefined {
   return typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.round(sizeBytes) : undefined;
}

function normalizeNullableText(value: string | null | undefined): string | undefined {
   const trimmed = value?.trim();
   return trimmed ? trimmed : undefined;
}

function createInlineNodeFromUploadedFile(inlineFile: DescriptionInlineFile | undefined, fallbackFile: File): LexicalNode | null {
   if (!inlineFile?.src) return null;

   const normalizedSrc = inlineFile.src.trim();
   if (!normalizedSrc) return null;

   const resolvedName = inlineFileDisplayName(inlineFile.name || fallbackFile.name, normalizedSrc);
   const resolvedMimeType = normalizeNullableText(inlineFile.mimeType) || normalizeNullableText(fallbackFile.type);

   if (isInlineImageMimeType(resolvedMimeType) || isInlineImageFile(fallbackFile)) {
      return $createInlineImageNode({
         altText: resolvedName,
         src: normalizedSrc,
      });
   }

   return $createInlineFileNode({
      kind: inferInlineFileKind(resolvedMimeType, resolvedName, inlineFile.kind),
      mimeType: resolvedMimeType,
      name: resolvedName,
      sizeBytes: sanitizeSizeBytes(inlineFile.sizeBytes) ?? sanitizeSizeBytes(fallbackFile.size),
      src: normalizedSrc,
   });
}

function positiveNumber(value: string | null | undefined): number | undefined {
   if (!value) return undefined;
   if (value.includes('%')) return undefined;
   const numeric = Number.parseFloat(value);
   return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

export function DescriptionEditor({
   value,
   onChange,
   ariaLabel,
   autoFocus = false,
   className,
   contentClassName,
   focusToken,
   onBlur,
   onCancel,
   onFocus,
   placeholder,
   placeholderClassName,
   showToolbar = true,
   slashCommands,
   toolbarClassName,
   uploadInlineImages,
   onInlineImageUploadError,
   uploadInlineFiles,
   onInlineFileUploadError,
   users,
   variant = 'framed',
}: DescriptionEditorProps) {
   const initialValueRef = useRef(value);
   const [blockAnchorElem, setBlockAnchorElem] = useState<HTMLDivElement | null>(null);
   const initialConfig = useMemo<InitialConfigType>(
      () => ({
         namespace: 'TaskaraDescriptionEditor',
         nodes: [
            HeadingNode,
            QuoteNode,
            CodeNode,
            ListNode,
            ListItemNode,
            LinkNode,
            AutoLinkNode,
            TableNode,
            TableRowNode,
            TableCellNode,
            InlineImageNode,
            InlineFileNode,
            InlineUploadPlaceholderNode,
            MentionNode,
         ],
         editorState: isSerializedEditorValue(initialValueRef.current)
            ? initialValueRef.current
            : () => $setPlainTextValue(initialValueRef.current),
         onError(error) {
            throw error;
         },
         theme: editorTheme,
      }),
      []
   );

   return (
      <LexicalComposer initialConfig={initialConfig}>
         <ContextMenu>
            <ContextMenuTrigger asChild>
               <div
                  className={cn(
                     variant === 'framed'
                        ? 'relative min-w-0 overflow-visible rounded-lg border border-white/8 bg-transparent text-right transition focus-within:border-indigo-400/35'
                        : 'relative min-w-0 overflow-visible bg-transparent text-right',
                     className
                  )}
                  dir="rtl"
               >
                  {showToolbar ? <DescriptionToolbar className={toolbarClassName} /> : null}
                  <div ref={setBlockAnchorElem} className="relative">
                     <RichTextPlugin
                        contentEditable={
                           <ContentEditable
                              aria-label={ariaLabel || placeholder}
                              aria-multiline
                              className={cn(
                                 variant === 'framed'
                                    ? 'min-h-24 w-full overflow-auto break-words bg-transparent py-3 pl-3 pr-11 text-right text-sm leading-6 text-zinc-300 outline-none'
                                    : 'min-h-16 w-full overflow-auto break-words bg-transparent py-1 pl-0 pr-11 text-right text-sm leading-6 text-zinc-300 outline-none',
                                 '[&_[dir=ltr]]:text-left [&_[dir=rtl]]:text-right',
                                 'pr-2',
                                 contentClassName
                              )}
                              dir="rtl"
                              spellCheck
                           />
                        }
                        placeholder={
                           <div
                              className={cn(
                                 variant === 'framed'
                                    ? 'pointer-events-none absolute inset-x-0 top-3 pl-3 pr-11 text-right text-sm leading-6 text-zinc-600'
                                    : 'pointer-events-none absolute inset-x-0 top-1 pl-0 pr-11 text-right text-sm leading-6 text-zinc-600',
                                 'pr-2',
                                 placeholderClassName
                              )}
                              dir="rtl"
                           >
                              {placeholder}
                           </div>
                        }
                        ErrorBoundary={LexicalErrorBoundary}
                     />
                  </div>
                  <HistoryPlugin />
                  <ListPlugin />
                  <CheckListPlugin />
                  <AutoDirectionPlugin />
                  <PlaygroundTabIndentationPlugin maxIndent={7} />
                  {blockAnchorElem ? <DescriptionDraggableBlockPlugin anchorElem={blockAnchorElem} /> : null}
                  <MarkdownShortcutPlugin transformers={descriptionMarkdownTransformers} />
                  <HeadingEnterPlugin />
                  <TablePlugin hasCellMerge={false} hasHorizontalScroll hasTabHandler />
                  <MarkdownPastePlugin />
                  <MarkdownTablePastePlugin />
                  <InlineAssetsPlugin
                     onFileUploadError={onInlineFileUploadError}
                     onImageUploadError={onInlineImageUploadError}
                     uploadFiles={uploadInlineFiles}
                     uploadImages={uploadInlineImages}
                  />
                  <CompactChecklistShortcutPlugin />
                  <LinkPlugin />
                  <AutoLinkPlugin matchers={autoLinkMatchers} />
                  <MentionsPlugin users={users} />
                  <DescriptionFocusPlugin focusToken={focusToken} />
                  <FloatingTextFormatToolbarPlugin />
                  <SlashCommandsPlugin
                     customCommands={slashCommands}
                     onFileUploadError={onInlineFileUploadError}
                     onImageUploadError={onInlineImageUploadError}
                     uploadFiles={uploadInlineFiles}
                     uploadImages={uploadInlineImages}
                  />
                  <DescriptionEditorBridge
                     value={value}
                     onBlur={onBlur}
                     onCancel={onCancel}
                     onChange={onChange}
                     onFocus={onFocus}
                  />
                  {autoFocus ? <AutoFocusPlugin defaultSelection="rootEnd" /> : null}
               </div>
            </ContextMenuTrigger>
            <DescriptionContextMenu
               onFileUploadError={onInlineFileUploadError}
               onImageUploadError={onInlineImageUploadError}
               uploadFiles={uploadInlineFiles}
               uploadImages={uploadInlineImages}
            />
         </ContextMenu>
      </LexicalComposer>
   );
}
