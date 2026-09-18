/**
 * GET /api/dashboard
 *
 * Protected endpoint. Fetches rows from Google Sheet (with 5-min cache),
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
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchSheetRows, fetchReturnsRows } from "@/lib/sheets";
import { process as runProcessor } from "@/lib/processor";
import { fetchDesignMap, designsConfigured } from "@/lib/designs";
import { getStableDesignToken } from "@/lib/signing";
import { clearDriveCache } from "@/lib/drive";
import { fetchStockMap } from "@/lib/stock";

export const dynamic = "force-dynamic"; // never statically cache this route

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
    const [{ rows, fetchedAt, fromCache }, { rows: returnRows }] = await Promise.all([
      fetchSheetRows(force),
      fetchReturnsRows(force),
    ]);
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

    return new NextResponse(injected, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
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