# kk-dashboard — CLAUDE.md

Internal sales-analytics dashboard ("SDWL AI LENS") for a garment manufacturer.
Reads order rows from a Google Sheet, aggregates them server-side, and serves a
single self-contained HTML dashboard behind Google sign-in.

## Architecture — read this first

The app is **two codebases in one repo** and the split matters:

1. **Next.js App Router (TypeScript)** — auth, Sheet fetching, aggregation.
   Ends at [src/app/api/dashboard/route.ts](src/app/api/dashboard/route.ts).
2. **`public/dashboard_template.html`** — a ~2400-line standalone HTML file with
   all dashboard UI, CSS and JS inline. **This is where every dashboard feature
   lives.** It is not React, not TypeScript, not bundled, and not linted.

The seam: the route reads the template as a string and replaces the literal
`/*__DATA__*/` placeholder with `const DATA = {...};`. The page component
([src/app/dashboard/page.tsx](src/app/dashboard/page.tsx)) fetches that HTML and
renders it in an **iframe via a blob URL** — so template JS has no access to the
Next app, and vice versa. Debugging the dashboard means using the iframe's
context in devtools.

**If a request is about a tab, chart, table, drill-down, filter, export or the
lock UI → edit `public/dashboard_template.html`.** Only touch `src/lib/` when
the *shape of the data* has to change.

## Request flow

```
Google Sheet
  → src/lib/sheets.ts        service-account fetch, 5-min in-memory cache
  → src/lib/processor.ts     rows → DashboardData (aggregation, clustering)
  → src/app/api/dashboard/   auth gate + inject DATA into the template
  → src/app/dashboard/       blob-URL iframe
```

- `?refresh=1` on the API busts the sheet cache.
- Auth: NextAuth + Google OAuth, allowlist from `ALLOWED_EMAILS`
  ([src/lib/auth.ts](src/lib/auth.ts)); `src/middleware.ts` guards routes.

## Data model

`DashboardData` in [src/lib/types.ts](src/lib/types.ts) is the contract between
the two halves — the template consumes it verbatim as `DATA`. Changing a field
name there means grepping the template too.

Key pieces:

- `raw: RawRow[]` — every order row, compact keys:
  `c` customer · `sc` sub cut · `sn` style number · `q` qty · `p` price ·
  `d` raw date string · `dt` ISO date or null.
  **Most client-side features are computed from `raw`, not from the pre-aggregated
  arrays**, because the global filter bar must be able to re-derive everything.
- `subcuts` / `customers` / `style_groups` / `monthly` — pre-aggregated views.
- `drill` / `clustered_drill` — customer → sub cut → style, precomputed.
- `cluster_membership` — original customer name → cluster name.

## Client-side conventions (template)

- **`getFA()`** is the filter-aware aggregator: it recomputes subcuts, customers,
  styles and monthly totals from `FILTERED_RAW`, memoised in `_FA`.
  Any new feature that must respect the global filter bar goes through it, or
  walks `FILTERED_RAW.length < D.raw.length ? FILTERED_RAW : D.raw` directly.
  `applyGlobalFilter()` sets `FILTERED_RAW` and clears `_FA`.
- Render functions per tab: `renderOverview`, `renderSubcuts`, `renderSG`
  (style numbers), `renderCusts`, `renderClusters`, `renderInsights`.
  `renderAll()` calls them.
- Helpers: `fmt()` ₹ short form, `fN()` en-IN number, `esc()` HTML escape,
  `scColor()` stable per-sub-cut colour, `freqBadge()` reorder-count pill,
  `rn()` rank medal.
- **Never embed JSON in an `onclick` attribute.** The established pattern is to
  stash data on a global map (`window._drillMap`, `window._scMap`) or on a
  `data-*` attribute and look it up in the handler.
- Money is INR; `fmt()` switches to L/Cr above 1e5/1e7.

## The lock UI (important, easy to break)

`LOCK_MODE` is `'locked' | 'unlocked' | 'customer'`:

