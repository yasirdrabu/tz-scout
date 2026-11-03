// robots.txt as Ruling 3 reads it: the `User-agent: *` group and any group naming Scout, `Disallow` path prefixes.
// `Allow` lines and wildcards are not read; a site that relies on them is read more cautiously, never less.

export type Robots = { allows(path: string): boolean };

export function parseRobots(text: string): Robots {
  const disallowed: string[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === 'user-agent') {
      // A user-agent line after rules starts a new group; consecutive ones share a group.
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
      continue;
    }
    inRules = true;
    const ours = agents.some((a) => a === '*' || a.includes('scout'));
    if (field === 'disallow' && ours && value) disallowed.push(value);
  }
  return { allows: (path) => !disallowed.some((prefix) => path.startsWith(prefix)) };
}
