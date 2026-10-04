/**
 * Browser-side access to the API.
 *
 * The API lives on the same origin as the app (one process, one port), so every request is
 * a relative `/api/...` URL; in development, Vite proxies `/api` to the API server.
 * `VITE_API_URL` remains as an escape hatch for split deployments.
 *
 * Responses carry an ETag tied to the data version (#3, #4). The browser's HTTP cache already
 * revalidates with `If-None-Match`, so a repeat request between syncs costs a 304 and no
 * body. On top of that, `cachedFetch` keeps the last answer per URL in memory so a period
 * switch can show the previous data instantly while the new request is in flight (#26).
 */

export function getApiUrl(): string {
  const override = import.meta.env.VITE_API_URL as string | undefined;
  return override ? override.replace(/\/$/, '') : '';
}

/** Build a full URL for an API path, e.g. `apiUrl('/flow/24H')`. */
export function apiUrl(path: string): string {
  return `${getApiUrl()}/api${path}`;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string
  ) {
    super(
      status === 0
        ? `Could not reach the server for ${path}. Check that FluxFlow is running.`
        : `The server answered ${status} for ${path}.`
    );
  }
}

/** `fetch` a JSON endpoint; throws `ApiError` on failure and `AbortError` when aborted. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: init.body ? { 'content-type': 'application/json' } : undefined
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, path);
  }

  if (!response.ok) throw new ApiError(response.status, path);
  return (await response.json()) as T;
}

const memory = new Map<string, unknown>();

/** The last successful answer for a path, if any: what to show while revalidating. */
export function peek<T>(path: string): T | undefined {
  return memory.get(path) as T | undefined;
}

/** Fetch and remember the answer, so the next `peek` of this path is instant. */
export async function cachedFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  const data = await apiFetch<T>(path, signal ? { signal } : {});
  memory.set(path, data);
  // A long session must not grow without bound: keep the most recent answers only.
  if (memory.size > 100) memory.delete(memory.keys().next().value!);
  return data;
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
