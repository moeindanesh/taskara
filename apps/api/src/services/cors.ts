import { config } from '../config';

const configuredCorsOrigins = new Set([
  config.WEB_ORIGIN,
  ...config.TASKARA_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
]);

export function resolveCorsOrigin(origin: unknown): string | null {
  if (typeof origin !== 'string') return null;

  const normalizedOrigin = origin.trim();
  if (!normalizedOrigin) return null;
  if (configuredCorsOrigins.has(normalizedOrigin)) return normalizedOrigin;
  if (isDevelopmentLoopbackOrigin(normalizedOrigin)) return normalizedOrigin;

  return null;
}

function isDevelopmentLoopbackOrigin(origin: string): boolean {
  if (process.env.NODE_ENV === 'production') return false;

  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
