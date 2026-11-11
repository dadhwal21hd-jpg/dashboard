# kk-dashboard — CLAUDE.md

Internal sales dashboard ("SDWL AI LENS") for a garment manufacturer. Reads
sales and Goods Return rows from a Google Sheet, aggregates them server-side,
and serves one self-contained HTML dashboard behind Google sign-in. Hosted on
Vercel (env vars live there; full list in [SETUP.md](SETUP.md)).

Everything a session needs to know is in this file — rules, business decisions
and the reasons behind them. Code comments are deliberately thin; **when you
change a rule, change it here.** Every rule marked "user-confirmed" came from the
owner; don't undo one without asking.

---

## 1. Architecture — read first

**Two codebases in one repo:**

1. **Next.js App Router (TypeScript)** — auth, data fetching, aggregation. Ends at
   [src/app/api/dashboard/route.ts](src/app/api/dashboard/route.ts).
2. **[public/dashboard_template.html](public/dashboard_template.html)** — ~4,400
   lines, all dashboard UI/CSS/JS inline. **Every dashboard feature lives here.**
   Not React, not TypeScript, not bundled, not linted.

The seam: the route reads the template as a string and replaces the literal
`/*__DATA__*/` with `const DATA = {...};`. The page
([src/app/dashboard/page.tsx](src/app/dashboard/page.tsx)) fetches that HTML and
shows it in an **iframe via a blob URL** — template JS can't reach the Next app
and vice versa. Debug the dashboard in the iframe's devtools context.

**Request is about a tab, chart, table, drill-down, filter, export or the lock →
edit the template.** Touch `src/lib/` only when the *shape of the data* changes.

```
Google Sheet  DASH (sales) + GOODS_RETURN (returns)
  → src/lib/sheets.ts       service-account read, 5-min in-memory cache
  → src/lib/oracle.ts       foldPartyAliases(): buyer names via Supabase party_aliases
  → src/lib/processor.ts    rows → DashboardData (aggregation, netting, clusters)
  → src/app/api/dashboard/  auth gate, + designs + stock, inject DATA, compress
  → src/app/dashboard/      blob-URL iframe
```

- `?refresh=1` busts the sheet / alias / design caches (the "↻ Refresh data" button).
- `?refreshImages=1` additionally clears cached design **photos** — deliberately
  separate, see §8.
- Auth: NextAuth + Google OAuth, allowlist `ALLOWED_EMAILS`
  ([src/lib/auth.ts](src/lib/auth.ts)); `src/middleware.ts` guards routes.
- The route **compresses its own response** (`encodeFor()`: brotli q5, else gzip).
  Next doesn't compress route-handler responses: 3.67 MB → ~267 KB, ~18 ms CPU;
  on weak 4G the page went 23.6 s → 4.6 s.
- `maxDuration = 60`.

---

## 2. Where the data comes from (as of 11 Nov 2026)

**Owner's decision (Nov 2026): sales AND returns come from the Google Sheet, not
Supabase.** Keep it that way until the owner says otherwise.

| What | Source | Setting |
|---|---|---|
| Sales | Sheet tab **`DASH`** | `GOOGLE_SHEET_ID`, `GOOGLE_SHEET_RANGE=DASH` |
| Goods Returns | Sheet tab **`GOODS_RETURN`** | `GOOGLE_RETURNS_RANGE=GOODS_RETURN` |
| Buyer-name merging | Supabase `party_aliases` | `PROJECT_URL`, `ANON_KEY` |
| Stock on hand | Supabase `stock_available`, `kk_stock_available` | same |
| Design photos | separate catalogue sheets + Drive | `GOOGLE_DESIGNS_*` |

