"use client";

import { useRouter } from "next/navigation";

export function SegmentFilter({ slug, current, groups }: { slug: string; current: string; groups: { offering: string; segments: { id: string; buyer: string; count: number }[] }[] }) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-ink-muted">Segment</span>
      <select className="input w-auto min-w-[280px] max-w-full" value={current} onChange={(e) => router.push(e.target.value ? `/c/${slug}/tests/library?segment=${e.target.value}` : `/c/${slug}/tests/library`)}>
        <option value="">All segments</option>
        {groups.map((g) => (
          <optgroup key={g.offering} label={g.offering}>
            {g.segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.buyer} ({s.count})
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
