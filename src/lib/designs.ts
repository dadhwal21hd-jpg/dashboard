/**
 * Design images: style number → Google Drive image.
 *
 * Reads a product-catalogue spreadsheet that pairs a style code with a Drive
 * link. Both link shapes are supported:
 *   file   — https://drive.google.com/file/d/<id>/view   (one image, the common case)
 *   folder — https://drive.google.com/drive/folders/<id> (listed, may hold several)
 *
 * Optional feature: with GOOGLE_DESIGNS_SHEET_ID unset — or the sheet
 * unreadable — this returns {} and the dashboard renders exactly as before.
 *
 * Env vars:
 *   GOOGLE_DESIGNS_SHEET_ID                  spreadsheet ID (a full URL is also accepted)
 *   GOOGLE_DESIGNS_RANGE                     optional tab name, defaults to "Sheet1"
 *   GOOGLE_DESIGNS_SERVICE_ACCOUNT_EMAIL     optional; falls back to the main service account
 *   GOOGLE_DESIGNS_SERVICE_ACCOUNT_KEY       optional; falls back to the main service account
 *
 * Column detection is deliberately evidence-based rather than header-only: the
 * real catalogue has both an "Image" column (full of links) and an empty
 * "Photo" column, so a column is only accepted once its values actually look
 * like Drive links.
 */
import { google } from "googleapis";
import { buildDesignsAuth, SCOPE_SHEETS } from "./google";

export type DesignRef = { t: "file" | "folder"; id: string };
/** style number (trimmed) → the Drive image for it */
export type DesignMap = Record<string, DesignRef>;

const CACHE_TTL_MS = 10 * 60 * 1000; // designs change far less often than orders
let cache: { map: DesignMap; fetchedAt: number } | null = null;

const STYLE_ALIASES = [
  "style number", "style_number", "style no", "style no.", "item code",
  "item_code", "style code", "style", "sku", "code",
];
const LINK_ALIASES = [
  "image", "image link", "design", "designs", "design link", "photo link",
  "drive folder link", "folder link", "drive link", "folder", "drive folder",
  "link", "url", "drive", "photo", "photos",
];

const FILE_RE = /\/file\/d\/([A-Za-z0-9_-]{10,})/;
const FOLDER_RE = /\/folders\/([A-Za-z0-9_-]{10,})/;
const OPEN_RE = /[?&]id=([A-Za-z0-9_-]{10,})/;

/**
 * Read a Drive reference out of a cell. Returns null when there isn't one.
 * A bare ID is treated as a folder, matching how people paste folder IDs.
 */
export function parseDriveRef(raw: string): DesignRef | null {
  const s = (raw || "").trim();
  if (!s) return null;

  const file = s.match(FILE_RE);
  if (file) return { t: "file", id: file[1] };

  const folder = s.match(FOLDER_RE);
  if (folder) return { t: "folder", id: folder[1] };

  const open = s.match(OPEN_RE);
  if (open) return { t: "file", id: open[1] };

  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return { t: "folder", id: s };

  return null;
}

/** Accepts a spreadsheet ID or a full docs.google.com URL. */
export function extractSheetId(raw: string): string {
  const s = (raw || "").trim();
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : s;
}

/** A1 notation needs quoting when the tab name contains spaces. */
function quoteRange(range: string): string {
  const r = range.trim();
  if (!r || r.includes("!") || r.startsWith("'")) return r;
  return /\s/.test(r) ? `'${r.replace(/'/g, "''")}'` : r;
}

/** How many of the sampled cells in this column hold a Drive reference. */
function linkScore(rows: string[][], col: number, sample = 40): number {
  let n = 0;
  for (let i = 1; i < Math.min(rows.length, sample + 1); i++) {
    if (parseDriveRef(String(rows[i]?.[col] ?? ""))) n++;
  }
  return n;
}