- **locked** (default) — customer names and most numbers redacted via
  `body.locked` CSS rules.
- **customer** — one customer revealed (`UNLOCKED_CUSTOMER`); everyone else stays
  redacted (`.cust-redacted` / `.cust-revealed`).
- **unlocked** — everything visible, gated by `_master_code`.

**Any new UI that displays customer names must respect this** — mask them unless
`LOCK_MODE === 'unlocked'` or the name is `UNLOCKED_CUSTOMER`. See
`buyerLabel()` in the style-numbers drill for the pattern.

The redaction CSS is specificity-sensitive (hide rules contain `#cust-tbody`, so
reveal rules must too). Comments in the stylesheet explain each override — read
them before adding rules.

The lock is **visual only**: `DATA`, including the unlock codes
(`_master_code`, `_customer_code` from env), is in the client payload. Do not
present it as a security boundary.

## Design thumbnails

Optional feature, off unless `GOOGLE_DESIGNS_SHEET_ID` is set. A separate
product-catalogue spreadsheet maps style code → Drive image;
[src/lib/designs.ts](src/lib/designs.ts) reads it (10-min cache) and
[src/lib/drive.ts](src/lib/drive.ts) fetches bytes.

Real shape of that data, which the code is built around: the catalogue's
`Item Code` joins to the orders sheet's `Style Number` (~63% of ordered styles
have an image), and the links are **direct file links**, one per style — folder
links are supported but don't occur. Column detection is evidence-based, not
header-only: the sheet has a populated `Image` column *and* an empty `Photo`
column, and header matching alone picks the wrong one.

The designs often live under a **different service account and Cloud project**
than the orders sheet, hence `buildDesignsAuth()` in
[src/lib/google.ts](src/lib/google.ts), which falls back to the main account.

**The non-obvious part:** the template runs in a blob-URL iframe, so it has an
*opaque origin* — relative URLs don't resolve and the NextAuth cookie is not
sent on subresource requests. So `/api/design` is authorised by an HMAC token
([src/lib/signing.ts](src/lib/signing.ts)) minted into `DATA._design_token`,
and `DATA._design_base` carries the absolute origin. Any future feature that
loads a URL from inside the template hits this same wall.

`DATA._designs` is just the **list of style numbers that have an image**, not
the Drive IDs — the client only needs presence, `/api/design` resolves IDs
server-side, and the catalogue is far bigger than the order book.

Client side: `designThumb(sn, 'sm'|'md')` renders a cell (empty string when the
feature is off, hatched placeholder when the style has no image);
`openDesign(sn)` opens the `#dz` lightbox, showing the image immediately and
only then checking `?list=1` for siblings to page through. Designs are
deliberately **not** redacted by `LOCK_MODE` — see the note in the stylesheet.

Every failure path degrades to "no thumbnail", never to an error: a broken
mapping sheet or unshared folder must not take the dashboard down.

## Customer clusters

[src/lib/clusters.ts](src/lib/clusters.ts) hand-maps duplicate/related customer
names (same buyer under several sheet spellings, or a group of sister firms) to
one display name. Matching is case-insensitive and trimmed. Adding a group =
edit the array, commit, push; Vercel redeploys.

This is why several dashboard views have a "clustered" toggle (`CUST_VIEW`) and
why some analyses should note when two rows are really one buyer.

## Working notes

- `npm run dev` / `npm run build` / `npm run lint`. Lint does **not** cover the
  template — syntax-check inline scripts manually when editing it, e.g.
  extract `<script>` bodies and run them through `new Function(...)` in node.
- The template's CSS uses `--accent: #b5622a` (terracotta) with a warm stone
  palette and `Syne` / `IBM Plex Mono` fonts. Match it; no framework in there.
- Vercel-hosted; env vars are configured there
  (see [SETUP.md](SETUP.md) for the full list).
- Sheet columns are matched by fuzzy header names in the `NEEDED` alias map
  ([src/lib/processor.ts](src/lib/processor.ts)) — add an alias rather than
  requiring the sheet to be renamed.
