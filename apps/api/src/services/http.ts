export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    /** Optional safe response fields (for example a conflict code and current projection). */
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function statusCodeFromError(error: unknown, message?: string): number {
  if (error instanceof HttpError) return error.statusCode;

  const statusCode = getStatusCodeProperty(error, 'statusCode') ?? getStatusCodeProperty(error, 'status');
  if (statusCode) return statusCode;

  if ((message || errorMessage(error)).toLowerCase().includes('not found')) return 404;
  return 500;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Internal server error';
}

function getStatusCodeProperty(error: unknown, property: 'status' | 'statusCode'): number | undefined {
  if (!error || typeof error !== 'object' || !(property in error)) return undefined;
  const value = (error as Record<string, unknown>)[property];
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}