function pickByHeader(headers: string[], aliases: string[]): number {
  const norm = headers.map((h) => h.toLowerCase().trim());
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

export function designsConfigured(): boolean {
  return !!process.env.GOOGLE_DESIGNS_SHEET_ID;
}

/**
 * Fetch the style → image map. Never throws: thumbnails are a nice-to-have and
 * must not be able to take the dashboard down.
 */
export async function fetchDesignMap(force = false): Promise<DesignMap> {
  if (!designsConfigured()) return {};
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.map;

  try {
    const sheets = google.sheets({ version: "v4", auth: buildDesignsAuth([SCOPE_SHEETS]) });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: extractSheetId(process.env.GOOGLE_DESIGNS_SHEET_ID!),
      range: quoteRange(process.env.GOOGLE_DESIGNS_RANGE || "Sheet1"),
      valueRenderOption: "FORMATTED_VALUE",
    });

    const rows = (res.data.values ?? []) as string[][];
    if (rows.length < 2) {
      cache = { map: {}, fetchedAt: Date.now() };
      return {};
    }

    const headers = rows[0].map((h) => String(h ?? "").trim());
    const width = Math.max(...rows.slice(0, 50).map((r) => r?.length ?? 0));

    // ── Link column: header hint, but only if the values back it up ────────
    let linkCol = pickByHeader(headers, LINK_ALIASES);
    if (linkCol === -1 || linkScore(rows, linkCol) === 0) {
      let best = -1, bestScore = 0;
      for (let c = 0; c < width; c++) {
        const s = linkScore(rows, c);
        if (s > bestScore) { bestScore = s; best = c; }
      }
      linkCol = bestScore > 0 ? best : -1;
    }
    if (linkCol === -1) {
      console.error("Design map: no column contains Drive links");
      cache = { map: {}, fetchedAt: Date.now() };
      return {};
    }

    // ── Style column: header hint, else the first non-link column that is
    //    populated and reasonably unique across the sheet ──────────────────
    let styleCol = pickByHeader(headers, STYLE_ALIASES);
    if (styleCol === -1 || styleCol === linkCol) {
      let best = -1, bestUnique = 0;
      for (let c = 0; c < width; c++) {
        if (c === linkCol) continue;
        const seen = new Set<string>();
        let filled = 0;
        for (let i = 1; i < Math.min(rows.length, 200); i++) {
          const v = String(rows[i]?.[c] ?? "").trim();
          if (v) { filled++; seen.add(v); }
        }
        if (filled > 0 && seen.size > bestUnique) { bestUnique = seen.size; best = c; }
      }
      styleCol = best;
    }
    if (styleCol === -1) {
      console.error("Design map: could not identify a style column");
      cache = { map: {}, fetchedAt: Date.now() };
      return {};
    }

    const map: DesignMap = {};
    for (let i = 1; i < rows.length; i++) {
      const style = String(rows[i]?.[styleCol] ?? "").trim();
      if (!style || map[style]) continue;   // first link per style wins
      const ref = parseDriveRef(String(rows[i]?.[linkCol] ?? ""));
      if (ref) map[style] = ref;
    }

    // The catalogue zero-pads some codes ("00513") where the orders sheet
    // doesn't ("513"). Add the unpadded form as an alias, but never overwrite
    // a code that genuinely exists in its own right.
    for (const code of Object.keys(map)) {
      if (!/^0\d+$/.test(code)) continue;
      const stripped = code.replace(/^0+/, "");
      if (stripped && !map[stripped]) map[stripped] = map[code];
    }

    console.log(
      `Design map: ${Object.keys(map).length} styles from "${headers[styleCol]}" → "${headers[linkCol]}"`,
    );
    cache = { map, fetchedAt: Date.now() };
    return map;
  } catch (err) {
    console.error("Design map fetch failed:", err instanceof Error ? err.message : err);
    // Cache the empty result briefly so a broken sheet doesn't hammer the API.
    cache = { map: {}, fetchedAt: Date.now() };
    return {};
  }
}

export function clearDesignCache(): void {
  cache = null;
}
