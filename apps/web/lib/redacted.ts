import type { RedactedRef } from '@/lib/taskara-types';

/**
 * Reading a relation the server may have withheld.
 *
 * The server never drops a walled-off relation, it replaces it (#58, #60): the shape says "there is
 * one here and you may not open it". That distinction only survives if the client keeps it — a
 * component that renders a redacted project as «بدون پروژه» has turned a withholding into a false
 * statement, which is the failure #58 spent a ticket arguing against.
 *
 * So: {@link readable} to get at the fields, {@link isRedacted} to render the placeholder, and never
 * `value?.name` on something that might be redacted.
 */
export function isRedacted(value: unknown): value is RedactedRef {
   return typeof value === 'object' && value !== null && (value as Partial<RedactedRef>).redacted === true;
}

/** The relation itself, or `null` for both "there isn't one" and "you may not see it". */
export function readable<T>(value: T | RedactedRef | null | undefined): T | null {
   if (!value || isRedacted(value)) return null;
   return value as T;
}
