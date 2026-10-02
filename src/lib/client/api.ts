/**
 * Browser-side helpers for talking to the API.
 *
 * Browser-only: this module touches `window` and `import.meta.env`, so it must never be
 * imported from `$lib/server` or `$lib/shared`. The API lives on the same origin as the app
 * in production (single process, single port), so relative `/api/...` URLs are the target.
 * `VITE_API_URL` stays available as an escape hatch for split deployments and for the
 * interim two-process dev setup.
 */

/**
 * Base URL for API requests.
 *
 * Returns an empty string for same-origin requests, which keeps `/api/...` relative.
 *
 * Note: while the API still runs as a separate process on port 3000 (`npm run dev`), the
 * `localhost:3000` special case keeps the browser pointed at it. It is removed once the
 * single-process server entry lands.
 */
export function getApiUrl(): string {
  const override = import.meta.env.VITE_API_URL;
  if (override) return override.replace(/\/$/, '');

  if (typeof window === 'undefined') return '';

  const { hostname } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://localhost:3000';
  }

  return '';
}

/** Build a full URL for an API path, e.g. `apiUrl('/flow/24H')`. */
export function apiUrl(path: string): string {
  return `${getApiUrl()}/api${path}`;
}

/** `fetch` a JSON API endpoint, throwing a useful error on non-2xx responses. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init
  });

  if (!response.ok) {
    throw new Error(`API ${init?.method ?? 'GET'} ${path} failed: ${response.status}`);
  }

  return (await response.json()) as T;
}
