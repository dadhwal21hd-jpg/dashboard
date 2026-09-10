/**
 * Google Sheets fetcher.
 *
 * Uses a service account (no per-user OAuth). The service account email
 * must be granted Viewer access on the target sheet.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL    e.g. kk-dashboard@my-project.iam.gserviceaccount.com
 *   GOOGLE_SERVICE_ACCOUNT_KEY      the private key from the JSON keyfile
 *                                   (newlines may be encoded as \n; we decode below)
 *   GOOGLE_SHEET_ID                 the long ID in the sheet's URL
 *   GOOGLE_SHEET_RANGE              optional. Defaults to "Sheet1" (the whole sheet).
 *                                   Use a range like "Data!A1:F" to be explicit.
 *   GOOGLE_RETURNS_RANGE            optional. Tab name for Goods Return rows, same
 *                                   spreadsheet as GOOGLE_SHEET_ID. Unset = no returns
 *                                   data (dashboard renders exactly as before).
 */
import { google } from "googleapis";
import type { SheetRow } from "./types";
import { buildAuth, getEnv, SCOPE_SHEETS } from "./google";

interface CacheEntry {
  data: SheetRow[];
  fetchedAt: number;
}

/** Keyed by `${sheetId}::${range}` — sales and returns are different tabs
 *  fetched independently, so they need separate cache entries. */
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Wraps a tab name in single quotes for A1 notation when it needs it
 *  (spaces, etc.) — most tab names here don't, but future ones might. */
function quoteRange(range: string): string {
  const r = range.trim();
  if (!r || r.includes("!") || r.startsWith("'")) return r;
  return /\s/.test(r) ? `'${r.replace(/'/g, "''")}'` : r;
}

async function fetchRange(
  sheetId: string,
  range: string,
  force: boolean,
): Promise<{ rows: SheetRow[]; fetchedAt: number; fromCache: boolean }> {
  const cacheKey = `${sheetId}::${range}`;
  const hit = cache.get(cacheKey);
  if (!force && hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return { rows: hit.data, fetchedAt: hit.fetchedAt, fromCache: true };
  }

  const auth = buildAuth([SCOPE_SHEETS]);
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: quoteRange(range),
    // valueRenderOption: 'UNFORMATTED_VALUE' returns numbers as numbers, dates as serial — we want strings
    valueRenderOption: "FORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });

  const values = res.data.values;
  if (!values || values.length === 0) {
    throw new Error(`Sheet range "${range}" is empty or returned no values.`);
  }
  if (values.length === 1) {
    throw new Error(`Sheet range "${range}" contains only a header row.`);
  }

  // First row is headers; remaining rows are data.
  const headers = (values[0] as unknown[]).map((h) => String(h ?? "").trim());
  const rows: SheetRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const cells = values[i] as unknown[];
    const row: SheetRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = String(cells?.[j] ?? "").trim();
    }
    rows.push(row);
  }

  const fetchedAt = Date.now();
  cache.set(cacheKey, { data: rows, fetchedAt });
  return { rows, fetchedAt, fromCache: false };
}

/**
 * Fetch rows from the configured Google Sheet (the sales/dispatch tab).
 * @param force If true, bypass the 5-minute cache.
 */
export async function fetchSheetRows(force = false): Promise<{ rows: SheetRow[]; fetchedAt: number; fromCache: boolean }> {
  const sheetId = getEnv("GOOGLE_SHEET_ID");
  const range = process.env.GOOGLE_SHEET_RANGE || "Sheet1";
  return fetchRange(sheetId, range, force);
}

/**
 * Fetch Goods Return rows from the same spreadsheet's returns tab.
 * Optional: returns an empty list (not an error) when GOOGLE_RETURNS_RANGE
 * isn't set, or when the read fails — a broken/missing returns tab must not
 * take the sales dashboard down, same philosophy as the design thumbnails.
 */
export async function fetchReturnsRows(force = false): Promise<{ rows: SheetRow[]; fetchedAt: number; fromCache: boolean }> {
  const range = process.env.GOOGLE_RETURNS_RANGE;
  if (!range) return { rows: [], fetchedAt: Date.now(), fromCache: false };

  try {
    const sheetId = getEnv("GOOGLE_SHEET_ID"); // same spreadsheet as sales
    return await fetchRange(sheetId, range, force);
  } catch (err) {
    console.error("Goods Return fetch failed:", err instanceof Error ? err.message : err);
    return { rows: [], fetchedAt: Date.now(), fromCache: false };
  }
}

/** Manually clear the cache (useful for tests / admin actions). */
export function clearSheetCache(): void {
  cache.clear();
}
