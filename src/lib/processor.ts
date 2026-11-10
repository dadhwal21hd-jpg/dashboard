/**
 * TypeScript port of process_csv.py + clustered-customer extension.
 *
 * Core analytics output matches the original Python script byte-for-byte.
 * Adds clustered_customers, clustered_drill, cluster_membership for the
 * Individual/Clustered toggle in the Customers tab.
 *
 * Also reads the Oracle billing export (source of truth as of the 2026
 * cutover) and, optionally, its Goods Return tab — see parseDesign() and
 * the "returns" parameter below for what's specific to that source.
 */
import type {
  DashboardData,
  SheetRow,
  SubCut,
  Customer,
  StyleGroup,
  StyleEntry,
  MonthlyEntry,
  DrillData,
  RawRow,
} from "./types";
import { CLUSTERS, buildClusterLookup, clusterFor } from "./clusters";

// ─── HELPERS ────────────────────────────────────────────────────────────────

/** Extract the first integer/float from a price string. */
export function parsePrice(p: unknown): number {
  const s = String(p ?? "").trim().replace(/,/g, "");
  const m = s.match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

/** Extract integer quantity — returns 0 for non-numeric / non-positive values. */
export function parseQty(q: unknown): number {
  const s = String(q ?? "").trim().replace(/,/g, "");
  if (!s) return 0;
  const v = parseFloat(s);
  if (!Number.isFinite(v)) return 0;
  const i = Math.trunc(v);
  return i > 0 ? i : 0;
}

/** Python-compatible round() — banker's rounding (round half to even).
 *  JS Math.round rounds half away from zero (or up). Python rounds half to even. */
export function bankRound(n: number): number {
  const floor = Math.floor(n);
  const diff = n - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // Exactly .5 → round to even
  return floor % 2 === 0 ? floor : floor + 1;
}

const MONTH_ABBR: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse Oracle's "DD/Mon/YY" or "DD-Mon-YY" date format (e.g. "12/Aug/26",
 * "27-Aug-26" — both separators occur within the same Oracle export; verified
 * against real data, not assumed). Two-digit year: 20xx, per business context
 * (no records predate 2000). Returns null on failure.
 *
 * The DASH sheet also spells some months out ("13/October/26", "4/September/21",
 * "26/August/22" — 5,290 rows, measured Nov 2026), so any leading part of the
 * full month name is accepted too ("Sept", "October").
 */
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"];
function parseOracleDate(s: string): Date | null {
  const m = s.match(/^(\d{1,2})[/-]([A-Za-z]{3,9})[/-](\d{2,4})$/);
  if (!m) return null;
  const word = m[2].toLowerCase();
  const mo = MONTH_ABBR[word.slice(0, 3)];
  if (!mo || !MONTH_NAMES[mo - 1].startsWith(word)) return null;
  const day = parseInt(m[1], 10);
  const yRaw = parseInt(m[3], 10);
  const y = m[3].length === 2 ? 2000 + yRaw : yRaw;
  if (day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, day));
  if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === day) {
    return dt;
  }
  return null;
}

/** Parse dd/mm/yyyy → Date. Returns null on failure. Mirrors Python's parse_date.
 *  Tries Oracle's "DD-Mon-YY" / "DD/Mon/YY" format first (cheap regex miss for
 *  the numeric formats below), then falls back to the original numeric ones —
 *  kept for compatibility with any non-Oracle sheet this might ever read. */
export function parseDate(d: unknown): Date | null {
  const s = String(d ?? "").trim();
  if (!s) return null;

  const oracle = parseOracleDate(s);
  if (oracle) return oracle;

  // Try each format in order, same as Python
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => [number, number, number]]> = [
    // dd/mm/yyyy or dd/mm/yy (Added 2-digit year support)
    [/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/, (m) => {
      let y = parseInt(m[3], 10);
      if (y < 100) y += 2000;
      return [y, parseInt(m[2], 10), parseInt(m[1], 10)];
    }],
    // dd-mm-yyyy or dd-mm-yy (Added 2-digit year support)
    [/^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})$/, (m) => {
      let y = parseInt(m[3], 10);
      if (y < 100) y += 2000;
      return [y, parseInt(m[2], 10), parseInt(m[1], 10)];
    }],
    // dd.mm.yyyy or dd.mm.yy (Added dot separator support)
    [/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/, (m) => {
      let y = parseInt(m[3], 10);
      if (y < 100) y += 2000;
      return [y, parseInt(m[2], 10), parseInt(m[1], 10)];
    }],
    // yyyy-mm-dd
    [/^(\d{4})-(\d{1,2})-(\d{1,2})$/, (m) => [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]],
    // mm/dd/yyyy or mm/dd/yy
    [/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/, (m) => {
      let y = parseInt(m[3], 10);
      if (y < 100) y += 2000;
      return [y, parseInt(m[1], 10), parseInt(m[2], 10)];
    }],
  ];

  for (const [re, build] of patterns) {
    const m = s.match(re);
    if (m) {
      const [y, mo, day] = build(m);
      // Validate the date is real (e.g. not 31/02/2024)
      if (mo < 1 || mo > 12 || day < 1 || day > 31) continue;
      const dt = new Date(Date.UTC(y, mo - 1, day));
      if (
        dt.getUTCFullYear() === y &&
        dt.getUTCMonth() === mo - 1 &&
        dt.getUTCDate() === day
      ) {
        return dt;
      }
    }
  }
  return null;
}