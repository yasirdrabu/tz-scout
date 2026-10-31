import { formatCompact, formatDate, formatDateTime, formatDuration, formatMoney, formatNumber, formatPercent, formatRelative, formatTime } from './format';

describe('formatMoney', () => {
  it('formats integer cents in the tenant currency', () => {
    expect(formatMoney(118300, 'USD')).toBe('$1,183');
    expect(formatMoney(118350, 'USD')).toBe('$1,183.50');
    expect(formatMoney(5, 'USD')).toBe('$0.05');
    expect(formatMoney(200000, 'GBP')).toBe('£2,000');
    expect(formatMoney(150000, 'EUR')).toBe('€1,500');
  });

  it('uses the currency’s own minor unit', () => {
    expect(formatMoney(1500, 'JPY')).toBe('¥1,500');
  });

  it('formats negatives', () => {
    expect(formatMoney(-41000, 'USD')).toBe('-$410');
  });
});

describe('formatPercent', () => {
  it('formats decimals as percents', () => {
    expect(formatPercent(0.15)).toBe('15%');
    expect(formatPercent(0.003)).toBe('0.3%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0)).toBe('0%');
  });
});

describe('formatNumber', () => {
  it('groups thousands', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
});

describe('dates in the tenant timezone', () => {
  const at = '2026-10-26T14:48:00Z';

  it('formats a date', () => {
    expect(formatDate(at, 'America/New_York')).toBe('Oct 26, 2026');
    expect(formatDate('2026-10-27T02:00:00Z', 'America/Los_Angeles')).toBe('Oct 26, 2026');
    expect(formatDate('2026-10-27T02:00:00Z', 'Asia/Kolkata')).toBe('Oct 27, 2026');
  });

  it('formats a date and time like the mockup', () => {
    expect(formatDateTime(at, 'America/New_York')).toBe('Oct 26, 10:48 AM');
    expect(formatDateTime(at, 'Europe/London')).toBe('Oct 26, 2:48 PM');
  });

  it('formats a time', () => {
    expect(formatTime(at, 'America/New_York')).toBe('10:48 AM');
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-10-31T12:00:00Z');

  it.each([
    ['2026-10-31T11:59:40Z', 'just now'],
    ['2026-10-31T11:58:00Z', '2 minutes ago'],
    ['2026-10-31T09:00:00Z', '3 hours ago'],
    ['2026-10-30T12:00:00Z', 'yesterday'],
    ['2026-10-29T12:00:00Z', '2 days ago'],
    ['2026-10-10T12:00:00Z', '3 weeks ago'],
    ['2026-07-31T12:00:00Z', '3 months ago'],
    ['2024-10-31T12:00:00Z', '2 years ago'],
    ['2026-11-03T12:00:00Z', 'in 3 days'],
  ])('%s is %s', (when, text) => {
    expect(formatRelative(when, now)).toBe(text);
  });
});

describe('formatDuration', () => {
  it.each([
    [412, '412 ms'],
    [1800, '1.8 s'],
    [45_000, '45 s'],
    [360_000, '6 min'],
    [5_400_000, '1.5 h'],
  ])('%d ms is %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('formatCompact', () => {
  it.each([
    [950, '950'],
    [18_400, '18.4K'],
    [2_100_000, '2.1M'],
  ])('%d is %s', (n, text) => {
    expect(formatCompact(n)).toBe(text);
  });
});
