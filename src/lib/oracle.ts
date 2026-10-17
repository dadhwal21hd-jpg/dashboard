/**
 * Oracle sales + Goods Return rows, read from Supabase (Oct 2026 cutover —
 * replaces the hand-maintained Google Sheet tabs).
 *
 *   SALES    `oracle_bill_lines`  (Oracle API from 1 Apr 2026; older deleted
 *            bills were backfilled from the DASH sheet as source='dash')
 *   RETURNS  `oracle_gr_report`   (Oracle API from 4 Apr 2026)
 *   NAMES    `party_aliases`      (spelling variants → one canonical party)
 *
 * Rows are handed back in the same header-keyed shape the Google Sheet gave
 * ("Item Description", "Design", "Buyer Name", "Bill No.", "Bill Dt.", …), so
 * processor.ts needs no second input path.
 *
 * Rules that came with the data (WIP_HEART session, 13 Oct 2026):
 *   - A line Oracle later removed has `gone_since` set, but the piece HAS left
 *     the building — it counts as sold. Rows are never dropped for gone_since.
 *   - Price is `SP` (unit selling price). `BP` is empty on API lines; do not use.
 *   - `oracle_gr_report` is emptied and reloaded twice a day, so it can be
 *     briefly empty/short. A suspiciously small read keeps the previous figures
 *     instead of reading zero returns.
 *   - A bill is Bill_No + Bill_Dt (+ buyer); bill numbers repeat across Oracle's
 *     books, so nothing here keys on Bill_No alone.
 *
 * HISTORY  The ledger only starts 1 Apr 2026. Until the API history is loaded, the
 *          DASH sheet tab (Apr 2021 onward, same Oracle columns, price in "BP")
 *          fills in everything BEFORE the ledger's first day — see
 *          fetchOracleHistory(). Once the ledger itself reaches back further,
 *          the DASH rows it now covers drop out by themselves (nothing is
 *          counted twice, whatever the overlap).
 *
 * Env vars: PROJECT_URL, ANON_KEY (same Supabase project as the stock tables).
 *           GOOGLE_HISTORY_RANGE (optional, default "DASH") — tab in the
 *           GOOGLE_SHEET_ID spreadsheet; set to "off" to skip the history.
 */
import type { SheetRow } from "./types";
import { parseDate } from "./processor";
import { fetchRange } from "./sheets";

export function oracleConfigured(): boolean {
  return !!(process.env.PROJECT_URL && process.env.ANON_KEY);
}

const PAGE = 1000;          // PostgREST's max-rows cap on this project
// Pages fetched at once after the first. 20 covers the whole sales table
// (~18 pages) in one round; at 6 it took three rounds. Same requests either
// way — measured median 1.65 s -> 1.1 s for a cold read.
const CONCURRENCY = 20;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Below this many return rows (or under half of the last good read) the table
// is treated as "mid-reload", not as "no returns".
const MIN_PLAUSIBLE_RETURNS = 300;

function creds() {
  const base = (process.env.PROJECT_URL || "").replace(/\/+$/, "");
  const key = process.env.ANON_KEY || "";
  return { base, headers: { apikey: key, Authorization: `Bearer ${key}` } };
}

/** Every row of a table. First request learns the exact total from
 *  Content-Range; the remaining pages go out in parallel batches. `order` must
 *  be a unique column — limit/offset over an unordered query can double-count
 *  or drop rows. Throws on any failure (never returns a partial table). */
