// Next's standalone output does not include .next/static or public. Copy them next to server.js
// so "scout web" serves styles, scripts and static files. Runs at the end of "npm run build:api".
// Interim, until the HTTP layer moves to Hono: it also copies the built web-ui app (web-ui/dist):
// its static files into public/, and index.html to web-ui/dist/index.html, where the fallback route
// (src/app/[[...app]]/route.ts) reads it.
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const standalone = '.next/standalone';
if (!existsSync(standalone)) {
  console.error('No .next/standalone found. Run "next build" first.');
  process.exit(1);
}
const webUi = 'web-ui/dist';
if (!existsSync(`${webUi}/index.html`)) {
  console.error('No web-ui/dist/index.html found. Run "npm run build:web-ui" first.');
  process.exit(1);
}
for (const [from, to] of [
  ['.next/static', `${standalone}/.next/static`],
  ['public', `${standalone}/public`],
]) {
  if (!existsSync(from)) continue;
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}
cpSync(webUi, `${standalone}/public`, { recursive: true, filter: (src) => path.normalize(src) !== path.normalize(`${webUi}/index.html`) });
rmSync(`${standalone}/${webUi}`, { recursive: true, force: true });
cpSync(`${webUi}/index.html`, `${standalone}/${webUi}/index.html`);
