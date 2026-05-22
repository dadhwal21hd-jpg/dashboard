/**
 * NextAuth configuration.
 *
 * Strategy:
 *   - Google OAuth provider (people sign in with their Google account)
 *   - Whitelist enforced in the signIn callback (env var: ALLOWED_EMAILS, comma-separated)
 *   - JWT session strategy (no database needed)
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   NEXTAUTH_SECRET          random string; generate with: openssl rand -base64 32
 *   NEXTAUTH_URL             e.g. https://yourapp.vercel.app  (Vercel sets this automatically in prod)
 *   ALLOWED_EMAILS           comma-separated list, e.g. "om@rstudio.com,boss@rstudio.com"
 */
import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";

function parseAllowedEmails(): Set<string> {
  const raw = process.env.ALLOWED_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    async signIn({ user }) {
      const allowed = parseAllowedEmails();
      const email = user.email?.toLowerCase();
      if (!email) return false;
      if (allowed.size === 0) {
        // Safety: if no whitelist configured, refuse everyone rather than allow everyone.
        console.error("ALLOWED_EMAILS is empty — refusing sign-in for safety.");
        return "/denied";
      }
      if (!allowed.has(email)) {
        return "/denied";
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user?.email) token.email = user.email;
      return token;
    },
    async session({ session, token }) {
      if (token?.email && session.user) {
        session.user.email = token.email as string;
      }
      return session;
    },
  },
};
