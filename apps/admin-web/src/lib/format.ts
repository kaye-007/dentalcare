import { toDay } from './api';

/**
 * Dates and figures, one way each. The console is NODE X's own tool and
 * stays in English, so these are en-GB throughout: day before month, which is
 * how every clinic it serves writes a date.
 */

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A date-only value ('YYYY-MM-DD'), which must not drift a day west of Greenwich. */
export function fmtDay(iso: string): string {
  return toDay(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function fmtNumber(n: number): string {
  return n.toLocaleString('en-GB');
}

/** "1 clinic", "3 clinics". */
export function plural(n: number, noun: string): string {
  return `${fmtNumber(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** "3 min ago", "yesterday", "12 Aug": the nearer, the finer. */
export function relative(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return fmtDate(iso);
}

/** Whole days since a timestamp, or null for never. */
export function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
}

/** 'YYYY-MM' for the month a timestamp or date falls in, in local time. */
export function monthKey(iso: string): string {
  const d = iso.length === 10 ? toDay(iso) : new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** The last `n` month keys, oldest first, ending with the current month. */
export function lastMonths(n: number): string[] {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (n - 1 - i), 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
}

export function monthLabel(key: string, style: 'short' | 'long' = 'short'): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y!, m! - 1, 1);
  return style === 'long'
    ? d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    : d.toLocaleDateString('en-GB', { month: 'short' });
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Initials for a person or a clinic: first letters of the first two words. */
export function initials(name: string): string {
  const words = name
    .replace(/^(dr\.?|klinika|clinic|studio|dental)\s+/i, '')
    .split(/\s+/)
    .filter(Boolean);
  const letters = words.slice(0, 2).map((w) => w[0]!.toUpperCase());
  return letters.join('') || '?';
}

/**
 * A spreadsheet of what is on screen. Quoted per RFC 4180, with a BOM so
 * Excel opens ë and ç as themselves rather than as mojibake — Albanian clinic
 * names are the norm here, not the exception. Cells that begin with = + - @
 * are prefixed so a spreadsheet does not execute a clinic name as a formula.
 */
export function downloadCsv(
  fileName: string,
  header: string[],
  rows: (string | number | null)[][],
): void {
  const cell = (v: string | number | null) => {
    if (v === null) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(
    new Blob(['﻿', body], { type: 'text/csv;charset=utf-8' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Today as YYYY-MM-DD, for file names. */
export function stamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
