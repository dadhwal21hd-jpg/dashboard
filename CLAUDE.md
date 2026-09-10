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
  **Net of Goods Returns** — see "Oracle source + Goods Returns" below.
- `drill` / `clustered_drill` — customer → sub cut → style, precomputed. Also
  net of returns.
- `cluster_membership` — original customer name → cluster name.
- `returns_raw: RawRow[]` — Goods Return rows, same shape as `raw`, positive
  quantities (units returned, not negated). Empty when returns aren't
  configured. Everything above already has these netted in server-side; this
  is for the client to net them again under its own filters and for the
  Returns tab — see below.

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

Real shape of that data, which the code is built around: each catalogue's
`Item Code` joins to the orders sheet's `Style Number`, and the links are
**direct file links**, one per style — folder links are supported but don't
occur. Column detection is evidence-based, not header-only: the sheets have a
populated `Image` column *and* an empty `Photo` column (and the second one has
duplicate and blank headers), so header matching alone picks the wrong column.

There is **one catalogue per branch** — `GOOGLE_DESIGNS_SHEET_ID` is a
comma-separated list, merged first-source-wins, each sheet detected
independently. Both together cover 97% of ordered styles and 99% of units;
either alone covers only a third to two thirds, since the two barely overlap
(350 codes in common).

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

**One occasional failure is expected and self-heals**: a "Could not load this
design" in the lightbox that clears up if you just try again — a one-off
Drive/network blip, not a broken image (checked directly: the file in
question loaded fine seconds later, both fast and authenticated paths, no
sharing issue). `dzFail()` auto-retries once (800ms, cache-busted) before
showing the error state, which now also has a manual Retry button. If the
*same* style fails repeatedly rather than once, that's a real sharing
problem, not this.

**Performance / scalability, two fixes worth knowing about if this regresses:**

1. `fetchImageBytes()` in [src/lib/drive.ts](src/lib/drive.ts) tries Google's
   *public* thumbnail endpoint (`drive.google.com/thumbnail?id=…`) before
   the authenticated Drive API path. Every sampled design image (40 across
   the full catalogue range) turned out to be shared "anyone with the link" —
   the catalogues feed a public storefront — so this is the common case, not
   an edge case. It skips both Drive API calls the authenticated path needs,
   costs nothing against Drive quota, and isn't subject to our own serverless
   concurrency. Confirmed a non-public/nonexistent file reliably comes back
   non-200/non-image here (never a misleading placeholder), so falling
   through to the authenticated path on failure is safe.
2. `fetchDesignMap()` in [src/lib/designs.ts](src/lib/designs.ts) is cached
   via Next's `unstable_cache` (the Vercel Data Cache), not a module
   variable. A module-level cache is per-lambda-instance; under a burst,
   Vercel scales up many instances at once, and every cold one used to redo
   both Sheets reads from scratch — traffic growth multiplied load on
   Google's API instead of being absorbed by a cache. The Data Cache is
   shared cluster-wide.

Measured effect of both together: a burst of 60 concurrent thumbnail
requests went from ~8s wall time with 3 failures (Drive quota/backoff under
load) to ~2.7s with 0 failures on the same infrastructure.

## Brand split (KK vs R-Studio vs Other/Non-Gown)

A business rule, not a sheet column. Two layers, checked in order:

