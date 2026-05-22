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
 */
import { google } from "googleapis";
import type { SheetRow } from "./types";

interface CacheEntry {
  data: SheetRow[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getEnv(name: string, required = true): string {
  const v = process.env[name];
  if (!v && required) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v ?? "";
}

function buildAuth() {
  const email = getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  // Vercel env vars can't contain real newlines; we accept either:
  //  - JSON-escaped newlines (literal \n) — recommended
  //  - real newlines (if you paste from a file)
  const rawKey = getEnv("GOOGLE_SERVICE_ACCOUNT_KEY");
  const privateKey = rawKey.replace(/\\n/g, "\n");

  return new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

/**
 * Fetch rows from the configured Google Sheet.
 * @param force If true, bypass the 5-minute cache.
 */
export async function fetchSheetRows(force = false): Promise<{ rows: SheetRow[]; fetchedAt: number; fromCache: boolean }> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { rows: cache.data, fetchedAt: cache.fetchedAt, fromCache: true };
  }

  const sheetId = getEnv("GOOGLE_SHEET_ID");
  const range = process.env.GOOGLE_SHEET_RANGE || "Sheet1";

  const auth = buildAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
    // valueRenderOption: 'UNFORMATTED_VALUE' returns numbers as numbers, dates as serial — we want strings
    valueRenderOption: "FORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });

  const values = res.data.values;
  if (!values || values.length === 0) {
    throw new Error("Sheet is empty or range returned no values.");
  }
  if (values.length === 1) {
    throw new Error("Sheet contains only a header row.");
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

  cache = { data: rows, fetchedAt: Date.now() };
  return { rows, fetchedAt: cache.fetchedAt, fromCache: false };
}

/** Manually clear the cache (useful for tests / admin actions). */
export function clearSheetCache(): void {
  cache = null;
}
