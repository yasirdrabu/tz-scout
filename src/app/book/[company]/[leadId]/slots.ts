// Bookable slots for the public booking page: the next 5 business days at fixed Eastern times.
// The server rebuilds this list when booking, so only an offered slot can be booked.

export const BOOKING_TZ = "America/New_York";
export const BOOKING_TZ_LABEL = "Eastern time";
const TIMES: [number, number][] = [
  [10, 0],
  [13, 0],
  [15, 30],
];
const DAYS = 5;

function parts(instant: number, tz: string) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(new Date(instant));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, min: get("minute"), s: get("second") };
}

const offsetAt = (instant: number, tz: string) => {
  const p = parts(instant, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(instant / 1000) * 1000;
};

/** The instant when the wall clock in `tz` reads y-m-d h:min. Handles daylight saving changes. */
export function zonedTime(y: number, m: number, d: number, h: number, min: number, tz = BOOKING_TZ): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let t = guess - offsetAt(guess, tz);
  const again = guess - offsetAt(t, tz);
  if (again !== t) t = again;
  return new Date(t);
}

export type Slot = { iso: string; day: string; time: string };
export type SlotDay = { day: string; slots: Slot[] };

export function bookingSlots(now = new Date()): SlotDay[] {
  const today = parts(now.getTime(), BOOKING_TZ);
  const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: BOOKING_TZ, weekday: "long", month: "long", day: "numeric" });
  const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: BOOKING_TZ, hour: "numeric", minute: "2-digit" });
  const out: SlotDay[] = [];
  for (let i = 1; out.length < DAYS && i < 14; i++) {
    const cal = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const wd = cal.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const slots = TIMES.map(([h, min]) => zonedTime(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), h, min))
      .filter((at) => at.getTime() > now.getTime())
      .map((at) => ({ iso: at.toISOString(), day: dayFmt.format(at), time: timeFmt.format(at) }));
    if (slots.length) out.push({ day: slots[0]!.day, slots });
  }
  return out;
}

export function formatBooked(at: Date): string {
  return `${new Intl.DateTimeFormat("en-US", { timeZone: BOOKING_TZ, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at)} ${BOOKING_TZ_LABEL}`;
}
