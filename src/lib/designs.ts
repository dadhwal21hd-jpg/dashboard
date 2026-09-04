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
import { unstable_cache, revalidateTag } from "next/cache";
import { buildDesignsAuth, SCOPE_SHEETS } from "./google";

export type DesignRef = { t: "file" | "folder"; id: string };
/** style number (trimmed) → the Drive image for it */
export type DesignMap = Record<string, DesignRef>;

const REVALIDATE_SECONDS = 10 * 60; // designs change far less often than orders
const CACHE_TAG = "design-map";

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
 * Read one catalogue into a map. Returns {} rather than throwing, so one bad
 * source can't take out the others.
 */
async function readOneCatalogue(sheetId: string, range: string, label: string): Promise<DesignMap> {
  try {
    const sheets = google.sheets({ version: "v4", auth: buildDesignsAuth([SCOPE_SHEETS]) });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: extractSheetId(sheetId),
      range: quoteRange(range),
      valueRenderOption: "FORMATTED_VALUE",
    });

    const rows = (res.data.values ?? []) as string[][];
    if (rows.length < 2) {
      console.error(`Design map ${label}: sheet is empty`);
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
      console.error(`Design map ${label}: no column contains Drive links`);
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
      console.error(`Design map ${label}: could not identify a style column`);
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
      `Design map ${label}: ${Object.keys(map).length} styles from "${headers[styleCol]}" → "${headers[linkCol]}"`,
    );
    return map;
  } catch (err) {
    console.error(`Design map ${label} failed:`, err instanceof Error ? err.message : err);
    return {};
  }
}

/**
 * Read every configured catalogue and merge them, first source wins.
 * The expensive part — this function's body — is wrapped in a shared,
 * cross-instance cache below; nothing here should be called directly.
 */
async function computeDesignMap(): Promise<DesignMap> {
  const ids = (process.env.GOOGLE_DESIGNS_SHEET_ID ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const ranges = (process.env.GOOGLE_DESIGNS_RANGE ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const results = await Promise.all(
    ids.map((id, i) => readOneCatalogue(
      id,
      // One range ⇒ it applies to every sheet; otherwise match positionally.
      ranges.length === 1 ? ranges[0] : (ranges[i] || "Sheet1"),
      ids.length > 1 ? `#${i + 1}` : "",
    )),
  );

  // Merge, first source wins.
  const map: DesignMap = {};
  let added = 0;
  for (const part of results) {
    for (const [style, ref] of Object.entries(part)) {
      if (!map[style]) { map[style] = ref; added++; }
    }
  }
  if (ids.length > 1) {
    console.log(`Design map: ${added} styles merged from ${ids.length} catalogues`);
  }
  return map;
}

/**
 * Cached via Next's Data Cache (unstable_cache), not a plain module variable.
 *
 * Why this matters: a module-level cache is per lambda instance. Under a
 * burst of concurrent requests, Vercel scales up many instances at once, and
 * EVERY cold one used to redo both Sheets reads from scratch — a real
 * scalability bug, not just a cold-start nuisance: it meant traffic growth
 * multiplied load on Google's API rather than being absorbed by a cache. The
 * Data Cache is shared across instances (and regions), so the expensive read
 * happens roughly once per revalidate window, cluster-wide, however many
 * instances are running.
 */
const cachedComputeDesignMap = unstable_cache(computeDesignMap, [CACHE_TAG], {
  revalidate: REVALIDATE_SECONDS,
  tags: [CACHE_TAG],
});

/**
 * Fetch the merged style → image map across every configured catalogue.
 *
 * Several catalogues are supported because the business keeps one per branch —
 * `GOOGLE_DESIGNS_SHEET_ID` takes a comma-separated list, and
 * `GOOGLE_DESIGNS_RANGE` either one tab name for all of them or a matching
 * comma-separated list. Earlier sources win on conflict, so put the most
 * trusted catalogue first.
 *
 * Never throws: thumbnails are a nice-to-have and must not be able to take the
 * dashboard down.
 */
export async function fetchDesignMap(force = false): Promise<DesignMap> {
  if (!designsConfigured()) return {};
  // Next 16's revalidateTag takes a profile; {expire: 0} means "stale now".
  if (force) revalidateTag(CACHE_TAG, { expire: 0 });
  return cachedComputeDesignMap();
}

export function clearDesignCache(): void {
  revalidateTag(CACHE_TAG, { expire: 0 });
}
