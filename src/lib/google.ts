/**
 * Shared Google service-account auth.
 *
 * One service account backs both Sheets and Drive. The scopes differ per use,
 * so callers pass what they need — a JWT is cached per scope set, since
 * minting one costs a token exchange on first use.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_SERVICE_ACCOUNT_KEY     newlines may be literal \n (Vercel) or real
 */
import { google } from "googleapis";
import type { JWT } from "google-auth-library";

export const SCOPE_SHEETS = "https://www.googleapis.com/auth/spreadsheets.readonly";
export const SCOPE_DRIVE  = "https://www.googleapis.com/auth/drive.readonly";

const jwtCache = new Map<string, JWT>();

export function getEnv(name: string, required = true): string {
  const v = process.env[name];
  if (!v && required) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v ?? "";
}

export function buildAuth(scopes: string[]): JWT {
  const key = scopes.slice().sort().join(" ");
  const cached = jwtCache.get(key);
  if (cached) return cached;

  const email = getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  // Vercel env vars can't contain real newlines; accept either form.
  const privateKey = getEnv("GOOGLE_SERVICE_ACCOUNT_KEY").replace(/\\n/g, "\n");

  const jwt = new google.auth.JWT({ email, key: privateKey, scopes });
  jwtCache.set(key, jwt);
  return jwt;
}
