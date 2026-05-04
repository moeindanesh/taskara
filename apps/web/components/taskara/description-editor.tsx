'use client';

import type { CSSProperties, JSX, ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin';
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
import {
   LexicalTypeaheadMenuPlugin,
   MenuOption,
   useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { AutoLinkNode, LinkNode } from '@lexical/link';
import {
   $insertList,
   INSERT_CHECK_LIST_COMMAND,
   INSERT_ORDERED_LIST_COMMAND,
   INSERT_UNORDERED_LIST_COMMAND,
   ListItemNode,
   ListNode,
} from '@lexical/list';
import { CHECK_LIST, HEADING, ORDERED_LIST, QUOTE, UNORDERED_LIST } from '@lexical/markdown';
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
   $applyNodeReplacement,
   $createParagraphNode,
   $createRangeSelection,
   $createTextNode,
   $findMatchingParent,
   $getRoot,
   $getSelection,
   $insertNodes,
   $isBlockElementNode,
   $isElementNode,
   $isRangeSelection,
   $normalizeSelection__EXPERIMENTAL,
   $setSelection,
   BLUR_COMMAND,
   COMMAND_PRIORITY_CRITICAL,
   COMMAND_PRIORITY_EDITOR,
   COMMAND_PRIORITY_HIGH,
   COMMAND_PRIORITY_LOW,
   CONTROLLED_TEXT_INSERTION_COMMAND,
   DecoratorNode,
   FOCUS_COMMAND,
   FORMAT_TEXT_COMMAND,
   INDENT_CONTENT_COMMAND,
   INSERT_TAB_COMMAND,
   KEY_DOWN_COMMAND,
   KEY_ENTER_COMMAND,
   KEY_ESCAPE_COMMAND,
   KEY_TAB_COMMAND,
   mergeRegister,
   OUTDENT_CONTENT_COMMAND,
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
} from 'lexical';
import {
   AtSign,
   Bold,
   Code2,
   GripVertical,
   Heading1,
   Heading2,
   Heading3,
   Italic,
   List,
   ListChecks,
   ListOrdered,
   Pilcrow,
   Quote,
   Strikethrough,
} from 'lucide-react';
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
   onBlur?: (value: string) => void;
   onCancel?: () => void;
   onFocus?: () => void;
   placeholder: string;
   placeholderClassName?: string;
   showToolbar?: boolean;
   toolbarClassName?: string;
   uploadInlineImages?: (files: File[]) => Promise<DescriptionInlineImage[]>;
   onInlineImageUploadError?: (error: unknown) => void;
   users?: MentionUser[];
   variant?: 'framed' | 'plain';
};

