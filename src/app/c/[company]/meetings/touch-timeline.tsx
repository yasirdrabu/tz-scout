// Every touch the show-up agent sent or will send, oldest first, with the message behind a toggle.

import type { MeetingTouch } from "@prisma/client";
import { Badge, cx } from "@/components/ui";
import { Disclosure } from "@/components/client";
import { dateTime, relative } from "@/lib/format";
import { CHANNEL_LABEL, TOUCH_STATUS_LABEL, TOUCH_STATUS_TONE, touchKindLabel } from "./labels";

type Touch = Pick<MeetingTouch, "id" | "kind" | "channel" | "status" | "dueAt" | "sentAt" | "subject" | "body">;

export function TouchTimeline({ touches, now = new Date() }: { touches: Touch[]; now?: Date }) {
  if (touches.length === 0) return <p className="px-4 py-4 text-sm text-ink-muted">No touches yet.</p>;
  const sorted = [...touches].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  return (
    <ol className="divide-y divide-line">
      {sorted.map((t) => (
        <li key={t.id} className="flex gap-3 px-4 py-3">
          <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", t.status === "SENT" ? "bg-good" : t.status === "SKIPPED" ? "bg-line-strong" : "bg-ink-faint")} aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-ink">{touchKindLabel(t.kind)}</span>
              <Badge tone={TOUCH_STATUS_TONE[t.status]}>{TOUCH_STATUS_LABEL[t.status]}</Badge>
              <span className="text-xs text-ink-muted">{CHANNEL_LABEL[t.channel]}</span>
              <span className="tnum ml-auto text-xs text-ink-muted" title={dateTime(t.sentAt ?? t.dueAt)}>
                {t.status === "SENT" && t.sentAt ? `Sent ${dateTime(t.sentAt)}` : t.status === "SKIPPED" ? `Was due ${dateTime(t.dueAt)}` : `Due ${dateTime(t.dueAt)} (${relative(t.dueAt, now)})`}
              </span>
            </div>
            <Disclosure summary={<span className="truncate text-xs font-normal">{t.subject ?? "Message"}</span>} className="mt-1">
              <div className="rounded border border-line bg-sunken/50 px-3 py-2 text-xs text-ink-soft">
                {t.subject && <div className="mb-1 font-medium text-ink">{t.subject}</div>}
                <div className="whitespace-pre-line break-words">{t.body}</div>
              </div>
            </Disclosure>
          </div>
        </li>
      ))}
    </ol>
  );
}