1. **Gown-family or not**, from Oracle's `Item Description` (`isGownFamily()`
   in [src/lib/processor.ts](src/lib/processor.ts), stored server-side as
   `RawRow.g`) — anything not containing "gown" (SAMPLE, DUPATTA, PENT,
   FABRIC UNSTICHED SAARI, blanks, …) is **Other / Non-Gown**, full stop,
   regardless of its style number. This exists because a numeric style number
   alone can't tell a non-Gown item apart from a real Gown SKU sharing the
   same numeric range — confirmed with a synthetic case: a DUPATTA row with
   style number 56809 (≥50,000) would have been silently miscounted as
   R-Studio without this check. Not yet exercised by real data — the two live
   Oracle tabs are 100% Gown-family — but the classification is real and
   tested (see `isGownFamily()`'s own tests), not speculative. Sheet with no
   `Item Description` column at all (old shape) defaults every row to
   Gown-family, matching prior behaviour exactly.
2. **For Gown-family rows only**, `brandOf(sn)` classifies the style number:
   - style number **< 50,000** → **KK**
   - style number **≥ 50,000**, or an **`NR-xxx`** / **`CH-xxx`**-coded style → **R-Studio**
   - anything else (doesn't parse as a plain number, isn't `NR-` or `CH-`) → **Unclassified**

**Use `rowBrand(r)` (has a raw row) or `styleBrand(sn)` (has only a style
number) — not `brandOf(sn)` directly** — anywhere real data is being
classified; `brandOf()` alone skips the Gown-family check. `styleBrand()` is
backed by a `sn → Gown-family` lookup built once from `D.raw` (not
`FILTERED_RAW` — a style's category doesn't change with the date/brand/qty
filter), same lazy-cache pattern as `globalStyleMap()`.

(Corrected twice in review: `NR-xxx` was first thought to be KK, then it and
`CH-xxx` were confirmed to both be R-Studio — the numeric-only rule was right
from the start, the prefixes just needed to land on the same side as the
≥50,000 numerics, not the <50,000 side.)

Verified against the live orders sheet: the numeric boundary is completely
clean (no style has ever sat at 49999/50000/50001), and as of writing **zero**
orders fall into Unclassified. `NR-xxx` and `CH-xxx` both exist in the design
catalogues (hundreds of codes between them) but **neither has ever been
ordered** — the rule is real and coded correctly, but currently inert; don't
be surprised if the KK/R-Studio split accounts for 100% of live data with
nothing landing in Unclassified. If a *third* prefix ever gets ordered, it'll
correctly show up as Unclassified rather than being silently miscounted into
either brand — that bucket exists specifically as a safety net, and is the
place to add the next prefix once it's confirmed.

It's wired in as a value on the **global filter bar** (`BRAND_FILTER`,
alongside `DATE_FROM`/`FILTER_MIN_QTY`/etc.), not a separate tab — selecting a
brand narrows `FILTERED_RAW` in `applyGlobalFilter()`, so every tab that goes
through `getFA()` inherits it for free. `anyGlobalFilterActive()` is the
shared "is any global filter on" check; `openDrillByName()` uses it to decide
whether to recompute a customer's sub-cut/style breakdown from `FILTERED_RAW`
instead of trusting the server's unfiltered `D.drill` — **this same switch was
already needed for qty/price filters and had never been wired**, so fixing it
for brand fixed a pre-existing gap for those too.

**Known gap, not fixed by this**: the **Clusters tab** (`renderClusters()`)
reads `D.customers` / `D.subcuts` / `D.drill` directly and does not go through
`getFA()` at all — it already ignored date/qty/price filters before brand
existed, and it ignores brand too. This predates the brand feature; flagged
here so it isn't mistaken for a bug introduced by it. Making Clusters
filter-aware means re-deriving its auto-clustering and heatmap from `fa`
instead of `D`, which is a real (if not huge) separate piece of work.

Two other spots read `D.style_groups` (server, unfiltered) instead of
`fa.styles` (client, filter-aware) and had the same brand-blind-spot before
this: the Overview tab's "Styles sold" / "Top Style #" KPI cards, and the
Insights tab's "Hero Style" card + its AI-prompt builder. Both now derive from
`fa.styles`. The **sub-cut dropdown** in the Style Numbers tab
(`document.getElementById('snfilter')`) is deliberately left reading
`D.style_groups` — it's a one-time population of the *list of possible
options*, not a data value, so showing all sub-cuts regardless of the active
brand is harmless (a brand-narrowed tab may just show a dropdown option with
nothing under it).

## Reorder Radar

