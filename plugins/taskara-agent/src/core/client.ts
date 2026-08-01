import type { TaskaraConfig } from './config';
import { TaskaraError, exitCodeForStatus, exitCodes } from './errors';

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: QueryValues;
}

export type QueryValues = Record<string, string | number | boolean | undefined>;

/**
 * Transport. Base URL, auth headers, and the mapping from an HTTP outcome to an exit code — nothing
 * about presentation, which is each shell's own business.
 */
export class TaskaraClient {
  constructor(readonly config: TaskaraConfig) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const hasBody = options.body !== undefined;
    const response = await this.send(path, {
      method: options.method ?? 'GET',
      // Only declare a JSON body when there is one. Fastify rejects a request that announces
      // `application/json` and then sends nothing with FST_ERR_CTP_EMPTY_JSON_BODY — a 400 that
      // reads as "the server refused your request" when the truth is the client described itself
      // wrongly. It is `DELETE /tasks/:key/dependencies/:blocker` that hits this.
      headers: hasBody ? this.headers({ 'content-type': 'application/json' }) : this.headers(),
      body: hasBody ? JSON.stringify(options.body) : undefined
    }, options.query);
    return this.read<T>(response);
  }

  /** Multipart upload. Content-type is left to `fetch`, which has to append the boundary. */
  async requestForm<T>(path: string, form: FormData): Promise<T> {
    const response = await this.send(path, {
      method: 'POST',
      headers: this.headers(),
      body: form
    });
    return this.read<T>(response);
  }

  private async send(path: string, init: RequestInit, query?: QueryValues): Promise<Response> {
    const url = `${this.config.apiUrl}${path}${queryString(query)}`;
    try {
      return await fetch(url, init);
    } catch (error) {
      // No status, so no HTTP mapping applies. This is the one failure where the caller genuinely
      // does not know whether the work happened, and the exit code says so rather than guessing.
      throw new TaskaraError(`Cannot reach the Taskara API at ${this.config.apiUrl}`, {
        exitCode: exitCodes.unreachable,
        cause: error
      });
    }
  }

  private async read<T>(response: Response): Promise<T> {
    const text = await response.text();
    const body = parseJson(text);

    if (!response.ok) {
      throw new TaskaraError(errorMessage(body, response), {
        exitCode: exitCodeForStatus(response.status),
        status: response.status,
        body
      });
    }
    return body as T;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'x-workspace-slug': this.config.workspaceSlug,
      ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
      ...(this.config.userEmail ? { 'x-user-email': this.config.userEmail } : {}),
      // The runtime, and only the runtime. `x-actor-type` is deliberately absent: the old surface
      // sent `CODEX` on every call under every runtime, which was both a lie and a claim about its
      // own identity that it was in no position to make. Provenance is now derived server-side from
      // the authenticated User, and this header at most qualifies an actor already proven to be an
      // agent.
      ...(this.config.runtime ? { 'x-agent-runtime': this.config.runtime } : {}),
      ...extra
    };
  }
}

function queryString(query?: QueryValues): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `?${search}` : '';
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A proxy or a crash can return HTML where JSON was promised. Handing the raw text back keeps
    // the real cause visible instead of replacing it with a parse error about the error.
    return { message: text.slice(0, 500) };
  }
}

function errorMessage(body: unknown, response: Response): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return `${response.status} ${response.statusText}`.trim();
}
