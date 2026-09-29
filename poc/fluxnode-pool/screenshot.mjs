#!/usr/bin/env node
// Screenshot a generated report.html (full page + per-section crops).
//
//   node poc/fluxnode-pool/screenshot.mjs poc/fluxnode-pool/out/live
//
// Needs `playwright-core` (or `playwright`) resolvable, and a Chromium binary.
// Set CHROMIUM_PATH to point at one if Playwright's bundled browser isn't installed.

import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pw;
for (const name of ['playwright-core', 'playwright']) {
  try { pw = require(process.env.PLAYWRIGHT_MODULE || name); break; } catch { /* next */ }
}
if (!pw) { console.error('install playwright-core first'); process.exit(1); }

const dir = path.resolve(process.argv[2] || 'poc/fluxnode-pool/out/live');
const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1240, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`file://${path.join(dir, 'report.html')}`);
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(dir, 'report-full.png'), fullPage: true });

const panels = await page.$$('main > .grid, main > .panel:not(.banner)');
const names = ['kpis', 'charts', 'distribution-integrity', 'data-fitness', 'deep-history', 'sample-events', 'log'];
for (let i = 0; i < panels.length && i < names.length; i++) {
  await panels[i].screenshot({ path: path.join(dir, `${String(i + 1).padStart(2, '0')}-${names[i]}.png`) });
}
await browser.close();
console.log(`screenshots written to ${dir}`);
