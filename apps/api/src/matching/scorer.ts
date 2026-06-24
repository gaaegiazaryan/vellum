/**
 * Deterministic linear scorer for matching a bank_transaction against
 * a journal_entry candidate. Per ADR-0019:
 *   combined = 0.5*amount + 0.35*date + 0.15*vendor
 * Surface only candidates with combined >= 0.5; top-3.
 *
 * Three pure functions for the three signals so they're each unit-
 * testable in isolation and a future re-weighting pass can graph
 * each curve. The combined score is also pure: same inputs, same
 * output, no clock or randomness.
 */

export const MIN_SUGGEST_SCORE = 0.5;
export const SUGGEST_TOP_N = 3;

const AMOUNT_WEIGHT = 0.5;
const DATE_WEIGHT = 0.35;
const VENDOR_WEIGHT = 0.15;

export interface ScoreInput {
  bankAmountMinor: bigint;
  bankOccurredAt: Date;
  bankMerchantName: string | null;
  entryTotalMinor: bigint;
  entryOccurredAt: Date;
  entryVendorName: string | null;
}

export interface Score {
  amount: number;
  date: number;
  vendor: number;
  combined: number;
}

export function score(input: ScoreInput): Score {
  const amount = scoreAmount(input.bankAmountMinor, input.entryTotalMinor);
  const date = scoreDate(input.bankOccurredAt, input.entryOccurredAt);
  const vendor = scoreVendor(input.bankMerchantName, input.entryVendorName);
  const combined = round3(AMOUNT_WEIGHT * amount + DATE_WEIGHT * date + VENDOR_WEIGHT * vendor);
  return { amount, date, vendor, combined };
}

export function scoreAmount(bank: bigint, entry: bigint): number {
  if (bank === entry) return 1;
  // Plaid amounts arrive as major-unit floats; rounding through *100 can
  // produce a 1-cent off-by-one. Treat ±1 minor unit as near-match.
  const delta = bank > entry ? bank - entry : entry - bank;
  if (delta === 1n) return 0.9;
  return 0;
}

export function scoreDate(bank: Date, entry: Date): number {
  const days = Math.abs(daysBetween(bank, entry));
  if (days === 0) return 1;
  if (days === 1) return 0.8;
  if (days <= 3) return 0.4;
  if (days <= 7) return 0.1;
  return 0;
}

export function scoreVendor(bank: string | null, entry: string | null): number {
  const a = normalize(bank);
  const b = normalize(entry);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.7;
  const aFirst = firstToken(a);
  const bFirst = firstToken(b);
  if (aFirst && bFirst && aFirst === bFirst) return 0.3;
  return 0;
}

function normalize(s: string | null): string {
  if (!s) return '';
  // Apostrophes (straight and curly) first, so 'McDonald\'s' collapses to
  // 'mcdonalds' instead of 'mcdonald s'. Plaid merchant strings are
  // typically punctuation-free while OCR'd receipts preserve them, and a
  // word split on the apostrophe breaks even the first-token fallback.
  return s
    .toLowerCase()
    .replace(/['’]+/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstToken(s: string): string {
  const i = s.indexOf(' ');
  return i === -1 ? s : s.slice(0, i);
}

function daysBetween(a: Date, b: Date): number {
  // Calendar-day diff in UTC, NOT a 24h rolling delta. Late-night
  // receipts vs morning-after Plaid postings on the same date should
  // score 'same day', and ones across midnight should not silently
  // promote to 0 by sneaking past a 12h rounding threshold. Floor each
  // to UTC midnight before subtracting.
  const ordA = Math.floor(
    Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()) / 86_400_000,
  );
  const ordB = Math.floor(
    Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) / 86_400_000,
  );
  return ordA - ordB;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
