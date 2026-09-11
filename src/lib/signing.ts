/**
 * Short-lived signed tokens for the design-image route.
 *
 * Why not just the session cookie: the dashboard renders inside a blob-URL
 * iframe, which has an *opaque origin*. Image requests from it are cross-site,
 * so the NextAuth cookie (SameSite=Lax) is not sent — a cookie-gated route
 * would return 401 for every thumbnail. Instead the dashboard HTML, which is
 * already behind the auth gate, is handed a token minted for that user.
 *
 * The token is an expiry + HMAC over it, keyed by NEXTAUTH_SECRET. It only
 * grants reads of design images, expires with the page, and is no more
 * exposed than the payload it ships inside.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { unstable_cache } from "next/cache";

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // outlives a working day of one page

function secret(): string {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("NEXTAUTH_SECRET is required to sign design tokens");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Mint a token valid for `ttlMs`. `sub` scopes it (we use the user's email). */
export function mintDesignToken(sub: string, ttlMs = DEFAULT_TTL_MS): string {
  const exp = Date.now() + ttlMs;
  const payload = `${exp}.${sub}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
}

/**
 * Same token, reused across page loads for up to 6 hours (well under the
 * 12h token TTL, so it's never handed out already-expired).
 *
 * Why this exists: /api/dashboard used to call mintDesignToken() fresh on
 * every request. Design-image URLs embed this token (`&t=...`), so a fresh
 * token on every page load meant every image URL changed on every reload —
 * the browser's own HTTP cache (Cache-Control on /api/design responses) had
 * no chance to ever be reused, because the URL was never the same twice.
 * Caching the token itself, not just the image bytes, is what makes "I saw
 * this thumbnail an hour ago" actually skip the network the second time.
 */
export const getStableDesignToken = unstable_cache(
  async (sub: string) => mintDesignToken(sub),
  ["design-token"],
  { revalidate: 6 * 60 * 60, tags: ["design-token"] },
);

/** True when the token is well-formed, unexpired and correctly signed. */
export function verifyDesignToken(token: string | null): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;

  const payload = Buffer.from(token.slice(0, dot), "base64url").toString();
  const given = token.slice(dot + 1);

  let expected: string;
  try { expected = sign(payload); } catch { return false; }

  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const exp = Number(payload.split(".")[0]);
  return Number.isFinite(exp) && Date.now() < exp;
}
