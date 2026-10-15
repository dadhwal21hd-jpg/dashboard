/**
 * GET /api/dashboard
 *
 * Protected endpoint. Fetches sales + Goods Return rows from Supabase
 * (oracle_bill_lines / oracle_gr_report, 5-min cache; the Google Sheet tabs
 * are only the fallback when PROJECT_URL / ANON_KEY are not set),
 * runs the analytics processor, and returns the dashboard HTML with the
 * DATA constant injected at the /*__DATA__*\/ placeholder.
 *
 * Query params:
 *   ?refresh=1        forces a fresh fetch of orders/returns/design-map,
 *                     bypassing their caches.
 *   ?refreshImages=1  ALSO force-clears the cached design *photos*
 *                     (src/lib/drive.ts) — deliberately separate from
 *                     ?refresh=1: those photos are cached indefinitely (see
 *                     drive.ts's CACHE_FOREVER) because a design photo
 *                     essentially never changes in place, so a routine data
 *                     refresh must not silently nuke that cache and force
 *                     everyone to re-download every photo. Use this one only
 *                     when a specific photo actually was replaced on Drive
 *                     and needs to show up sooner than "next full sync
 *                     picks up the new file ID" would otherwise handle.
 *
 * Response: text/html (the dashboard, ready to render).
 *
 * Errors return application/json with { error: string } so the frontend
 * can show a clean message instead of a broken dashboard.
 */
import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as zlibConstants } from "node:zlib";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchSheetRows, fetchReturnsRows } from "@/lib/sheets";
import { fetchOracleSales, fetchOracleReturns, oracleConfigured } from "@/lib/oracle";
import { process as runProcessor } from "@/lib/processor";
import { fetchDesignMap, designsConfigured } from "@/lib/designs";
import { getStableDesignToken } from "@/lib/signing";
import { clearDriveCache } from "@/lib/drive";
import { fetchStockMap } from "@/lib/stock";

export const dynamic = "force-dynamic"; // never statically cache this route

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/**
 * The page is ~3.6 MB (DATA carries every order row) but compresses to
 * ~265 KB. Next compresses its pages, not route-handler responses — measured
 * on `next start`: 3.67 MB on the wire, no Content-Encoding — so it's done
 * here rather than left to whatever the host does. ~18 ms of CPU, off the
 * event loop; on a phone on mobile data it saves seconds per load.
 */
async function encodeFor(req: NextRequest, body: string): Promise<{ data: Uint8Array<ArrayBuffer> | string; encoding?: string }> {
  const accept = req.headers.get("accept-encoding") ?? "";
  const buf = Buffer.from(body);
  if (/\bbr\b/.test(accept)) {
    const data = await brotli(buf, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    });
    return { data: new Uint8Array(data), encoding: "br" };
  }
  if (/\bgzip\b/.test(accept)) return { data: new Uint8Array(await gz(buf, { level: 6 })), encoding: "gzip" };
  return { data: body };
}

export async function GET(req: NextRequest) {
  // ── Auth gate ────────────────────────────────────────────────────────────
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const force = req.nextUrl.searchParams.get("refresh") === "1";
  if (req.nextUrl.searchParams.get("refreshImages") === "1") {
    clearDriveCache();
  }

  try {
    // ── Fetch + process ───────────────────────────────────────────────────
    // Supabase is the system of record now. If it is configured but fails, that
    // is an error to show — NOT a silent drop back to the (stale) sheet.
    const useOracle = oracleConfigured();
    const [{ rows, fetchedAt, fromCache }, { rows: returnRows }] = await Promise.all(
      useOracle
        ? [fetchOracleSales(force), fetchOracleReturns(force)]
        : [fetchSheetRows(force), fetchReturnsRows(force)],
    );
    const data = runProcessor(rows, returnRows);

    // Design thumbnails (optional feature — absent env vars ⇒ empty map).
    // Only the *style numbers that have an image and actually appear in the
    // orders* are sent: the client needs presence, not Drive IDs (the image
    // route resolves those server-side), and the catalogue is much larger
    // than the order book.
    // Stock on hand (optional, R-Studio only — see src/lib/stock.ts). Only
    // styles that actually appear in the orders are sent: the stock table is
    // bigger than what's been sold, and the dashboard only ever shows stock
    // next to a style it is already listing.
    //
    // Fetched *alongside* the design map, not after it: they're independent
    // reads of two different services, and a cold instance pays both round
    // trips in full, so running them in series showed up as a slower page.
    const [designMap, stockMap] = await Promise.all([
      fetchDesignMap(force),
      fetchStockMap(force),
    ]);
    const ordered = new Set(data.raw.map((r) => r.sn));
    const designStyles = Object.keys(designMap).filter((sn) => ordered.has(sn));
    const stock: Record<string, number> = {};
    for (const [sn, qty] of Object.entries(stockMap)) {
      if (ordered.has(sn)) stock[sn] = qty;
    }

    // The template lives in a blob-URL iframe (opaque origin), so it can't use
    // relative URLs or send our cookie. Give it an absolute base + a signed
    // token instead. See src/lib/signing.ts.
    const origin = req.nextUrl.origin;

    // ── Load template and inject ──────────────────────────────────────────
    const templatePath = path.join(process.cwd(), "public", "dashboard_template.html");
    const template = await readFile(templatePath, "utf-8");

    const meta = {
      ...data,
      _fetched_at: new Date(fetchedAt).toISOString(),
      _from_cache: fromCache,
      _user: session.user.email,
      // Lock codes — injected into client-side DATA for the sci-fi lock UI.
      // NOTE: This is a VISUAL lock only. The data itself is on the client.
      // A technical user opening dev tools could read these codes.
      _master_code:   process.env.MASTER_UNLOCK_CODE   || "",
      _customer_code: process.env.CUSTOMER_UNLOCK_CODE || "",
      // Design thumbnails: which styles have an image, plus how to reach the
      // image route from inside the opaque-origin iframe.
      _designs:       designStyles,
      _design_base:   designsConfigured() ? `${origin}/api/design` : "",
      _design_token:  designsConfigured() ? await getStableDesignToken(session.user.email) : "",
      // Units available per style (R-Studio only; {} when not configured).
      _stock:         stock,
    };

    const injected = template.replace(
      "/*__DATA__*/",
      `const DATA = ${JSON.stringify(meta)};`,
    );

    const { data: payload, encoding } = await encodeFor(req, injected);
    return new NextResponse(payload, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        Vary: "Accept-Encoding",
        ...(encoding ? { "Content-Encoding": encoding } : {}),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Dashboard fetch failed:", message);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}