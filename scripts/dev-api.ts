/**
 * API-only entry point for development.
 *
 * Runs the same service as `src/server.ts` but without the SvelteKit handler, so `vite dev`
 * can serve the UI on 5173 and proxy `/api` here. Production uses the single-process entry
 * instead — see `src/server.ts`.
 */

import { createService, installSignalHandlers } from '../src/lib/server/index.js';
import { fatal } from '../src/lib/server/logger.js';

async function main(): Promise<void> {
  const service = createService();
  installSignalHandlers(service);

  await service.listen();
}

main().catch((error: unknown) => {
  fatal('failed to start api', error);
  process.exit(1);
});
