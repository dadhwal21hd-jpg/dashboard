/**
 * Stock on hand: style number → units available.
 *
 * Reads the `stock_available` table in Supabase through PostgREST (the same
 * HTTP API the supabase-js client uses — no extra dependency for one read).
 *
 * The table holds **R-Studio only** (verified Sep 2026: all 1,071 rows carry
 * brand `R_STUDIO`, one row per style, no duplicates), so a style with no row
 * here means "no stock figure known", never "zero in stock". The client keeps
 * that distinction: a missing style renders as "—", not 0.
 *
 * Optional feature, exactly like design thumbnails: with PROJECT_URL / ANON_KEY
 * unset — or the table unreadable — this returns {} and the dashboard renders
 * as before. A stock outage must never take the dashboard down.
 *
 * Env vars:
 *   PROJECT_URL   https://<ref>.supabase.co
 *   ANON_KEY      publishable/anon key (read-only; stays server-side)
 */
import { unstable_cache } from "next/cache";

/** style number (trimmed) → units available */
export type StockMap = Record<string, number>;

const TABLE = "stock_available";
const PAGE = 1000;
const REVALIDATE_SECONDS = 5 * 60; // stock moves with dispatch; same window as the sheet cache
const CACHE_TAG = "stock-map";

export function stockConfigured(): boolean {
  return !!(process.env.PROJECT_URL && process.env.ANON_KEY);
}

interface StockRow {
  style: string | number | null;
  brand: string | null;
  available: number | string | null;
}

/** Throws on failure — the caller catches. Never cache a transient error. */
async function computeStockMap(): Promise<StockMap> {
  const base = (process.env.PROJECT_URL || "").replace(/\/+$/, "");
  const key = process.env.ANON_KEY || "";
  const out: StockMap = {};

  for (let offset = 0; ; offset += PAGE) {
    const url = `${base}/rest/v1/${TABLE}?select=style,brand,available&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`stock fetch failed: ${res.status} ${await res.text()}`);

    const rows = (await res.json()) as StockRow[];
    for (const r of rows) {
      const sn = String(r.style ?? "").trim();
      if (!sn) continue;
      const qty = Number(r.available);
      if (!Number.isFinite(qty)) continue;
      // One row per style in practice; sum anyway rather than let a future
      // duplicate silently drop units.
      out[sn] = (out[sn] ?? 0) + qty;
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

const cachedStockMap = unstable_cache(computeStockMap, ["stock-map-v1"], {
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