Flags customers overdue against **their own** historical ordering rhythm —
median gap between a customer's distinct order dates, compared to how long
they've actually been silent — rather than one flat "no order in N days" rule.
`reorderRadarRows(minOrders)` does the computation; `daysBetween()`,
`reorderStatus()` (the 3-tier Critical/Watch/On Track split) and
`renderReorderRadar()` sit next to it.

Two decisions worth knowing if this needs touching:

- **Brand-aware, date-filter-independent.** It respects `BRAND_FILTER` (same
  `brandOf()` as everywhere else) but always reads full history against
  today's real date, ignoring `DATE_FROM`/`DATE_TO` — narrowing the window
  would make the median-gap math meaningless. Said explicitly in the tab's own
  header text so it doesn't look like a bug when the date filter is active.
- **Always individual customers, never clustered rows** — the entire point is
  to catch an account gone quiet inside a cluster whose *blended* average
  still looks fine (this is real: Seasons Enterprises Pvt. Ltd., 3,087 units /
  118 orders historically, silent 411 days against a normal 2-day gap, is a
  Seasons Group member). Cluster membership is shown as a badge annotation
  instead of being merged away.

Row click reuses the existing Customers-tab machinery rather than building a
second drill UI: `jumpToCustomer()` switches tabs, sets the search box, then
calls `handleCustClick()` on the matching row — so lock-mode redaction and the
drill panel behave identically to clicking a row there directly. Needs the
`data-cust` attribute on customer rows (`renderCusts()`) to find that row
after re-render.

Checked and deliberately not built here: discount/margin tracking (orders
have one price column, no separate MRP; the catalogues' own Price/MRP columns
are essentially empty) and low-stock flags from the catalogue's "Current
available" column (that sheet is titled "...to Ecommerce OB" — almost
certainly web-store stock, not wholesale/factory stock; surfacing it without
confirming that first would risk being actively misleading).

The specific numbers cited above (Seasons Enterprises, 411 days) were measured
against the old source sheet, before the Oracle cutover below — illustrative
of the feature's logic, not current live figures.

## Oracle source + Goods Returns (Sep 2026 cutover)

The orders sheet was replaced outright — not merged — with an export from the
Oracle billing system, the actual system of record. Spreadsheet
"ORACLE OUT LIVE": `ORACLE_UPDATED` (sales) and `GOODS_RETURN` (returns) are
both read via `GOOGLE_SHEET_ID`/`GOOGLE_SHEET_RANGE`/`GOOGLE_RETURNS_RANGE` —
same service account, same spreadsheet, two tabs. A person keeps this "live"
tab updated from Oracle until API access exists; Supabase is the plan after
that, not before — don't build toward it speculatively.

**A large historical tab (`Sheet5`, 2021–2025, ~47k rows) exists in the same
spreadsheet but is deliberately NOT read** — the user is cleaning it
separately and will hand it over later. `Sheet5`'s data shape is messier than
the two live tabs (20+ `Item Description` categories, inconsistent `Design`
formats with no dot separator, alphanumeric suffixes) — don't assume today's
parsing handles it; re-verify against a real sample before wiring it in.

**Oracle's `Design` column packs sub-cut + style number into one cell** — e.g.
`G-SGONC.84752` → subcut `SGONC`, style `84752` (confirmed with the user).
`parseDesign()` in [src/lib/processor.ts](src/lib/processor.ts) does the
split; `detectColumns()` falls back to it when no dedicated style/subcut
columns exist, so an old-shape sheet (dedicated columns) still works
unchanged if this is ever pointed at one again. Both `ORACLE_UPDATED` and
`GOODS_RETURN` use this format; verified against real data, not assumed.

