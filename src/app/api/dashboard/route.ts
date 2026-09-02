/**
 * GET /api/dashboard
 *
 * Protected endpoint. Fetches rows from Google Sheet (with 5-min cache),
 * runs the analytics processor, and returns the dashboard HTML with the
 * DATA constant injected at the /*__DATA__*\/ placeholder.
 *
 * Query params:
 *   ?refresh=1   forces a fresh fetch, bypassing the cache.
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
import { fetchSheetRows } from "@/lib/sheets";
import { process as runProcessor } from "@/lib/processor";
import { fetchDesignMap, designsConfigured } from "@/lib/designs";
import { mintDesignToken } from "@/lib/signing";

export const dynamic = "force-dynamic"; // never statically cache this route

export async function GET(req: NextRequest) {
  // ── Auth gate ────────────────────────────────────────────────────────────
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const force = req.nextUrl.searchParams.get("refresh") === "1";

  try {
    // ── Fetch + process ───────────────────────────────────────────────────
    const { rows, fetchedAt, fromCache } = await fetchSheetRows(force);
    const data = runProcessor(rows);

    // Design thumbnails (optional feature — absent env vars ⇒ empty map).
    // Only the *style numbers that have an image and actually appear in the
    // orders* are sent: the client needs presence, not Drive IDs (the image
    // route resolves those server-side), and the catalogue is much larger
    // than the order book.
    const designMap = await fetchDesignMap(force);
    const ordered = new Set(data.raw.map((r) => r.sn));
    const designStyles = Object.keys(designMap).filter((sn) => ordered.has(sn));

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
      _design_token:  designsConfigured() ? mintDesignToken(session.user.email) : "",
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