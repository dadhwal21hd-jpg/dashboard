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

    // ── Load template and inject ──────────────────────────────────────────
    const templatePath = path.join(process.cwd(), "public", "dashboard_template.html");
    const template = await readFile(templatePath, "utf-8");

    const meta = {
      ...data,
      _fetched_at: new Date(fetchedAt).toISOString(),
      _from_cache: fromCache,
      _user: session.user.email,
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
