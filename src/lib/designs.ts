/**
 * Design-folder mapping: style number → Google Drive folder.
 *
 * Reads a separate spreadsheet whose rows pair a style number with a Drive
 * folder (either a full folder URL or a bare folder ID). The mapping is
 * optional — if the env vars are absent the dashboard renders exactly as
 * before, just without thumbnails.
 *
 * Env vars:
 *   GOOGLE_DESIGNS_SHEET_ID      spreadsheet ID of the mapping sheet
 *   GOOGLE_DESIGNS_RANGE         optional, defaults to "Sheet1"
 *
 * The mapping spreadsheet must also be shared with the service account.
 *
 * Headers are matched fuzzily (same philosophy as processor.ts NEEDED) so the
 * sheet doesn't have to be renamed to suit us.
 */
import { google } from "googleapis";
import { buildAuth, SCOPE_SHEETS } from "./google";

/** style number (trimmed) → Drive folder ID */
export type DesignMap = Record<string, string>;

const CACHE_TTL_MS = 10 * 60 * 1000; // designs change far less often than orders
let cache: { map: DesignMap; fetchedAt: number } | null = null;

const STYLE_ALIASES = [
  "style number", "style_number", "style no", "style no.", "style", "sn",
];
const LINK_ALIASES = [
  "drive folder link", "folder link", "drive link", "folder", "drive folder",
  "link", "url", "drive", "folder id", "folder_id", "design", "designs",
  "design link", "image link", "photo", "photos",
];

function pickColumn(headers: string[], aliases: string[]): number {
  const norm = headers.map((h) => h.toLowerCase().trim());
  // Exact alias match first, then substring — avoids "style" swallowing
  // "style number" when both columns exist.
  for (const a of aliases) {
    const i = norm.indexOf(a);
    if (i !== -1) return i;
  }
  for (const a of aliases) {
    const i = norm.findIndex((h) => h.includes(a));
    if (i !== -1) return i;
  }
  return -1;
}

/**
 * Pull a Drive folder ID out of whatever the sheet holds.
 * Accepts:
 *   https://drive.google.com/drive/folders/<id>?usp=sharing
 *   https://drive.google.com/open?id=<id>
 *   https://drive.google.com/drive/u/0/folders/<id>
 *   <id>            (bare, 20+ chars of Drive's id alphabet)
 * Returns "" when nothing usable is present.
 */
export function extractFolderId(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";

  const byPath = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  if (byPath) return byPath[1];

  const byQuery = s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (byQuery) return byQuery[1];

  // A bare ID: no slashes, no spaces, long enough to not be a style number.
  if (/^[A-Za-z0-9_-]{15,}$/.test(s)) return s;

  return "";
}

/** True when the mapping sheet is configured at all. */
export function designsConfigured(): boolean {
  return !!process.env.GOOGLE_DESIGNS_SHEET_ID;
}

/**
 * Fetch the style → folder-ID map. Returns {} (never throws) when unconfigured
 * or when the sheet can't be read — thumbnails are a nice-to-have and must not
 * take the whole dashboard down.
 */
export async function fetchDesignMap(force = false): Promise<DesignMap> {
  if (!designsConfigured()) return {};
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.map;

  try {
    const auth = buildAuth([SCOPE_SHEETS]);
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_DESIGNS_SHEET_ID!,
      range: process.env.GOOGLE_DESIGNS_RANGE || "Sheet1",
      valueRenderOption: "FORMATTED_VALUE",
    });

    const values = res.data.values;
    if (!values || values.length < 2) {
      cache = { map: {}, fetchedAt: Date.now() };
      return {};
    }

    const headers = (values[0] as unknown[]).map((h) => String(h ?? "").trim());
    let styleCol = pickColumn(headers, STYLE_ALIASES);
    let linkCol = pickColumn(headers, LINK_ALIASES);

    // Header row missing or unrecognised: fall back to "first column is the
    // style, first column that looks like a Drive link is the folder".
    if (styleCol === -1 || linkCol === -1 || styleCol === linkCol) {
      styleCol = 0;
      linkCol = -1;
      const probe = values[1] as unknown[];
      for (let j = 1; j < (probe?.length ?? 0); j++) {
        if (extractFolderId(String(probe[j] ?? ""))) { linkCol = j; break; }
      }
      if (linkCol === -1) {
        cache = { map: {}, fetchedAt: Date.now() };
        return {};
      }
    }

    const map: DesignMap = {};
    for (let i = 1; i < values.length; i++) {
      const cells = values[i] as unknown[];
      const style = String(cells?.[styleCol] ?? "").trim();
      const folder = extractFolderId(String(cells?.[linkCol] ?? ""));
      if (style && folder) map[style] = folder;
    }

    cache = { map, fetchedAt: Date.now() };
    return map;
  } catch (err) {
    console.error("Design map fetch failed:", err instanceof Error ? err.message : err);
    // Cache the empty result briefly so a broken sheet doesn't hammer the API
    // on every dashboard load.
    cache = { map: {}, fetchedAt: Date.now() };
    return {};
  }
}

export function clearDesignCache(): void {
  cache = null;
}
