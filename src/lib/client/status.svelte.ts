/**
 * The last `/api/status` answer, shared. The status bar fetches it; anything else that needs
 * it (the catch-up banner) reads it here instead of polling the server a second time.
 */

import type { Status } from './types';

class ServerStatus {
  value = $state<Status | null>(null);
}

export const serverStatus = new ServerStatus();
