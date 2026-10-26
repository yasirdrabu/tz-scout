'use server';

import { discardDeadJob, retryDeadJob, type AdminCtx } from '@/platform/dead-jobs';
import { withTenant } from '@/platform/db/tenant';
import { pingResult, sendPing } from '@/platform/diagnostics';
import { PLATFORM_TENANT } from '@/platform/audit';
import { newId } from '@/platform/ids';
import { pauseSchedule, resumeSchedule, runNow } from '@/platform/scheduler';
import { act, str, type ActionResult } from '@/server/action';
import { adminContext } from '@/server/page-context';

const REVALIDATE = '/admin/system';
const NO_ANSWER = 'No answer after 10 seconds. Check the worker and relay.';

async function adminCtx(): Promise<AdminCtx> {
  const admin = await adminContext();
  return { actor: { kind: 'user', id: admin.userId }, correlationId: newId('cor') };
}

export async function retryDeadJobAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return act(async () => retryDeadJob(await adminCtx(), str(fd, 'id')), {
    revalidate: REVALIDATE,
    message: 'Sent again.',
  });
}

export async function discardDeadJobAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return act(async () => discardDeadJob(await adminCtx(), str(fd, 'id')), {
    revalidate: REVALIDATE,
    message: 'Discarded.',
  });
}

export async function pauseScheduleAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return act(async () => pauseSchedule(await adminCtx(), str(fd, 'id')), { revalidate: REVALIDATE, message: 'Paused.' });
}

export async function resumeScheduleAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return act(async () => resumeSchedule(await adminCtx(), str(fd, 'id')), { revalidate: REVALIDATE, message: 'Resumed.' });
}

export async function runNowAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return act(async () => runNow(await adminCtx(), str(fd, 'id')), { revalidate: REVALIDATE, message: 'Started.' });
}

/** Sends a ping through the outbox, relay, NATS and worker, and waits up to 10 seconds for the answer. */
export async function sendTestEventAction(): Promise<ActionResult> {
  try {
    const ctx = await adminCtx();
    const id = await withTenant(PLATFORM_TENANT, (tx) =>
      sendPing({ tenantId: PLATFORM_TENANT, actor: ctx.actor, correlationId: ctx.correlationId ?? newId('cor'), tx }),
    );
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const r = await pingResult(id);
      if (r) return { ok: true, message: `Round trip: ${Math.max(0, r.handledAt.getTime() - r.sentAt.getTime())} ms` };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { ok: false, error: NO_ANSWER };
  } catch (e) {
    const r = await act(async () => {
      throw e;
    });
    return r;
  }
}
