/** The 14 module schema names, as listed in architecture/events-and-async.md. */
export const MODULE_SCHEMAS = [
  'tenancy',
  'intake',
  'accounts',
  'enrichment',
  'scoring',
  'offers',
  'playbooks',
  'routing',
  'crm',
  'campaigns',
  'analytics',
  'integrations',
  'ai',
  'platform',
] as const;

/** Second tokens that belong to streams other than SCOUT_EVENTS. Never module names. */
export const RESERVED_TOKENS = ['jobs', 'webhooks', 'replay'] as const;

const TOKEN = /^[A-Za-z0-9_-]+$/;

function check(label: string, value: string): void {
  if (value.split('.').some((p) => !TOKEN.test(p))) {
    throw new Error(`Invalid ${label} "${value}": use dot separated words with letters, digits, - or _`);
  }
}

/** `scout.<tenantId>.<schema>.<entity>.<verb>`. */
export function eventSubject(tenantId: string, type: string): string {
  check('tenant id', tenantId);
  check('event type', type);
  const first = type.split('.')[0] as string;
  if ((RESERVED_TOKENS as readonly string[]).includes(first)) {
    throw new Error(`Event type "${type}" uses the reserved token "${first}"`);
  }
  if (!(MODULE_SCHEMAS as readonly string[]).includes(first)) {
    throw new Error(`Event type "${type}" does not start with a module schema name`);
  }
  return `scout.${tenantId}.${type}`;
}

/** `scout.<tenantId>.jobs.<name>`. */
export function jobSubject(tenantId: string, name: string): string {
  check('tenant id', tenantId);
  check('job name', name);
  return `scout.${tenantId}.jobs.${name}`;
}