- **Labotanica (fabric) and Unstitched (suits) are switched off** — owner, 11 Nov
  2026. The route passes `dropBrands: ["labotanica","unstitched"]` to `process()`,
  which drops those rows from sales *and* returns at ingestion (gone from every
  total, customer and tab); their brand-filter options are removed from the
  template. At the time that was 574 + 2 sales rows (1,024 units, ₹49 L) and 62
  return rows. Their classification rules (§3) stay in place — to bring them
  back, remove `dropBrands` and restore the two `<option>`s in `#brand-filter`.
- **`ORACLE_UPDATED` is ignored** — owner's instruction. It only covers ~Jul 2026
  onward; pointed at it, every return since 2021 was netted against four months
  of sales and 19 customers went negative (measured 11 Nov 2026).
- **DASH** (owner-maintained, cleaned history): 1 Apr 2021 – 7 Nov 2026, 78,651
  rows on 11 Nov 2026 (plus ~14k fully blank rows at the bottom — harmless).
  Columns: Item Description · Design · ArtSize · Buyer Name · Bill No. · Bill Dt.
  · (blank header) · Quantity · BP · MFG Lot. Price column is **`BP`**. Gowns
  plus ~570 fabric lines. Cold read ~3.5 s.
- **GOODS_RETURN**: 6 Apr 2021 onward, ~4,100 rows. Columns: Item Description ·
  Design · Buyer Name · Bill No. · Bill Dt. · Quantity · Rate. No reason column.
- If a returns read fails, sales still render (returns read never throws).
- `src/lib/sheets.ts` matches columns by fuzzy header (`NEEDED` alias map in
  processor.ts) — add an alias rather than asking for a sheet rename.

**Dormant Supabase sales/returns path** (kept, not called by the route):
`fetchOracleSales` / `fetchOracleReturns` / `fetchOracleHistory` /
`fetchDashSales` / `useDashSales` in [src/lib/oracle.ts](src/lib/oracle.ts) read
`oracle_bill_lines` (ledger from 1 Apr 2026) and `oracle_gr_report`. Rules for
that data if it's ever switched back:
- Price is `SP`; `BP` is empty on API lines.
- Never drop a line because `gone_since` is set — the piece left, it's sold.
- `oracle_gr_report` is emptied and reloaded twice a day; a read under 300 rows
  or under half the last good one keeps the previous figures.
- A bill is Bill_No + Bill_Dt + buyer; bill numbers repeat across Oracle's books.
- While sales are gowns-only, pass `skipReturnBrands: ["unstitched","labotanica"]`
  to `process()` so suit/fabric returns don't net against sales never loaded
  (Nov 2026: 13 customers negative, 2,778 pcs / ₹91 L — user-confirmed). With
  DASH + GOODS_RETURN it makes no difference (only ~62 fabric return rows), so
  the route doesn't pass it.

---

## 3. Data rules (all user-confirmed unless noted)

### Rows that never count
- **`EXCLUDED_BUYERS`** = `CHANGE BARCODE`, `CANCEL` — void/cancellation markers
  filed under a fake party name. Dropped from sales and returns at ingestion,
  before anything else (CHANGE BARCODE was 967 rows / ₹2.2 Cr of fake revenue at
  normal-looking prices). Add new confirmed void markers to this set, never
  filter per view.
- **Sanity-check outliers before trusting a big number.** A "26k pieces" report
  traced to two rows (qty 5,609 and 20,449) with every other field blank — a
  paste into the wrong column, fixed at source by the user. A real bulk order
  looks different: several rows, real customer, real styles, real prices.

### Buyer names
- **Spellings that differ only in capitals/spacing are one buyer.** `process()`
  folds them to the spelling with the most sales lines, sales and returns alike
  ("Roop Kala" → "ROOP KALA").
