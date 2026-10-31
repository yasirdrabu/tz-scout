import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { formatDate, formatDateTime, formatMoney, formatNumber, formatPercent, formatRelative, formatTime } from './format';

type TenantFormat = { currency: string; timeZone: string };

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const FormatContext = createContext<TenantFormat>({ currency: 'USD', timeZone: browserZone() });

/** Gives screens the workspace's currency and timezone (from `/me` tenant). Missing values keep the defaults. */
export function FormatProvider({ currency, timeZone, children }: { currency?: string | undefined; timeZone?: string | undefined; children: ReactNode }) {
  const parent = useContext(FormatContext);
  const value = useMemo(
    () => ({ currency: currency ?? parent.currency, timeZone: timeZone ?? parent.timeZone }),
    [currency, timeZone, parent],
  );
  return <FormatContext.Provider value={value}>{children}</FormatContext.Provider>;
}

/** lib/format bound to the workspace's currency and timezone. */
export function useFormat() {
  const { currency, timeZone } = useContext(FormatContext);
  return useMemo(
    () => ({
      money: (minor: number) => formatMoney(minor, currency),
      date: (when: string | number | Date) => formatDate(when, timeZone),
      dateTime: (when: string | number | Date) => formatDateTime(when, timeZone),
      time: (when: string | number | Date) => formatTime(when, timeZone),
      relative: (when: string | number | Date) => formatRelative(when),
      number: formatNumber,
      percent: formatPercent,
    }),
    [currency, timeZone],
  );
}
