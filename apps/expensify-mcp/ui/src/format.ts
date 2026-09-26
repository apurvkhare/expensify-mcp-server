import type { DateRange } from './data.ts';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const inrWhole = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat('en-IN', { style: 'percent', maximumFractionDigits: 1 });
const day = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthYear = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export const formatINR = (amount: number) => inr.format(amount);
/** Headline figures and bar tips: paise are noise at that size. */
export const formatINRWhole = (amount: number) => inrWhole.format(amount);
export const formatShare = (part: number, whole: number) => percent.format(whole > 0 ? part / whole : 0);

/** YYYY-MM-DD, parsed as UTC so the label never slips a day in the viewer's zone. */
export const formatDate = (iso: string) => day.format(new Date(`${iso}T00:00:00Z`));
/** YYYY-MM */
export const formatMonth = (key: string) => (/^\d{4}-\d{2}$/.test(key) ? monthYear.format(new Date(`${key}-01T00:00:00Z`)) : key);

export function formatRange({ from, to }: DateRange): string {
  if (from && to) return from === to ? formatDate(from) : `${formatDate(from)} to ${formatDate(to)}`;
  if (from) return `Since ${formatDate(from)}`;
  if (to) return `Up to ${formatDate(to)}`;
  return 'All time';
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Month presets, counted from the viewer's clock. offset 0 is this month, -1 the one before. */
export function monthRange(offset: number, now = new Date()): Required<DateRange> {
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const last = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  return { from: iso(first), to: iso(offset === 0 ? now : last) };
}
