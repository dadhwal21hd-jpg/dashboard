/**
 * Google Drive reads for design thumbnails.
 *
 * The mapping sheet gives us a *folder*, so every lookup is two steps:
 * list the folder's image files, then fetch bytes for one of them. Both are
 * cached in memory — designs are effectively static, and Drive quota is not.
 *
 * Requires the Drive API enabled on the Cloud project and the design folders
 * shared with the service account (sharing one parent cascades to children).
 */
import { google } from "googleapis";
import { buildAuth, SCOPE_DRIVE } from "./google";

export interface DriveImage {
  id: string;
  name: string;
  mimeType: string;
}

const LIST_TTL_MS = 30 * 60 * 1000;
const BYTES_TTL_MS = 60 * 60 * 1000;
/** Cap the byte cache so a big catalogue can't exhaust the lambda's memory. */
const BYTES_MAX_ENTRIES = 300;

const listCache = new Map<string, { files: DriveImage[]; at: number }>();
const bytesCache = new Map<string, { buf: Buffer; type: string; at: number }>();

function driveClient() {
  return google.drive({ version: "v3", auth: buildAuth([SCOPE_DRIVE]) });
}

/**
 * Image files inside a folder, name-sorted so "the first image" is stable
 * across requests. Returns [] on any failure — a missing design must never
 * surface as an error in the dashboard.
 */
export async function listFolderImages(folderId: string): Promise<DriveImage[]> {
  const hit = listCache.get(folderId);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.files;

  try {
    const drive = driveClient();
    const res = await drive.files.list({
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and mimeType contains 'image/' and trashed = false`,
      fields: "files(id,name,mimeType)",
      orderBy: "name_natural",
      pageSize: 50,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const files: DriveImage[] = (res.data.files ?? []).map((f) => ({
      id: f.id!,
      name: f.name ?? "",
      mimeType: f.mimeType ?? "image/jpeg",
    })).filter((f) => f.id);

    listCache.set(folderId, { files, at: Date.now() });
    return files;
  } catch (err) {
    console.error(`Drive list failed for folder ${folderId}:`,
      err instanceof Error ? err.message : err);
    listCache.set(folderId, { files: [], at: Date.now() });
    return [];
  }
}

function rememberBytes(key: string, buf: Buffer, type: string) {
  if (bytesCache.size >= BYTES_MAX_ENTRIES) {
    // Cheap eviction: drop the oldest inserted key (Map preserves insertion order).
    const oldest = bytesCache.keys().next().value;
    if (oldest) bytesCache.delete(oldest);
  }
  bytesCache.set(key, { buf, type, at: Date.now() });
}

/**
 * Bytes for one image.
 *
 * `size` is a Drive thumbnail spec such as "w400". Drive's own thumbnail
 * renderer is used when available (small, fast, already resized); if the file
 * has no thumbnail yet we fall back to downloading the original.
 */
export async function fetchImageBytes(
  fileId: string,
  size = "w400",
): Promise<{ buf: Buffer; type: string } | null> {
  const key = `${fileId}@${size}`;
  const hit = bytesCache.get(key);
  if (hit && Date.now() - hit.at < BYTES_TTL_MS) return { buf: hit.buf, type: hit.type };

  try {
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
      const token = await buildAuth([SCOPE_DRIVE]).getAccessToken();
      const res = await fetch(url, {
        headers: token?.token ? { Authorization: `Bearer ${token.token}` } : undefined,
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const type = res.headers.get("content-type") || "image/jpeg";
        rememberBytes(key, buf, type);
        return { buf, type };
      }
    }

    // No thumbnail — pull the original file.
    const full = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );
    const buf = Buffer.from(full.data as ArrayBuffer);
    const type = meta.data.mimeType || "image/jpeg";
    rememberBytes(key, buf, type);
    return { buf, type };
  } catch (err) {
    console.error(`Drive image fetch failed for ${fileId}:`,
      err instanceof Error ? err.message : err);
    return null;
  }
}

export function clearDriveCache(): void {
  listCache.clear();
  bytesCache.clear();
}
