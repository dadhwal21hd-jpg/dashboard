/**
 * Stock on hand: style number → units available.
 *
 * Reads two Supabase tables through PostgREST (the same HTTP API the
 * supabase-js client uses — no extra dependency for a read):
 *   - `stock_available`     R-Studio  (filtered to brand = R_STUDIO)
 *   - `kk_stock_available`  KK        (its own physical count)
 *
 * The brand filter on `stock_available` is load-bearing: that view also lists
 * any KK style that has pieces *in production*, with 0 on hand because the
 * R-Studio stock board never counts KK. Taking those rows as-is showed KK
 * styles as "0 in stock" (found Oct 2026: 41 styles, 10 of which really had
 * stock in the KK table). KK stock comes only from `kk_stock_available`.
 *
 * A style with no row in either table means "no stock figure known", never
 * "zero in stock". The client keeps that distinction: missing renders as "—".
 *
 * Optional feature, exactly like design thumbnails: with PROJECT_URL / ANON_KEY
 * unset — or a table unreadable — this returns {} and the dashboard renders
 * as before. A stock outage must never take the dashboard down.
 *
 * Env vars:
 *   PROJECT_URL   https://<ref>.supabase.co
 *   ANON_KEY      publishable/anon key (read-only; stays server-side)
 */
import { unstable_cache } from "next/cache";

/** style number (trimmed) → units available */
export type StockMap = Record<string, number>;

// PostgREST enforces its own max-rows cap (1,000 on this project — asking for
// more silently returns 1,000). Paging therefore advances by the number of rows
// actually returned and stops against the exact total from Content-Range, so a
// lowered cap can't make a short page look like the end.
const PAGE = 1000;
const REVALIDATE_SECONDS = 5 * 60; // stock moves with dispatch; same window as the sheet cache
const CACHE_TAG = "stock-map";

export function stockConfigured(): boolean {
  return !!(process.env.PROJECT_URL && process.env.ANON_KEY);
}

interface StockRow {
  style: string | number | null;
  available: number | string | null;
}

/** All rows of one table (optionally narrowed by a PostgREST filter), summed
 *  into `out`. Throws on failure — the caller catches. */
async function readTable(table: string, filter: string, out: StockMap): Promise<void> {
  const base = (process.env.PROJECT_URL || "").replace(/\/+$/, "");
  const key = process.env.ANON_KEY || "";

  let total = Infinity;
  for (let offset = 0; offset < total; ) {
    // `order=style` is load-bearing: limit/offset paging over an UNORDERED
    // query is undefined in Postgres — a row can appear in two pages
    // (double-counted) or in none (silently missing).
    const url = `${base}/rest/v1/${table}?select=style,available${filter}&order=style&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`stock fetch failed (${table}): ${res.status} ${await res.text()}`);

    // Content-Range: "0-999/1026" (or "*/0" when empty)
    const n = Number((res.headers.get("content-range") || "").split("/")[1]);
    if (Number.isFinite(n)) total = n;

    const rows = (await res.json()) as StockRow[];
    if (rows.length === 0) break;
    offset += rows.length;
    // No usable total header: fall back to "until a page comes back empty".
    if (!Number.isFinite(n)) total = Infinity;

    for (const r of rows) {
      const sn = String(r.style ?? "").trim();
      if (!sn) continue;
      const qty = Number(r.available);
      if (!Number.isFinite(qty)) continue;
      // One row per style in practice; sum anyway rather than let a future
      // duplicate silently drop units.
      out[sn] = (out[sn] ?? 0) + qty;
    }
  }
}

/** Throws on failure — the caller catches. Never cache a transient error. */
async function computeStockMap(): Promise<StockMap> {
  const rstudio: StockMap = {};
  const kk: StockMap = {};
  // Independent reads of two tables — run together, not back to back.
  await Promise.all([
    readTable("stock_available", "&brand=eq.R_STUDIO", rstudio),
    readTable("kk_stock_available", "&brand=eq.KK", kk),
  ]);
  // Each table only accepts its own brand (filters above), so they should never
  // share a style. If one ever does, we can't know which count is right — so
  // that style gets NO figure (renders "—") and the clash is logged, rather
  // than one brand's number silently overwriting the other's.
  const out: StockMap = {};
  const clash: string[] = [];
  for (const [sn, q] of Object.entries(rstudio)) {
    if (sn in kk) clash.push(sn);
    else out[sn] = q;
  }
  for (const [sn, q] of Object.entries(kk)) {
    if (!(sn in rstudio)) out[sn] = q;
  }
  if (clash.length) {
    console.error(
      `Stock: ${clash.length} style(s) in BOTH R-Studio and KK tables, left blank: ${clash.slice(0, 20).join(", ")}`,
    );
  }
  return out;
}

const cachedStockMap = unstable_cache(computeStockMap, ["stock-map-v2"], {
  revalidate: REVALIDATE_SECONDS,
  tags: [CACHE_TAG],
});

/** Style → units available. Returns {} when unconfigured or unreadable. */
export async function fetchStockMap(force = false): Promise<StockMap> {
  if (!stockConfigured()) return {};
  try {
    return force ? await computeStockMap() : await cachedStockMap();
  } catch (err) {
    console.error("Stock fetch failed:", err instanceof Error ? err.message : err);
    return {};
  }
}
