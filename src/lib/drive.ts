/**
 * Google Drive reads for design thumbnails.
 *
 * The mapping sheet gives us a *folder*, so every lookup is two steps:
 * list the folder's image files, then fetch bytes for one of them. Both are
 * cached via Next's Data Cache (unstable_cache) — shared cluster-wide, not a
 * plain module variable — designs are effectively static, and Drive quota is
 * not.
 *
 * Requires the Drive API enabled on the Cloud project and the design folders
 * shared with the service account (sharing one parent cascades to children).
 */
import { google } from "googleapis";
import { unstable_cache, revalidateTag } from "next/cache";
import { buildDesignsAuth, SCOPE_DRIVE } from "./google";

export interface DriveImage {
  id: string;
  name: string;
  mimeType: string;
}

const LIST_TAG = "drive-list";
const BYTES_TAG = "drive-bytes";
/**
 * `false` = never revalidate on a timer, only via an explicit revalidateTag
 * (clearDriveCache(), wired to /api/dashboard's `?refreshImages=1` — a
 * separate, deliberately undocumented-in-UI param, NOT the routine
 * "↻ Refresh data" button. Refresh Data must not bust this cache, or every
 * routine refresh would force everyone to re-download every photo).
 * Deliberate: a design photo essentially never changes in place once
 * uploaded (a *new* photo gets a new Drive file ID, which is just a new
 * cache entry, not a stale one), so there's no real freshness window to
 * pick — the honest answer to "how long should this stay cached" is
 * "until someone says otherwise", which is what `false` means here.
 */
const CACHE_FOREVER = false;

function driveClient() {
  return google.drive({ version: "v3", auth: buildDesignsAuth([SCOPE_DRIVE]) });
}

/**
 * Image files inside a folder, name-sorted so "the first image" is stable
 * across requests. Throws on an actual API failure — never caches a
 * transient error as if it were "this folder has no images"; see the
 * comment on cachedFolderImages below for why that distinction matters with
 * a shared cache. A folder that genuinely has zero images still returns []
 * normally (that's real data, fine to cache).
 */
async function computeFolderImages(folderId: string): Promise<DriveImage[]> {
  const drive = driveClient();
  const res = await drive.files.list({
    q: `'${folderId.replace(/'/g, "\\'")}' in parents and mimeType contains 'image/' and trashed = false`,
    fields: "files(id,name,mimeType)",
    orderBy: "name_natural",
    pageSize: 50,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files ?? []).map((f) => ({
    id: f.id!,
    name: f.name ?? "",
    mimeType: f.mimeType ?? "image/jpeg",
  })).filter((f) => f.id);
}

const cachedFolderImages = unstable_cache(computeFolderImages, [LIST_TAG], {
  revalidate: CACHE_FOREVER,
  tags: [LIST_TAG],
});

/** Returns [] on any failure — a missing design must never surface as an
 *  error in the dashboard. A genuine failure (vs. a real empty folder) is
 *  never cached — see computeFolderImages. */
export async function listFolderImages(folderId: string): Promise<DriveImage[]> {
  try {
    return await cachedFolderImages(folderId);
  } catch (err) {
    console.error(`Drive list failed for folder ${folderId}:`,
      err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Try Drive's public, unauthenticated thumbnail endpoint. Every design image
 * we've sampled (40 across the full catalogue range) turned out to be shared
 * "anyone with the link" — the catalogues feed a public storefront, so this
 * is the common case, not an edge case.
 *
 * This is the entire fix for slow/bursty thumbnail loading: it skips BOTH
 * Drive API calls the authenticated path needs (a files.get for the
 * thumbnailLink, then an authenticated fetch of it), so it costs nothing
 * against our Drive API quota and isn't subject to our own serverless
 * concurrency — Google's public asset infrastructure serves it directly.
 *
 * A file that isn't public returns a non-200, non-image response here (verified:
 * a bad/inaccessible id comes back as a 4xx/5xx text/html error, never a
 * misleading placeholder image), so `null` reliably means "fall back".
 */
async function fetchPublicThumbnail(
  fileId: string,
  size: string,
): Promise<{ buf: Buffer; type: string } | null> {
  try {
    const url = `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=${encodeURIComponent(size)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null; // implausibly small for a real photo
    return { buf, type };
  } catch {
    return null;
  }
}

interface CachedImage {
  /** base64 — unstable_cache needs a JSON-serializable value, not a Buffer. */
  b64: string;
  type: string;
}

/**
 * The actual fetch, tried public-first then authenticated (see
 * fetchPublicThumbnail). THROWS when neither path produces an image — this
 * is deliberate, not a bug: the result is cached cluster-wide for
 * CACHE_FOREVER (see cachedImageBytes below), and a module-level
 * cache used to mean a transient failure only cost one lambda instance one
 * miss. A shared cache makes that failure durable and global instead unless
 * we refuse to cache it — same fix already applied to fetchDesignMap() in
 * designs.ts after that exact bug shipped once. Throwing here means
 * unstable_cache never calls its cacheNewResult, so nothing gets persisted;
 * the outer fetchImageBytes() catches this and returns null for just this
 * one request instead.
 */
async function computeImageBytes(fileId: string, size: string): Promise<CachedImage> {
  const pub = await fetchPublicThumbnail(fileId, size);
  if (pub) return { b64: pub.buf.toString("base64"), type: pub.type };

  const drive = driveClient();
  const meta = await drive.files.get({
    fileId,
    fields: "thumbnailLink,mimeType",
    supportsAllDrives: true,
  });

  const thumb = meta.data.thumbnailLink;
  if (thumb) {
    // thumbnailLink carries its own signature but still wants the bearer
    // token; the trailing =sNNN is swapped for the size we actually want.
    const url = thumb.replace(/=s\d+(-c)?$/, `=${size}`);
    const token = await buildDesignsAuth([SCOPE_DRIVE]).getAccessToken();
    const res = await fetch(url, {
      headers: token?.token ? { Authorization: `Bearer ${token.token}` } : undefined,
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get("content-type") || "image/jpeg";
      return { b64: buf.toString("base64"), type };
    }
  }

  // No thumbnail — pull the original file.
  const full = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  const buf = Buffer.from(full.data as ArrayBuffer);
  const type = meta.data.mimeType || "image/jpeg";
  return { b64: buf.toString("base64"), type };
}

const cachedImageBytes = unstable_cache(computeImageBytes, [BYTES_TAG], {
  revalidate: CACHE_FOREVER,
  tags: [BYTES_TAG],
});

/**
 * Bytes for one image, shared cluster-wide — a cold Vercel instance no
 * longer re-pays the Drive/network round trip for an image another instance
 * already fetched moments ago, which a plain per-instance Map (the previous
 * design) couldn't help with. `size` is a Drive thumbnail spec such as
 * "w400". Returns null on any failure (missing file, both fetch paths down)
 * rather than throwing — a broken image must never take the dashboard down.
 */
export async function fetchImageBytes(
  fileId: string,
  size = "w400",
): Promise<{ buf: Buffer; type: string } | null> {
  try {
    const { b64, type } = await cachedImageBytes(fileId, size);
    return { buf: Buffer.from(b64, "base64"), type };
  } catch (err) {
    console.error(`Drive image fetch failed for ${fileId}:`,
      err instanceof Error ? err.message : err);
    return null;
  }
}

export function clearDriveCache(): void {
  revalidateTag(LIST_TAG, { expire: 0 });
  revalidateTag(BYTES_TAG, { expire: 0 });
}
