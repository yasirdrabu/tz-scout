// robots.txt as Ruling 3 and RFC 9309 read it. The rules come from the `User-agent: *` group and any group naming
// Scout (both, merged: more cautious than the RFC's one most specific group). A rule's path may use `*` (any run of
// characters) and a trailing `$` (end of path). The longest matching rule decides; on a tie, Allow wins; no match
// allows. Whether a 5xx robots.txt means "read nothing" is the reader's call (`live.ts`).

export type Robots = { allows(path: string): boolean };

type Rule = { allow: boolean; length: number; test: (path: string) => boolean };

function rule(allow: boolean, pattern: string): Rule {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(`^${body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`);
  return { allow, length: pattern.length, test: (path) => re.test(path) };
}

export function parseRobots(text: string): Robots {
  const rules: Rule[] = [];
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
    if (field !== 'allow' && field !== 'disallow') continue;
    inRules = true;
    const ours = agents.some((a) => a === '*' || a.includes('scout'));
    if (ours && value) rules.push(rule(field === 'allow', value));
  }
  return {
    allows(path) {
      let best: Rule | null = null;
      for (const r of rules) {
        if (!r.test(path)) continue;
        if (!best || r.length > best.length || (r.length === best.length && r.allow)) best = r;
      }
      return best ? best.allow : true;
    },
  };
}