async function readAll<T>(table: string, select: string, order: string): Promise<T[]> {
  const { base, headers } = creds();
  const page = async (offset: number) => {
    const url = `${base}/rest/v1/${table}?select=${select}&order=${order}&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, { headers: { ...headers, Prefer: "count=exact" }, cache: "no-store" });
    if (!res.ok) throw new Error(`${table} read failed: ${res.status} ${await res.text()}`);
    const total = Number((res.headers.get("content-range") || "").split("/")[1]);
    return { rows: (await res.json()) as T[], total };
  };

  const first = await page(0);
  if (!Number.isFinite(first.total)) throw new Error(`${table}: no row total from Supabase`);
  const out: T[] = [...first.rows];

  const offsets: number[] = [];
  for (let o = first.rows.length; o < first.total; o += PAGE) offsets.push(o);
  for (let i = 0; i < offsets.length; i += CONCURRENCY) {
    const batch = await Promise.all(offsets.slice(i, i + CONCURRENCY).map(page));
    for (const b of batch) out.push(...b.rows);
  }
  // Rows can be added between the first and last page; a SHORT read is the bug.
  if (out.length < first.total) throw new Error(`${table}: read ${out.length} of ${first.total} rows`);
  return out;
}

// ── Party names ─────────────────────────────────────────────────────────────

/** Own-people accounts. The alias table folds a few of these into customers
 *  (e.g. "prakash ji" → "Dimple Fashion"), which would bury internal
 *  dispatches inside a real customer's revenue. They stay under their own
 *  names so they remain visible as internal. */
const INTERNAL_PARTIES = new Set([
  "PRAKASH JI", "ANKUR JI", "PATHAK JI", "KRITI MADAM HOUSE", "KRITI MAM",
  "JYOTI MAM HOUSE", "KRITI MAM FRIENDS", "MANOJ JI", "RAJA SIR",
]);

/** Same comparison key as WIP_HEART's party_alias._norm: trim, collapse
 *  whitespace, lowercase. */
const aliasKey = (n: string) => n.split(/\s+/).filter(Boolean).join(" ").toLowerCase();

async function loadAliases(): Promise<Map<string, string>> {
  const rows = await readAll<{ alias_normalized: string; canonical_name: string }>(
    "party_aliases", "alias_normalized,canonical_name", "alias_normalized",
  );
  const m = new Map<string, string>();
  for (const r of rows) {
    if (!r.canonical_name) continue;
    if (INTERNAL_PARTIES.has(r.alias_normalized.trim().toUpperCase())) continue;
    m.set(aliasKey(r.alias_normalized), r.canonical_name);
  }
  return m;
}

// ── Row shaping ─────────────────────────────────────────────────────────────

interface BillLine {
  Item_Description: string | null; Design: string | null; Buyer_Name: string | null;
  Bill_No: string | null; Bill_Dt: string | null; Remarks: string | null;
  Quantity: number | string | null; SP: number | string | null;
}
interface GrLine {
  Item_Description: string | null; Design: string | null; Buyer_Name: string | null;
  Bill_No: string | null; Bill_Dt: string | null;
  Quantity: number | string | null; Rate: number | string | null;
}

const s = (v: unknown) => String(v ?? "").trim();

// ── Cache ───────────────────────────────────────────────────────────────────

interface Entry { rows: SheetRow[]; fetchedAt: number }
let salesCache: Entry | null = null;
let returnsCache: Entry | null = null;
/** Last returns read that looked complete — what to keep showing while the
 *  table is mid-reload. */
let lastGoodReturns: Entry | null = null;

const fresh = (e: Entry | null) => !!e && Date.now() - e.fetchedAt < CACHE_TTL_MS;

export async function fetchOracleSales(force = false): Promise<{ rows: SheetRow[]; fetchedAt: number; fromCache: boolean }> {
  if (!force && salesCache && fresh(salesCache)) return { ...salesCache, fromCache: true };

  const [lines, aliases] = await Promise.all([
    readAll<BillLine>(
      "oracle_bill_lines",
      "Item_Description,Design,Buyer_Name,Bill_No,Bill_Dt,Remarks,Quantity,SP",
      "line_key",
    ),
    loadAliases(),
  ]);

  const rows: SheetRow[] = lines.map((l) => {
    const buyer = s(l.Buyer_Name);
    return {
      "Item Description": s(l.Item_Description),
      "Design": s(l.Design),
      "Buyer Name": aliases.get(aliasKey(buyer)) ?? buyer,
      "Bill No.": s(l.Bill_No),
      "Bill Dt.": s(l.Bill_Dt),
      "Remarks": s(l.Remarks),
      "Quantity": s(l.Quantity),
      "BP": s(l.SP), // header the processor reads as price; the value is SP
    };
  });
  if (!rows.length) throw new Error("oracle_bill_lines returned no rows.");

  salesCache = { rows, fetchedAt: Date.now() };
  return { ...salesCache, fromCache: false };
}

async function readReturns(): Promise<SheetRow[]> {
  const [lines, aliases] = await Promise.all([
    readAll<GrLine>(
      "oracle_gr_report",
      "Item_Description,Design,Buyer_Name,Bill_No,Bill_Dt,Quantity,Rate",
      "id",
    ),
    loadAliases(),
  ]);
  return lines.map((l) => {
    const buyer = s(l.Buyer_Name);
    return {
      "Item Description": s(l.Item_Description),
      "Design": s(l.Design),
      "Buyer Name": aliases.get(aliasKey(buyer)) ?? buyer,
      "Bill No.": s(l.Bill_No),
      "Bill Dt.": s(l.Bill_Dt),
      "Quantity": s(l.Quantity),
      "Rate": s(l.Rate),
    };
  });
}

/** Goods Returns. Never throws: a returns problem must not take sales down. A
 *  read that is empty or far smaller than the last good one is the table being
 *  reloaded, so the previous figures stay on screen. */
export async function fetchOracleReturns(force = false): Promise<{ rows: SheetRow[]; fetchedAt: number; fromCache: boolean }> {
  if (!force && returnsCache && fresh(returnsCache)) return { ...returnsCache, fromCache: true };

  const floor = Math.max(MIN_PLAUSIBLE_RETURNS, lastGoodReturns ? lastGoodReturns.rows.length * 0.5 : 0);
  try {
    let rows = await readReturns();
    if (rows.length < floor) {
      // Mid-reload: give the loader a moment, then look once more.
      await new Promise((r) => setTimeout(r, 2000));
      rows = await readReturns();
    }
    if (rows.length < floor) {
      console.error(`Goods Return table looks mid-reload (${rows.length} rows, expected ≥ ${Math.round(floor)}); keeping previous figures.`);
      const keep = lastGoodReturns ?? { rows, fetchedAt: Date.now() };
      return { ...keep, fromCache: true };
    }
    returnsCache = lastGoodReturns = { rows, fetchedAt: Date.now() };
    return { ...returnsCache, fromCache: false };
  } catch (err) {
    console.error("Goods Return read failed:", err instanceof Error ? err.message : err);
    const keep = lastGoodReturns ?? { rows: [], fetchedAt: Date.now() };
    return { ...keep, fromCache: true };
  }
}

// ── Pre-ledger history (DASH sheet) ─────────────────────────────────────────

/** The DASH tab, with names folded. ~80k rows and ~15 s to read cold, and it
 *  never changes, so it is kept for an hour (a stale copy is also what is used
 *  if a later read fails — better than dropping five years of figures). */
let history: { rows: SheetRow[]; at: number } | null = null;
const HISTORY_TTL_MS = 60 * 60 * 1000;

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

async function readHistory(range: string, force: boolean): Promise<SheetRow[]> {
  if (!force && history && Date.now() - history.at < HISTORY_TTL_MS) return history.rows;
  try {
    const [{ rows }, aliases] = await Promise.all([
      fetchRange(process.env.GOOGLE_SHEET_ID as string, range, force),
      loadAliases(),
    ]);
    const out = rows.map((r) => {
      const buyer = s(r["Buyer Name"]);
      return { ...r, "Buyer Name": aliases.get(aliasKey(buyer)) ?? buyer };
    });
    history = { rows: out, at: Date.now() };
    return out;
  } catch (err) {
    console.error("History (DASH) read failed:", err instanceof Error ? err.message : err);
    return history?.rows ?? [];
  }
}

/** DASH rows dated strictly before the ledger's earliest bill. Takes the ledger
 *  as a promise so the (slow) sheet read can start at the same time as it.
 *  Never throws. */
export async function fetchOracleHistory(ledger: Promise<SheetRow[]>, force = false): Promise<SheetRow[]> {
  const range = (process.env.GOOGLE_HISTORY_RANGE ?? "DASH").trim();
  if (!range || range.toLowerCase() === "off" || !process.env.GOOGLE_SHEET_ID) return [];

  const [rows, ledgerRows] = await Promise.all([readHistory(range, force), ledger]);
  let firstDay = "";
  for (const r of ledgerRows) {
    const d = parseDate(r["Bill Dt."]);
    if (d && (!firstDay || dayKey(d) < firstDay)) firstDay = dayKey(d);
  }
  if (!firstDay) return [];
  return rows.filter((r) => {
    const d = parseDate(r["Bill Dt."]);
    return !!d && dayKey(d) < firstDay; // undated rows can't be placed — skipped
  });
}
