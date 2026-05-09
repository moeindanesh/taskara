import { taskaraRequest } from './taskara-client';

export type TaskTextSuggestionResult = {
   titleSuggestion: string | null;
   descriptionSuggestion: string | null;
   summarySuggestion: string | null;
};

type TaskTextSuggestionRequest = {
   title: string;
   description: string;
};

type SerializedLexicalNode = {
   text?: string;
   children?: SerializedLexicalNode[];
   type?: string;
};

const blockNodeTypes = new Set([
   'paragraph',
   'heading',
   'quote',
   'listitem',
   'list-item',
   'list',
   'check-list',
   'checklist',
]);

function collectNodeText(node: SerializedLexicalNode, chunks: string[]) {
   if (typeof node.text === 'string' && node.text.length > 0) chunks.push(node.text);

   if (Array.isArray(node.children)) {
      for (const child of node.children) {
         collectNodeText(child, chunks);
      }
   }

   if (node.type && blockNodeTypes.has(node.type)) chunks.push('\n');
}

export function editorValueToPlainText(value: string): string {
   const source = value.trim();
   if (!source) return '';

   try {
      const parsed = JSON.parse(source) as { root?: SerializedLexicalNode };
      if (!parsed || typeof parsed !== 'object' || !parsed.root) return source;
      const chunks: string[] = [];
      collectNodeText(parsed.root, chunks);
      return chunks.join('').replace(/\n{3,}/g, '\n\n').trim();
   } catch {
      return source;
   }
}

export async function suggestTaskText(
   input: TaskTextSuggestionRequest
): Promise<TaskTextSuggestionResult> {
   return taskaraRequest<TaskTextSuggestionResult>('/ai/tasks/refine', {
      method: 'POST',
      body: JSON.stringify({
         title: input.title.trim(),
         description: input.description.trim(),
      }),
   });
}
