/**
 * GET /api/design — design images for a style number.
 *
 * Two modes:
 *   ?style=1234&list=1&t=TOKEN   → JSON: { style, count, files:[{id,name}] }
 *   ?style=1234&t=TOKEN          → image bytes for the first image in the folder
 *   ?file=FILEID&t=TOKEN         → image bytes for one specific file
 *
 * Optional: &sz=w400 (Drive thumbnail size; w1200 for the lightbox view).
 *
 * Auth: signed token, not the session cookie — see src/lib/signing.ts for why
 * (the dashboard iframe has an opaque origin, so cookies aren't sent). A
 * logged-in session is accepted too, for opening these URLs directly.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { verifyDesignToken } from "@/lib/signing";
import { fetchDesignMap } from "@/lib/designs";
import { listFolderImages, fetchImageBytes } from "@/lib/drive";

export const dynamic = "force-dynamic";

/** Drive IDs and our size spec — reject anything else before it reaches Drive. */
const ID_RE = /^[A-Za-z0-9_-]{10,}$/;
const SZ_RE = /^[whs]\d{2,4}$/;

async function authorised(req: NextRequest): Promise<boolean> {
  if (verifyDesignToken(req.nextUrl.searchParams.get("t"))) return true;
  const session = await getServerSession(authOptions);
  return !!session?.user?.email;
}

function imageResponse(buf: Buffer, type: string) {
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": type,
      // Private: it's a signed URL, so only the browser that has it may cache.
      "Cache-Control": "private, max-age=86400",
    },
  });
}

export async function GET(req: NextRequest) {
  if (!(await authorised(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const p = req.nextUrl.searchParams;
  const size = SZ_RE.test(p.get("sz") ?? "") ? p.get("sz")! : "w400";

  // ── Direct file fetch ────────────────────────────────────────────────────
  const fileId = p.get("file");
  if (fileId) {
    if (!ID_RE.test(fileId)) {
      return NextResponse.json({ error: "Bad file id" }, { status: 400 });
    }
    const img = await fetchImageBytes(fileId, size);
    if (!img) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return imageResponse(img.buf, img.type);
  }

  // ── Style lookup ─────────────────────────────────────────────────────────
  const style = (p.get("style") ?? "").trim();
  if (!style) {
    return NextResponse.json({ error: "style or file is required" }, { status: 400 });
  }

  const map = await fetchDesignMap();
  const folderId = map[style];
  if (!folderId) {
    return NextResponse.json({ error: "No design folder for this style" }, { status: 404 });
  }

  const files = await listFolderImages(folderId);

  if (p.get("list") === "1") {
    return NextResponse.json(
      {
        style,
        count: files.length,
        files: files.map((f) => ({ id: f.id, name: f.name })),
      },
      { headers: { "Cache-Control": "private, max-age=600" } },
    );
  }

  if (!files.length) {
    return NextResponse.json({ error: "Folder has no images" }, { status: 404 });
  }

  const img = await fetchImageBytes(files[0].id, size);
  if (!img) return NextResponse.json({ error: "Image unavailable" }, { status: 404 });
  return imageResponse(img.buf, img.type);
}