type DescriptionInlineImage = {
   altText?: string;
   height?: number;
   src: string;
   width?: number;
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

const externalSyncTag = 'taskara-description-editor:external-sync';
const descriptionMarkdownTransformers = [HEADING, QUOTE, UNORDERED_LIST, ORDERED_LIST, CHECK_LIST];
const draggableBlockMenuClassName = 'taskara-description-block-drag-menu';

const editorTheme: EditorThemeClasses = {
   heading: {
      h1: 'mb-2 mt-4 text-xl leading-8 !font-semibold text-zinc-100 first:mt-0',
      h2: 'mb-2 mt-4 text-lg leading-7 !font-semibold text-zinc-100 first:mt-0',
      h3: 'mb-2 mt-3 text-base leading-6 !font-semibold text-zinc-100 first:mt-0',
   },
   image: 'mx-1 inline-flex max-w-full align-middle',
   indent: 'lexical-indent',
   link: 'text-indigo-300 underline decoration-indigo-300/35 underline-offset-2 transition hover:text-indigo-200 hover:decoration-indigo-200/70',
   list: {
      checklist: 'm-0 p-0',
      listitem: 'mx-4 my-0 marker:text-zinc-500',
      listitemChecked:
         "relative mx-1 my-0 block min-h-6 list-none py-0 pl-1 pr-6 text-zinc-500 line-through before:absolute before:right-0 before:top-1/2 before:size-4 before:-translate-y-1/2 before:rounded before:border before:border-indigo-400/60 before:bg-indigo-500/45 before:content-[''] after:absolute after:right-[0.28rem] after:top-1/2 after:h-1.5 after:w-2 after:-translate-y-1/2 after:-rotate-45 after:border-b-2 after:border-l-2 after:border-white after:content-['']",
      listitemUnchecked:
         "relative mx-1 my-0 block min-h-6 list-none py-0 pl-1 pr-6 before:absolute before:right-0 before:top-1/2 before:size-4 before:-translate-y-1/2 before:rounded before:border before:border-white/20 before:bg-white/5 before:content-['']",
      nested: {
         listitem: 'list-none before:hidden after:hidden',
      },
      ol: 'm-0 list-decimal p-0 text-right [list-style-position:outside] marker:text-zinc-500',
      olDepth: [
         'm-0 list-decimal p-0 [list-style-position:outside]',
         'm-0 p-0 [list-style-position:outside] [list-style-type:upper-alpha]',
         'm-0 p-0 [list-style-position:outside] [list-style-type:lower-alpha]',
         'm-0 p-0 [list-style-position:outside] [list-style-type:upper-roman]',
         'm-0 p-0 [list-style-position:outside] [list-style-type:lower-roman]',
      ],
      ul: 'm-0 list-disc p-0 text-right [list-style-position:outside] marker:text-zinc-500',
   },
   ltr: 'text-left',
   paragraph: 'my-2 whitespace-pre-wrap first:mt-0 last:mb-0',
   quote: 'my-3 border-s-2 border-white/14 ps-3 text-zinc-400 first:mt-0 last:mb-0',
   root: 'text-right [--lexical-indent-base-value:40px]',
   rtl: 'text-right',
   tab: 'relative no-underline',
   text: {
      bold: '!font-semibold text-zinc-100',
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
         <img
            alt={this.__altText}
            className="mx-0.5 inline max-h-80 max-w-full rounded-md border border-white/10 bg-black/20 object-contain align-middle"
            draggable={false}
            loading="lazy"
            src={this.__src}
            style={{
               height: this.__height ? `${this.__height}px` : undefined,
               width: this.__width ? `${this.__width}px` : undefined,
            }}
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
         'mx-0.5 inline-flex rounded-full border border-indigo-400/25 bg-indigo-400/12 px-1.5 py-0.5 align-baseline text-[0.92em] !font-medium text-indigo-200';
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
   if ($isInlineImageNode(node)) return false;
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
   maxHeight?: string;
   minWidth?: number;
   preferredWidth?: number;
};

class SlashCommandOption extends MenuOption {
   command: () => void;
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
      command: () => void;
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

const slashCommandOptions = [
   new SlashCommandOption({
      command: () => $setBlocksType($getSelection(), () => $createParagraphNode()),
      description: 'Plain text block',
      icon: <Pilcrow className="size-4" />,
      key: 'paragraph',
      keywords: ['text', 'normal', 'body'],
      title: 'Paragraph',
   }),
   new SlashCommandOption({
      command: () => $setBlocksType($getSelection(), () => $createHeadingNode('h1')),
      description: 'Large section heading',
      icon: <Heading1 className="size-4" />,
      key: 'heading-1',
      keywords: ['h1', 'title'],
      shortcut: '# Space',
      title: 'Heading 1',
   }),
   new SlashCommandOption({
      command: () => $setBlocksType($getSelection(), () => $createHeadingNode('h2')),
      description: 'Medium section heading',
      icon: <Heading2 className="size-4" />,
      key: 'heading-2',
      keywords: ['h2', 'subtitle'],
      shortcut: '## Space',
      title: 'Heading 2',
   }),
   new SlashCommandOption({
      command: () => $setBlocksType($getSelection(), () => $createHeadingNode('h3')),
      description: 'Small section heading',
      icon: <Heading3 className="size-4" />,
      key: 'heading-3',
      keywords: ['h3', 'subheading'],
      shortcut: '### Space',
      title: 'Heading 3',
   }),
   new SlashCommandOption({
      command: () => $insertList('bullet'),
      description: 'Create a bulleted list',
      icon: <List className="size-4" />,
      key: 'bulleted-list',
      keywords: ['unordered', 'ul', 'list'],
      shortcut: '- Space',
      title: 'Bulleted list',
   }),
   new SlashCommandOption({
      command: () => $insertList('number'),
      description: 'Create a numbered list',
      icon: <ListOrdered className="size-4" />,
      key: 'numbered-list',
      keywords: ['ordered', 'ol', 'list'],
      shortcut: '1. Space',
      title: 'Numbered list',
   }),
   new SlashCommandOption({
      command: () => $insertList('check'),
      description: 'Create a checklist',
      icon: <ListChecks className="size-4" />,
      key: 'checklist',
      keywords: ['todo', 'task', 'checkbox'],
      shortcut: '[]',
      title: 'Checklist',
   }),
   new SlashCommandOption({
      command: () => $setBlocksType($getSelection(), () => $createQuoteNode()),
      description: 'Create a block quote',
      icon: <Quote className="size-4" />,
      key: 'blockquote',
      keywords: ['quote', 'blockquote', 'callout'],
      shortcut: '> Space',
      title: 'Blockquote',
   }),
   new SlashCommandOption({
      command: () => {
         const selection = $getSelection();
         if ($isRangeSelection(selection)) selection.insertText('@');
      },
      description: 'Mention a workspace member',
      icon: <AtSign className="size-4" />,
      key: 'mention',
      keywords: ['user', 'member', 'person'],
      shortcut: '@',
      title: 'Mention',
   }),
];

function SlashCommandsPlugin(): JSX.Element | null {
   const [editor] = useLexicalComposerContext();
   const [queryString, setQueryString] = useState<string | null>(null);
   const checkForSlashMatch = useBasicTypeaheadTriggerMatch('/', {
      allowWhitespace: false,
      maxLength: 40,
      minLength: 0,
   });

   const options = useMemo(() => {
      const query = (queryString || '').trim().toLocaleLowerCase('en-US');
      if (!query) return slashCommandOptions;
      return slashCommandOptions.filter((option) => option.searchText.includes(query));
   }, [queryString]);

   const onSelectOption = useCallback(
      (selectedOption: SlashCommandOption, textNodeContainingQuery: TextNode | null, closeMenu: () => void) => {
         editor.update(() => {
            if (textNodeContainingQuery) {
               const parent = textNodeContainingQuery.getParent();
               textNodeContainingQuery.remove();
               parent?.selectEnd();
            }
            selectedOption.command();
            closeMenu();
         });
      },
      [editor]
   );

   return (
      <LexicalTypeaheadMenuPlugin<SlashCommandOption>
         ignoreEntityBoundary
         options={options.slice(0, 8)}
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
   if (!anchor || !portalTarget || !options.length) return null;

   return createPortal(
      <div
         className="z-50 overflow-hidden rounded-xl border border-white/10 bg-[#202023] p-1.5 text-left shadow-2xl"
         dir="ltr"
         style={getFloatingMenuStyle(anchor, {
            estimatedHeight: 420,
            maxHeight: 'min(28rem, calc(100vh - 24px))',
            minWidth: 272,
            preferredWidth: 320,
         })}
      >
         {options.map((option, index) => (
            <button
               key={option.key}
               ref={option.setRefElement}
               aria-selected={selectedIndex === index}
               className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-zinc-300 outline-none transition',
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
   const opensAbove = rect.bottom + estimatedHeight > ownerWindow.innerHeight && rect.top > estimatedHeight;

   return {
      bottom: opensAbove ? ownerWindow.innerHeight - rect.top + 8 : undefined,
      maxHeight: options.maxHeight ?? 'min(18rem, calc(100vh - 24px))',
      overflowY: 'auto',
      position: 'fixed',
      right,
      top: opensAbove ? undefined : Math.min(rect.bottom + 8, ownerWindow.innerHeight - viewportPadding),
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
                  'absolute right-1 top-0 z-20 flex size-6 cursor-grab items-center justify-center rounded-md border border-white/10 bg-zinc-950/95 text-zinc-500 opacity-0 shadow-lg shadow-black/30 will-change-transform transition-colors hover:border-white/20 hover:text-zinc-200 active:cursor-grabbing'
               )}
               aria-hidden
            >
               <GripVertical className="size-4" strokeWidth={2} />
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

function InlineImagesPlugin({
   onUploadError,
   uploadImages,
}: {
   onUploadError?: (error: unknown) => void;
   uploadImages?: (files: File[]) => Promise<DescriptionInlineImage[]>;
}) {
   const [editor] = useLexicalComposerContext();
   const onUploadErrorRef = useRef(onUploadError);
   const uploadImagesRef = useRef(uploadImages);

   useEffect(() => {
      onUploadErrorRef.current = onUploadError;
      uploadImagesRef.current = uploadImages;
   }, [onUploadError, uploadImages]);

   useEffect(() => {
      return editor.registerCommand(
         DRAG_DROP_PASTE,
         (files) => {
            const upload = uploadImagesRef.current;
            if (!upload) return false;

            const imageFiles = files.filter(isInlineImageFile);
            if (!imageFiles.length) return false;

            const selection = $getSelection();
            const selectionSnapshot = $isRangeSelection(selection) ? selection.clone() : null;
            void uploadAndInsertInlineImages(editor, imageFiles, upload, onUploadErrorRef.current, selectionSnapshot);
            return true;
         },
         COMMAND_PRIORITY_EDITOR
      );
   }, [editor]);

   return null;
}

async function uploadAndInsertInlineImages(
   editor: LexicalEditor,
   files: File[],
   uploadImages: (files: File[]) => Promise<DescriptionInlineImage[]>,
   onUploadError: ((error: unknown) => void) | undefined,
   selectionSnapshot: RangeSelection | null
) {
   try {
      const images = await uploadImages(files);
      const validImages = images.filter((image) => image.src);
      if (!validImages.length) return;

      editor.update(() => {
         if (selectionSnapshot) $setSelection(selectionSnapshot.clone());

         const nodes: LexicalNode[] = [];
         validImages.forEach((image) => {
            nodes.push($createInlineImageNode(image), $createTextNode(' '));
         });
         $insertNodes(nodes);
      });
   } catch (error) {
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
   return (
      file.type.toLowerCase().startsWith('image/') ||
      ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg'].includes(fileExtension(file.name))
   );
}

function fileExtension(name: string) {
   const extension = name.split('.').pop();
   return extension && extension !== name ? extension.toLowerCase() : '';
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
   onBlur,
   onCancel,
   onFocus,
   placeholder,
   placeholderClassName,
   showToolbar = true,
   toolbarClassName,
   uploadInlineImages,
   onInlineImageUploadError,
   users,
   variant = 'framed',
}: DescriptionEditorProps) {
   const initialValueRef = useRef(value);
   const [blockAnchorElem, setBlockAnchorElem] = useState<HTMLDivElement | null>(null);
   const initialConfig = useMemo<InitialConfigType>(
      () => ({
         namespace: 'TaskaraDescriptionEditor',
         nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, AutoLinkNode, InlineImageNode, MentionNode],
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
            <PlaygroundTabIndentationPlugin maxIndent={7} />
            {blockAnchorElem ? <DescriptionDraggableBlockPlugin anchorElem={blockAnchorElem} /> : null}
            <MarkdownShortcutPlugin transformers={descriptionMarkdownTransformers} />
            <HeadingEnterPlugin />
            <InlineImagesPlugin uploadImages={uploadInlineImages} onUploadError={onInlineImageUploadError} />
            <CompactChecklistShortcutPlugin />
            <LinkPlugin />
            <MentionsPlugin users={users} />
            <SlashCommandsPlugin />
            <DescriptionEditorBridge
               value={value}
               onBlur={onBlur}
               onCancel={onCancel}
               onChange={onChange}
               onFocus={onFocus}
            />
            {autoFocus ? <AutoFocusPlugin defaultSelection="rootEnd" /> : null}
         </div>
      </LexicalComposer>
   );
}
