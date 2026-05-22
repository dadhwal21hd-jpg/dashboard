/**
 * Edge middleware: blocks unauthenticated requests to /dashboard before any
 * React code runs. The dashboard *page* also checks auth (defence in depth),
 * but this saves a round-trip when a logged-out user lands on /dashboard.
 */
import middleware from "next-auth/middleware";

export default middleware;

export const config = {
  matcher: ["/dashboard/:path*"],
};
