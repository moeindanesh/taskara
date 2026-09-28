import { describe, expect, test } from 'bun:test';
import { Children, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupportScopeBoundary } from './support-workspace-provider';

describe('Support scope boundary', () => {
   const children = <form><input type="file" /><textarea defaultValue="unsent reply" /></form>;
   const props = { children, error: '', onRetry: () => {} };

   test('keeps the same child subtree in the same position across focus revalidation', () => {
      const ready = SupportScopeBoundary({ ...props, state: 'ready' });
      const validating = SupportScopeBoundary({ ...props, state: 'validating' });
      const readyContainer = Children.toArray(ready.props.children)[0];
      const validatingContainer = Children.toArray(validating.props.children)[0];
      if (!isValidElement<{ children: unknown }>(readyContainer)
         || !isValidElement<{ children: unknown }>(validatingContainer)) {
         throw new Error('Expected stable scope containers');
      }
      expect(validatingContainer.type).toBe(readyContainer.type);
      expect(validatingContainer.key).toBe(readyContainer.key);
      expect(readyContainer.props.children).toBe(children);
      expect(validatingContainer.props.children).toBe(children);
   });

   test('hides and disables retained inputs until revalidation finishes', () => {
      const html = renderToStaticMarkup(<SupportScopeBoundary {...props} state="validating" />);
      expect(html).toContain('display:none');
      expect(html).toContain('inert=""');
      expect(html).toContain('type="file"');
      expect(html).toContain('unsent reply');
      expect(html).toContain('data-testid="support-scope-guard"');

      const ready = renderToStaticMarkup(<SupportScopeBoundary {...props} state="ready" />);
      expect(ready).toContain('display:contents');
      expect(ready).not.toContain('inert=""');
      expect(ready).not.toContain('data-testid="support-scope-guard"');
   });

   test.each(['resetting', 'blocked'] as const)('removes the private subtree when %s', (state) => {
      const html = renderToStaticMarkup(
         <SupportScopeBoundary {...props} state={state} error="Access validation failed" />
      );
      expect(html).not.toContain('type="file"');
      expect(html).not.toContain('unsent reply');
      expect(html).toContain('data-testid="support-scope-guard"');
      if (state === 'blocked') expect(html).toContain('Access validation failed');
   });
});