- **`party_aliases` (Supabase) merges real spelling variants** — applied to the
  sheet rows by `foldPartyAliases()` before `process()`. 38 aliases; 12 hit DASH
  / GOODS_RETURN names, e.g. GULLU EXCLUSIVE OLD + GULLU EXCLUSIVE INTERNATIONAL
  → Gullu Exclusive, SHAKUNTLAM XCLUSIF(.) → SHAKUNTLAM (RAJOURI), ROOP KALA OLD
  → Roop Kala, FRONTIER RAAS [P] LTD. → FRONTIER RAAS (P) LTD. Never throws: with
  Supabase unset/down names stay as the sheet spells them. Key = trimmed,
  whitespace-collapsed, lowercase (same as WIP_HEART's `party_alias._norm`).
- **Own-people accounts are never aliased** (`INTERNAL_PARTIES` in oracle.ts:
  Prakash Ji, Ankur Ji, Pathak Ji, Kriti Madam House / Kriti Mam / Kriti Mam
  Friends, Jyoti Mam House, Manoj Ji, Raja Sir). The alias table maps some onto
  real customers ("prakash ji" → "Dimple Fashion"), which would bury internal
  dispatches in a customer's revenue.
- **Customer clusters** ([src/lib/clusters.ts](src/lib/clusters.ts)) are a
  separate, display-level grouping of sister firms / related buyers (19
  clusters). Matching is case-insensitive and trimmed; members must match names
  *after* alias folding. Edit the array, commit, push. Don't merge on generic
  shared words ("fashion", "house") without confirmation — a wrong merge
  misrepresents a real business relationship.

### Design → sub cut + style
- Gown `Design` packs sub cut + style: `G-SGONC.84752` → sub cut `SGONC`, style
  `84752` (`parseDesign()`). The leading `<letters>-` is discarded.
- **Colourway suffixes are separate items**: `G-SG.16944C` → style `16944C`,
  `G-SG.53211[CH224]` → `53211[CH224]`. Kept verbatim, not collapsed.
- **Sub cuts AKE = AK, SGO = SG, LCO = LC** (`SUBCUT_SAME`). Longer variants
  (SGOB, AKEBO, LCOV, …) are NOT merged.

### Brands — `classifyBrand()` in processor.ts, stored as `RawRow.br`
Item Description is ground truth; checked in this order:
1. Contains `GOWN` → **KK** if it starts "KK", else **R-Studio**.
2. `DUPATTA…` → `other` (shown as Unclassified, deliberately not guessed).
3. Starts `SAAR`/`RAAS`, or design prefix **`E-`** → **Unstitched** (suits). "E- is
   all RAAS". Checked before the remarks test: RAAS lines carry "FABRIC …"
   remarks.
4. Any other `<letter>-` prefix (**`P-`** is all Labotanica), any Remarks, or
   "FABRIC" in the description → **Labotanica** (fabric). `O-` (brocade, not
   specified by the user) stays here as fabric.
5. Plain 4–5 digit design number (1360, "DENVER 1290") → **Unstitched** ("4-digit
   is SAAR").
6. Anything else → Labotanica. Blank description → `unknown`.

Only when there's **no Item Description column at all** (old sheet shape): style
< 50,000 → KK; ≥ 50,000 or `NR-`/`CH-` → R-Studio. This numeric rule was once
primary and was wrong for ~3.9% of 79k rows (plain "GOWN" items under 50,000) —
a small clean window is not proof a rule is right.

- **SAAR and RAAS are deliberately not split** (owners want them together as
  Unstitched). SAAR = plain 4-digit / "SAARR" description; RAAS = `E-` designs.
- **Fabric/suit labelling** (`extractRow`): sub cut = cloth name = first two
  words of Item Description, skipping numbers, minus the SAARR/RAAS word
  ("CRAPE PURE"). Style keeps the **full design code** (`E-19551G`, `1360`) —
  stripping the prefix would make 3 fabric codes (9033, 9101, 9124) equal real
  gown styles and mix up stock and photos.
- **Trailing `SOLO`, `[NK]`, `[WN]` tags are dropped** from suit/fabric codes
  (`E-21311B [SOLO]` → `E-21311B`), tolerating typos (`[NK[`, `NK]`). Gown codes
  untouched.
- **Units are not comparable across brands**: PRINTED FABRIC is metres (~₹75),
  gowns and suits are pieces/sets. On brand "All" they're simply added.
- Client code reads brand via `rowBrand(r)` / `styleBrand(sn)` (lookup built once
  from `D.raw`). There is no client re-derivation from the style number —
  don't recreate the removed `brandOf(sn)`.

### Dates — `parseDate()`
Accepts, in order:
- Google Sheets serial numbers (5 digits, e.g. 45397 → 15 Apr 2024).
- A trailing time is stripped ("2026-11-10 10:00").
- Oracle `DD/Mon/YY` and `DD-Mon-YY` (both separators occur in one sheet), and
  months spelled out ("13/October/26", "4/Sept/21") — before this was handled,
  5,340 pcs / ₹7.02 Cr sat in totals but in no month.
- Numeric `d/m/y` with `/ - .` and 2- or 4-digit year — **day first**, unless the
  middle number is > 12 (then month first). `yyyy-mm-dd`.
- **Nothing else.** No `new Date(s)` catch-all: it turned junk like "1" or
  "N/A 3" into 2001 dates (removed 11 Nov 2026). An unparseable cell stays
  undated.

### Goods Returns — netted dashboard-wide (user-confirmed)
- **Aggregate netting by (customer, style), not bill matching** — most return
  bills don't resolve to a sale in the loaded window. Netted in two places that
  must stay in sync: server (`process()`, second pass over the same
  accumulators) and client (`getFA()` over `FILTERED_RETURNS`, and
  `openDrillByName()`'s filtered path).
- `returns_raw` is a separate array with **positive** quantities — never mix
  negative rows into `raw` (`parseQty()` clamps ≤0 to 0, and the template assumes
  `r.q > 0` everywhere).
- **Net can go negative** for a customer/style with no matching sale; left as-is
  so the data gap is visible. On 11 Nov 2026 only one: MADHURAAG IMPEX −6 (6
  returns on bills 11–12, Jul 2021, no sale anywhere in DASH).
- Returns never touch `.dates`/`freq`, monthly dispatch totals, or Reorder
  Radar's cadence — a return isn't an order.
- Returns before DASH starts: 25 of FY21-22's 200 returns have no earlier sale,
  all Apr–Sep 2021, 19 for styles nobody bought in DASH — pieces sold before
  1 Apr 2021. Expected, not missing data. May 2021 is genuinely low (145 pcs) —
  seasonal, per the owner.

### Financial year
Every "year" is the Indian FY, 1 Apr – 31 Mar, keyed `FY25-26` (`fyKey()`,
`fyRange()`, `FY_MONTHS` = Apr→Mar).

---

## 4. Data model — `DashboardData` in [src/lib/types.ts](src/lib/types.ts)

The contract between the halves; the template consumes it verbatim as `DATA`
(`D`). Renaming a field means grepping the template.

- `raw: RawRow[]` — every sales row, compact keys: `c` customer · `sc` sub cut ·
  `sn` style · `q` qty · `p` price · `d` raw date · `dt` ISO date or null · `br`
  brand. **Most client features compute from `raw`**, so the filter bar can
  re-derive everything.
- `returns_raw: RawRow[]` — same shape, positive quantities.
- `subcuts` / `customers` / `style_groups` / `monthly` — pre-aggregated, net of
  returns. All styles are sent; the client applies the threshold.
- `drill` / `clustered_drill` — customer → top 10 sub cuts → all styles, net.
- `clustered_customers`, `cluster_membership` (name → cluster).
- Added by the route: `_fetched_at`, `_from_cache`, `_user`, `_master_code`,
  `_customer_code`, `_designs` (style numbers with a photo), `_design_base`,
  `_design_token`, `_stock` (style → units).

---

## 5. Template conventions

- **`getFA()`** is the filter-aware aggregator (subcuts, customers, styles,
  monthly, netted) from `FILTERED_RAW`/`FILTERED_RETURNS`, memoised in `_FA`.
  New features that must respect the filter bar go through it.
  `applyGlobalFilter()` sets the filtered arrays and clears `_FA`; anything
  cached *on* `_FA` (`returnsGross()`, `getCMP()`) is invalidated for free.
  `passesGlobalFilter()` / `passesNonDateFilter()` / `anyGlobalFilterActive()`.
- Tab renderers (`TAB_RENDERERS`): `renderOverview`, `renderSubcuts`, `renderSG`,
  `renderCusts`, `renderReorderRadar`, `renderReturns`, `renderClusters`,
  `renderInsights`. **`renderAll()` draws only the visible tab** and marks the
  rest stale (`_staleTabs`); `switchTab()` draws a stale tab when opened. Never
  read another tab's DOM expecting it current — read `getFA()` / `D`. (Drawing
  all eight per filter tap cost ~2 s on a mid-range phone.)
- **Style Numbers builds a group's rows only when opened** (`sgFill()` /
  `sgSetOpen()`, `_SG_BODIES`, `_SG_STYLES` for search) — building all ~4,700
  rows up front was 108k of 129k page elements. `renderSG()` keeps expanded
  groups open and re-applies the Sub Cut dropdown + search. The Returns style
  table draws 60 rows then appends in batches.
- Helpers: `fmt()` ₹ short form (L / Cr above 1e5 / 1e7), `fN()` en-IN number,
  `esc()` HTML escape, `scColor()` per-sub-cut colour, `freqBadge()`, `rn()`.
- **Never embed JSON in an `onclick`.** Stash data on a global map
  (`window._drillMap`, `window._scMap`) or a `data-*` attribute.
- Styling: `--accent: #b5622a` (terracotta), warm stone palette, `Syne` /
  `IBM Plex Mono`. No framework.

---

## 6. The lock UI (easy to break)

`LOCK_MODE` is `'locked' | 'unlocked' | 'customer'`:
- **locked** (default) — customer names and most numbers redacted via
  `body.locked` CSS.
- **customer** — one customer revealed (`UNLOCKED_CUSTOMER`), others redacted
  (`.cust-redacted` / `.cust-revealed`).
- **unlocked** — everything visible, gated by `_master_code`.

**Any UI that shows customer names must mask them** unless
`LOCK_MODE === 'unlocked'` or the name is `UNLOCKED_CUSTOMER` — use
`buyerLabel()`. Redaction CSS is specificity-sensitive (hide rules contain
`#cust-tbody`, so reveal rules must too); read the stylesheet comments first.
The locked-mode CSS hides every `.bar-track`, which is why Compare drill cards
use `.cmp-track`.

**The lock is visual only** — all data and both unlock codes are in the client
payload. Never present it as security.

---

## 7. Features

**Global filter bar** — date From/To, brand (`BRAND_FILTER`), qty, price. Brand
narrows `FILTERED_RAW`, so every `getFA()` tab inherits it. `openDrillByName()`
recomputes a customer's breakdown from filtered rows when any filter is active.
On phones it folds behind `#gf-toggle` with `#gf-summary`
(`renderFilterSummary()`); on desktop its wrappers are `display:contents` — keep
that or the desktop bar changes.

**Customer drill** — "By brand" strip (units · revenue · share, net) above the
sub-cut cards; cards carry a brand tag; style rows show a brand badge on "All".
Strip hidden in Compare mode. **Month on month** panel (`renderDrillMonths()` /
shared `renderFyMonths()`, picks in `_fyMM`): the customer's FYs side by side
Apr→Mar, default latest two, Revenue/Units; dispatched (gross of returns);
From/To ignored; a month with no data yet shows "—", and an unfinished FY is
compared on the same months only. The same panel opens for a sub cut (in the
drill — that customer only, with a style picker — and on the Sub Cuts tab — all
customers, hidden when locked).

**Overview chart** — `drawBarLine()`: HTML bars (units) + SVG revenue line on its
own right scale; gross of returns; `animateGrow()`; labels thinned to width;
redrawn on `switchTab('overview')` and width-only resize (a chart drawn hidden
has no width).

**Compare mode** (`⇄ Compare`, `CMP`, `#cmp-bar`) — full FYs side by side, or
picked months across picked FYs. Works on Overview, Style Numbers and the
Customers drill; other tabs show a `.cmp-na` banner. The picks are the dates
(From/To ignored, `getCMP()` uses `passesNonDateFilter()`); net of returns.
Partial years are flagged with `*` plus a one-click "same months only"
(`cmpCoverage()`). Rank by total across compared years; a style qualifies for
min-units in *any* year (so a collapse shows as a drop). No click-through from
compare style rows (that drill reads date-filtered rows and would disagree).
Quick FY buttons: `renderFyQuick()`.

**Reorder Radar** — flags customers overdue against **their own** rhythm (median
gap between distinct order dates vs days silent). `reorderRadarRows()`,
`daysBetween()`, `reorderStatus()` (Critical / Watch / On Track). Respects brand,
**ignores the date filter** (always full history vs today — said in the tab
header). Always individual customers, never clusters (cluster membership is a
badge) — the point is catching one account gone quiet inside a healthy cluster.
Row click → `jumpToCustomer()` → `handleCustClick()` (needs `data-cust` on
customer rows).

**Returns tab** (`renderReturns()`, `returnsAnalysis()`, `returnsGross()`,
`exportReturnsCSV()`) — respects the date filter. **Rate-first**: every row is
`returned ÷ (gross sold + returned)` on its own matched denominator. `retRate()`
returns null (shown "—") when nothing was dispatched. Min-units guard
(`returns-minvol`, default 25) demotes and greys, never hides. Clustered view
maps both sides of the ratio (`retCustKeyFn()`). KPIs ignore the search box;
tables obey it. Inline drills (`retOpenDrill()`): customer → their returned
styles; style → who returned it + concentration read. Lock-gated, names via
`buyerLabel()`, styles carry `designThumb()`. No reason breakdown (no column).

**Stock on hand** ([src/lib/stock.ts](src/lib/stock.ts), template `stockOf()` /
`stockCell()`) — R-Studio from `stock_available` filtered to `brand = R_STUDIO`
(that view also lists KK styles in production with 0 on hand — 41 styles showed
wrongly as 0 in Oct 2026), KK from `kk_stock_available`. Missing = "—", never 0.
Only styles that appear in orders are sent. Off without Supabase env; never
breaks the page.

**Mobile** — all in the template's "SMALL SCREENS" block; nothing applies above
900px. ≤900px the tab strip is the sticky bar; ≤640px phone layout. Every wide
table scrolls sideways (`.tbl-scroll`; `#drill-style-table` scrolls itself) —
never `overflow:hidden` around a table. Touch screens get 16px inputs (iOS
zoom). The Next page is `h-dvh`, not `h-screen`.

---

## 8. Design thumbnails

Off unless `GOOGLE_DESIGNS_SHEET_ID` is set (comma-separated list — **one
catalogue per branch**, merged first-source-wins, each detected independently;
together they cover 97% of ordered styles / 99% of units, either alone a third to
two thirds). Catalogue `Item Code` joins orders' style number; links are direct
file links. Column detection is evidence-based (sheets have a populated `Image`
column *and* an empty `Photo` column with duplicate/blank headers). Designs may
live under a different service account (`buildDesignsAuth()` falls back to the
main one).

- **Opaque-origin iframe**: relative URLs don't resolve and the session cookie
  isn't sent, so `/api/design` is authorised by an HMAC token
  ([src/lib/signing.ts](src/lib/signing.ts)) in `DATA._design_token`, with the
  absolute origin in `DATA._design_base`. Any future in-template URL hits this.
- `DATA._designs` is only the list of styles that have an image.
- Client: `designThumb(sn, 'sm'|'md')`, `openDesign(sn)` (lightbox `#dz`, shows
  cached thumb at once, fades in the w1200 photo, then checks `?list=1` for
  siblings). `resolveDesignStyle()` falls back to the **base style's** photo for
  an unphotographed colourway (`56078[CH284]` → `56078`), always marked as
  approximate (dashed border, "~" badge, lightbox subtitle). Designs are **not**
  redacted by the lock (see stylesheet note).
- Every failure degrades to "no thumbnail", never an error. A one-off "Could not
  load this design" that clears on retry is a Drive blip; `dzFail()` auto-retries
  once (800 ms, cache-busted) then offers Retry. The *same* style failing
  repeatedly = a real sharing problem.

**Speed decisions (don't regress):**
- `fetchImageBytes()` tries Drive's public thumbnail endpoint first — every
  sampled image is shared "anyone with the link" (the catalogues feed a public
  storefront); non-public files reliably fail there, so falling through to the
  authenticated path is safe.
- `fetchDesignMap()`, image bytes and folder listings use `unstable_cache` (Vercel
  Data Cache, cluster-wide), not module variables. Bytes stored base64 (verified
  byte-identical). Compute functions **throw** on failure so a failure is never
  cached; the exported wrappers catch.
- **`googleapis` loads on demand only** (`loadGoogleApis()`; JWT from
  `google-auth-library`). Bundled it was 11.5 MB of a 14 MB cold start. **Never add
  a top-level `import { google } from "googleapis"`.**
- Design token is **stable**: `getStableDesignToken()` lives 30 days, reused 25
  days; `/api/design` sends `private, max-age=2160000, immutable`. A fresh token
  per page load made every image URL new and defeated the browser cache.
  Long-lived is fine — the images are already link-shared.
- Drive caches use `revalidate: false` (photos never change in place; a new photo
  = new file ID). `?refreshImages=1` → `clearDriveCache()` is the escape hatch,
  deliberately not tied to `?refresh=1`.
- Token-signed image responses get `Vercel-CDN-Cache-Control` (`cdnHeaders()`);
  cookie-authorised ones are never edge-cached.
- Measured: 60 concurrent thumbnails ~8 s / 3 failures → ~2.7 s / 0; a warm
  repeat of a 30-image burst 94 ms.

---

## 9. Known gaps / deliberately not built

- **Clusters tab** (`renderClusters()`) reads `D.*` directly, not `getFA()` — it
  ignores every global filter. Making it filter-aware means re-deriving its
  clustering/heatmap from `fa`.
- Style Numbers' sub-cut dropdown lists all sub cuts from `D.style_groups`
  regardless of brand — harmless, deliberate.
- Clustered drill `freq` is a sum across members (approximate); clustered price
  is the max seen.
- Not built: return **lag** (no link from return to original bill), monthly
  returns **trend**, discount/margin (one price column), low-stock flags from the
  catalogue's "Current available" (likely web-store stock, unconfirmed).

---

## 10. Working notes

- `npm run dev` / `npm run build` / `npm run lint` / `npm test`. `npm test` runs
  `tests/template.test.mjs`, which extracts template functions by name (FY / month
  panel logic) and tests them.
- Lint doesn't cover the template — syntax-check inline scripts after editing
  (extract `<script>` bodies, run through `new Function(...)` in node).
- **Checking live data**: write a throwaway `.mts` script in the scratchpad that
  loads `.env.local`, imports `src/lib/sheets.ts` / `oracle.ts` / `processor.ts`
  via `file:///C:/...` URLs, and run it with `npx -y tsx`. Only summaries come
  back — the sheet itself never enters the conversation.
- `.env.local` is git-ignored; Vercel's env must be changed separately (the owner
  does that).
- Windows Git Bash has no tz database: `TZ=Asia/Kolkata date` prints UTC labelled
  GMT — add 5:30.
- Measure before claiming; report with a real bill / style / customer the owner
  can look up.