**Brand comes for free** — Oracle's `Item Description` is literally `"GOWN"`
(R-Studio) or `"KK GOWN"`/`"KK GOWN VELVET"` (KK), and this lines up exactly
with the existing numeric `brandOf()` rule once the style number is correctly
extracted from `Design` — confirmed against real data (KK-prefixed rows'
style numbers were all <50,000, plain GOWN rows' all ≥50,000). No brand field
was added to `RawRow`; `brandOf()` needed no changes.

**Oracle dates are `DD/Mon/YY` *and* `DD-Mon-YY`** — both separators occur
within the same sheet (confirmed: ~700/2244 rows in one snapshot used
hyphens). `parseOracleDate()` handles both; `parseDate()` tries it before the
original numeric-format patterns, which stay in place for compatibility.

**Goods Returns net dashboard-wide**, not just in a separate view — confirmed
with the user. Netting happens in two places that must stay in sync:
- Server, [src/lib/processor.ts](src/lib/processor.ts): the same accumulators
  the sales loop builds (`subcutAcc`/`custAcc`/`styleAcc`/`drill`/totals) get
  return rows subtracted from them in a second pass, keyed by style number
  (and customer, for the customer/drill accumulators) — not by exact bill
  match.
- Client, `getFA()` in the template: re-runs the same subtraction over
  `FILTERED_RETURNS` (a sibling to `FILTERED_RAW`, filtered by the same
  `passesGlobalFilter()`), so a filter (date, brand, qty, price) doesn't
  silently revert figures to gross. `openDrillByName()`'s filtered-recompute
  path does the same for the one customer/cluster being drilled into.

**Why returns aren't merged into `raw` as negative-quantity rows**: `parseQty()`
clamps anything ≤0 to zero, and dozens of places in the ~2,700-line template
assume `r.q` is positive (filters, percentages, display). Retrofitting
negative quantities into the one array everything already trusts would risk
breaking things far from the change. `returns_raw` is a same-shaped sibling
array instead (positive quantities), and every net figure is produced by
explicit subtraction, not by mixing sign-flipped rows into `raw`.

**Aggregate netting, not exact-bill-match** — confirmed with the user. Most
Goods Return bill numbers don't resolve to a sale in whatever window is
currently loaded (a return can reference a sale from before that window, or
from `Sheet5`, not yet provided), so matching would silently drop most
returns. A net total **can go negative** for a customer/style with no
matching sale in the loaded data — left as-is deliberately, since clamping to
zero would hide a real data gap instead of surfacing it.

**Returns deliberately never touch**: `.dates`/`freq` accumulators anywhere
(a return isn't a reorder), `monthlyAcc`/`moA` (a return isn't dispatch
activity), and **Reorder Radar's cadence math** (`reorderRadarRows()` only
ever reads `D.raw` — no code changes were needed there, it's naturally
unaffected).

New **Returns tab** (`renderReturns()`, `returnsBreakdown()`,
`exportReturnsCSV()`): by-customer and by-style totals plus a return-rate KPI
(returned ÷ (gross sold + returned) in the current filter). Unlike Reorder
Radar, this tab respects the date filter — there's no cadence math here that
narrowing the window would break. `GOODS_RETURN` has no reason/cause column,
so there's no by-reason breakdown; don't add one without a real column to
back it.

## Customer clusters

[src/lib/clusters.ts](src/lib/clusters.ts) hand-maps duplicate/related customer
names (same buyer under several sheet spellings, or a group of sister firms) to
one display name. Matching is case-insensitive and trimmed. Adding a group =
edit the array, commit, push; Vercel redeploys.

This is why several dashboard views have a "clustered" toggle (`CUST_VIEW`) and
why some analyses should note when two rows are really one buyer.

**Re-audit this against Oracle's naming after the cutover above** — Oracle
doesn't necessarily spell a customer the same way the old sheet did. One
confirmed addition already made: `FRONTIER CLOTTH HOUSE PVT.LTD` → Frontier
Raas Group (the shared word "FRONTIER" is distinctive enough in this customer
list to trust). Several other Oracle names share only generic words with
existing clusters (e.g. "fashion", "house") — deliberately **not** merged
without confirmation, since a wrong merge misrepresents a real business
relationship. Worth a proper pass once `Sheet5` brings in the full customer
list.

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
