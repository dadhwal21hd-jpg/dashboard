import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as zlibConstants } from "node:zlib";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchSheetRows, fetchReturnsRows } from "@/lib/sheets";
import { foldPartyAliases } from "@/lib/oracle";
import { process as runProcessor } from "@/lib/processor";
import { fetchDesignMap, designsConfigured } from "@/lib/designs";
import { getStableDesignToken } from "@/lib/signing";
import { clearDriveCache } from "@/lib/drive";
import { fetchStockMap } from "@/lib/stock";

export const dynamic = "force-dynamic";
export const maxDuration = 60; 

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

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
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const force = req.nextUrl.searchParams.get("refresh") === "1";
  if (req.nextUrl.searchParams.get("refreshImages") === "1") {
    clearDriveCache();
  }

  try {
    // Sales and returns both come from the Google Sheet (owner's call, Nov 2026).
    // Buyer spellings are still merged through Supabase's party_aliases.
    const [{ rows: salesRows, fetchedAt, fromCache }, { rows: retRows }] = await Promise.all([
      fetchSheetRows(force),
      fetchReturnsRows(force),
    ]);
    const [rows, returnRows] = await Promise.all([
      foldPartyAliases(salesRows, force),
      foldPartyAliases(retRows, force),
    ]);

    const data = runProcessor(rows, returnRows, {});

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

    const origin = req.nextUrl.origin;
    const templatePath = path.join(process.cwd(), "public", "dashboard_template.html");
    const template = await readFile(templatePath, "utf-8");

    const meta = {
      ...data,
      _fetched_at: new Date(fetchedAt).toISOString(),
      _from_cache: fromCache,
      _user: session.user.email,
      _master_code:   process.env.MASTER_UNLOCK_CODE   || "",
      _customer_code: process.env.CUSTOMER_UNLOCK_CODE || "",
      _designs:       designStyles,
      _design_base:   designsConfigured() ? `${origin}/api/design` : "",
      _design_token:  designsConfigured() ? await getStableDesignToken(session.user.email) : "",
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