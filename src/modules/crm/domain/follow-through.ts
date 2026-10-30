/** What the CRM holds for the company now, as stored by the last check. */
export type LatestState = {
  counts: Record<string, number>;
  tasks: { status: string; due: string | null }[];
  stage: string | null;
  ownerExternalId: string | null;
  lastActivityAt: Date | null;
};

export type FollowThroughCounts = {
  tasksDone: number;
  tasksTotal: number;
  overdue: number;
  emails: number;
  calls: number;
  meetings: number;
  deals: number;
  openDeals: number;
  stage: string | null;
  ownerExternalId: string | null;
  lastActivityAt: Date | null;
};

const isDone = (status: string) => status.toUpperCase() === 'COMPLETED';

/** Follow-through since the handoff: counts above what the company had when we pushed it, never below 0. Ported from v1 `followUpFrom`. */
export function followThroughCounts(latest: LatestState, baseline: Record<string, number>, now: Date): FollowThroughCounts {
  const since = (k: string) => Math.max(0, (latest.counts[k] ?? 0) - (baseline[k] ?? 0));
  const open = latest.tasks.filter((t) => !isDone(t.status));
  return {
    tasksDone: latest.tasks.length - open.length,
    tasksTotal: latest.tasks.length,
    overdue: open.filter((t) => t.due !== null && new Date(t.due).getTime() < now.getTime()).length,
    emails: since('emails'),
    calls: since('calls'),
    meetings: since('meetings'),
    deals: since('deals'),
    openDeals: latest.counts.openDeals ?? 0,
    stage: latest.stage,
    ownerExternalId: latest.ownerExternalId,
    lastActivityAt: latest.lastActivityAt,
  };
}

/** The same counts from a stored `crm.follow_through` row. */
export function countsOfRow(
  row: { baseline: Record<string, number>; latest: Record<string, number>; tasks: { status: string; due: string | null }[]; stage: string | null; ownerExternalId: string | null },
  lastActivityAt: Date | null,
  now: Date,
): FollowThroughCounts {
  return followThroughCounts({ counts: row.latest, tasks: row.tasks, stage: row.stage, ownerExternalId: row.ownerExternalId, lastActivityAt }, row.baseline, now);
}
