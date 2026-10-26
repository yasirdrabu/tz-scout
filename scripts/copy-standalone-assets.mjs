// Next's standalone output does not include .next/static or public. Copy them next to server.js
// so "scout web" serves styles, scripts and static files. Runs after "npm run build".
import { cpSync, existsSync, rmSync } from 'node:fs';

const standalone = '.next/standalone';
if (!existsSync(standalone)) {
  console.error('No .next/standalone found. Run "next build" first.');
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
