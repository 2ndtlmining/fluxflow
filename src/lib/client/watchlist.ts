/**
 * A personal watchlist (#30), kept in this browser only.
 *
 * There is no account system, so nothing is sent to the server. Every storage access is
 * guarded: in a private window or with site data blocked, the watchlist is simply empty.
 */

const KEY = 'fluxflow-watchlist';
const MAX = 200;

export function readWatchlist(storage: Pick<Storage, 'getItem'> | null = safeStorage()): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

export function isWatched(address: string): boolean {
  return readWatchlist().includes(address);
}

/** Add or remove an address; returns whether it is now watched. */
export function toggleWatch(
  address: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()
): boolean {
  const list = readWatchlist(storage);
  const watched = !list.includes(address);
  const next = watched
    ? [address, ...list].slice(0, MAX)
    : list.filter((entry) => entry !== address);

  try {
    storage?.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked: the toggle lasts for this page only */
  }

  return watched;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
