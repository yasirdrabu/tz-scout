"use server";

import { authorize } from "@/server/context";
import { act, type ActionResult } from "@/server/action";
import { refreshFollowUp, returnToQueue, writeHandoffMessages } from "@/server/crm";

const path = (slug: string) => `/c/${slug}/buyers`;

export async function refreshFollowUpAction(slug: string, batchId: string | null, _prev: ActionResult | null, _fd: FormData): Promise<ActionResult> {
  let n = 0;
  const r = await act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      n = await refreshFollowUp(ctx, batchId);
    },
    { revalidate: path(slug) },
  );
  return r.ok ? { ...r, message: `Checked ${n} accounts in HubSpot.` } : r;
}

export async function writeHandoffMessagesAction(slug: string, batchId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      await writeHandoffMessages(ctx, batchId);
    },
    { revalidate: path(slug), message: "Messages written." },
  );
}

export async function returnToQueueAction(slug: string, accountId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      await returnToQueue(ctx, accountId);
    },
    { revalidate: path(slug), message: "Back in the queue." },
  );
}
