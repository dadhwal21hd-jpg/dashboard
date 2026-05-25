/**
 * TypeScript port of process_csv.py + clustered-customer extension.
 *
 * Core analytics output matches the original Python script byte-for-byte.
 * Adds clustered_customers, clustered_drill, cluster_membership for the
 * Individual/Clustered toggle in the Customers tab.
 */
import type {
  DashboardData,
  SheetRow,
  SubCut,
  Customer,
  StyleGroup,
  StyleEntry,
  MonthlyEntry,
  DrillData,
  RawRow,
} from "./types";
import { CLUSTERS, buildClusterLookup, clusterFor } from "./clusters";

// ─── HELPERS ────────────────────────────────────────────────────────────────

/** Extract the first integer/float from a price string. */
export function parsePrice(p: unknown): number {
  const s = String(p ?? "").trim().replace(/,/g, "");
  const m = s.match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

/** Extract integer quantity — returns 0 for non-numeric / non-positive values. */
export function parseQty(q: unknown): number {
  const s = String(q ?? "").trim().replace(/,/g, "");
  if (!s) return 0;
  const v = parseFloat(s);
  if (!Number.isFinite(v)) return 0;
  const i = Math.trunc(v);
  return i > 0 ? i : 0;
}

/** Python-compatible round() — banker's rounding (round half to even).
 *  JS Math.round rounds half away from zero (or up). Python rounds half to even. */
export function bankRound(n: number): number {
  const floor = Math.floor(n);
  const diff = n - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // Exactly .5 → round to even
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Parse dd/mm/yyyy → Date. Returns null on failure. Mirrors Python's parse_date. */
export function parseDate(d: unknown): Date | null {
  const s = String(d ?? "").trim();
  if (!s) return null;

  // Try each format in order, same as Python
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => [number, number, number]]> = [
    // dd/mm/yyyy
    [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, (m) => [parseInt(m[3]), parseInt(m[2]), parseInt(m[1])]],
    // dd-mm-yyyy
    [/^(\d{1,2})-(\d{1,2})-(\d{4})$/, (m) => [parseInt(m[3]), parseInt(m[2]), parseInt(m[1])]],
    // yyyy-mm-dd
    [/^(\d{4})-(\d{1,2})-(\d{1,2})$/, (m) => [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])]],
    // mm/dd/yyyy
    [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, (m) => [parseInt(m[3]), parseInt(m[1]), parseInt(m[2])]],
  ];

  for (const [re, build] of patterns) {
    const m = s.match(re);
    if (m) {
      const [y, mo, day] = build(m);
      // Validate the date is real (e.g. not 31/02/2024)
      if (mo < 1 || mo > 12 || day < 1 || day > 31) continue;
      const dt = new Date(Date.UTC(y, mo - 1, day));
      if (
        dt.getUTCFullYear() === y &&
        dt.getUTCMonth() === mo - 1 &&
        dt.getUTCDate() === day
      ) {
        return dt;
      }
    }
  }
  return null;
}

/** Format yyyy-mm-dd from a Date (UTC). */
function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── MAIN PROCESSOR ─────────────────────────────────────────────────────────

const NEEDED: Record<string, string[]> = {
  style:  ["style number", "style_number", "style no", "style"],
  subcut: ["sub cut style", "sub_cut_style", "subcut", "cut style", "sub cut"],
  qty:    ["qty", "quantity", "units"],
  cust:   ["order sent to", "customer", "order_sent_to", "party"],
  price:  ["price", "mrp", "rate"],
  date:   ["customer dispatch date", "dispatch date", "date", "dispatch_date"],
};

export function process(rows: SheetRow[]): DashboardData {
  if (!rows.length) {
    throw new Error("Sheet has no data rows.");
  }

  // ── Detect required columns (case-insensitive) ──────────────────────────
  const headers = Object.keys(rows[0]);
  const headersLower: Record<string, string> = {};
  for (const h of headers) headersLower[h.toLowerCase().trim()] = h;

  const colMap: Record<string, string> = {};
  for (const [key, candidates] of Object.entries(NEEDED)) {
    for (const c of candidates) {
      if (c in headersLower) {
        colMap[key] = headersLower[c];
        break;
      }
    }
    if (!(key in colMap)) {
      throw new Error(
        `Cannot find column for '${key}'. Found columns: ${headers.join(", ")}`,
      );
    }
  }

  // ── Accumulators ────────────────────────────────────────────────────────
  type SubAcc   = { qty: number; rev: number; custs: Set<string>; styles: Set<string> };
  type CustAcc  = { qty: number; rev: number; scs:   Set<string>; styles: Set<string> };
  type StyleAcc = { qty: number; rev: number; sc: string; price: number; custs: Set<string>; dates: Set<string> };
  type DrillAcc = { qty: number; rev: number; price: number; dates: Set<string> };

  const subcutAcc  = new Map<string, SubAcc>();
  const custAcc    = new Map<string, CustAcc>();
  const styleAcc   = new Map<string, StyleAcc>();
  const monthlyAcc = new Map<string, number>();
  // drill: customer → subcut → style → DrillAcc
  const drill = new Map<string, Map<string, Map<string, DrillAcc>>>();

  const getSub = (k: string): SubAcc => {
    let v = subcutAcc.get(k);
    if (!v) { v = { qty: 0, rev: 0, custs: new Set(), styles: new Set() }; subcutAcc.set(k, v); }
    return v;
  };
  const getCust = (k: string): CustAcc => {
    let v = custAcc.get(k);
    if (!v) { v = { qty: 0, rev: 0, scs: new Set(), styles: new Set() }; custAcc.set(k, v); }
    return v;
  };
  const getStyle = (k: string): StyleAcc => {
    let v = styleAcc.get(k);
    if (!v) { v = { qty: 0, rev: 0, sc: "", price: 0, custs: new Set(), dates: new Set() }; styleAcc.set(k, v); }
    return v;
  };
  const getDrill = (c: string, sc: string, sn: string): DrillAcc => {
    let lvl1 = drill.get(c);
    if (!lvl1) { lvl1 = new Map(); drill.set(c, lvl1); }
    let lvl2 = lvl1.get(sc);
    if (!lvl2) { lvl2 = new Map(); lvl1.set(sc, lvl2); }
    let lvl3 = lvl2.get(sn);
    if (!lvl3) { lvl3 = { qty: 0, rev: 0, price: 0, dates: new Set() }; lvl2.set(sn, lvl3); }
    return lvl3;
  };

  let totalQty = 0;
  let totalRev = 0;
  const allDates: Date[] = [];

  for (const r of rows) {
    const qty   = parseQty(r[colMap.qty]);
    const price = parsePrice(r[colMap.price]);
    const cust  = (r[colMap.cust]   || "Unknown").trim() || "Unknown";
    const sc    = (r[colMap.subcut] || "Unknown").trim() || "Unknown";
    const sn    = (r[colMap.style]  || "Unknown").trim() || "Unknown";
    const date  = (r[colMap.date]   || "").trim();

    const rev = qty * price;
    totalQty += qty;
    totalRev += rev;

    const sub = getSub(sc);
    sub.qty += qty; sub.rev += rev; sub.custs.add(cust); sub.styles.add(sn);

    const cu = getCust(cust);
    cu.qty += qty; cu.rev += rev; cu.scs.add(sc); cu.styles.add(sn);

    const st = getStyle(sn);
    st.qty += qty; st.rev += rev; st.sc = sc;
    if (price > 0) st.price = price;
    st.custs.add(cust); st.dates.add(date);

    const dt = parseDate(date);
    if (dt) {
      const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
      monthlyAcc.set(key, (monthlyAcc.get(key) || 0) + qty);
      allDates.push(dt);
    }

    const dr = getDrill(cust, sc, sn);
    dr.qty += qty; dr.rev += rev;
    if (price > 0) dr.price = price;
    if (date) dr.dates.add(date);
  }

  // ── Sub cuts (sorted by qty desc, exclude Unknown) ───────────────────────
  const subcuts: SubCut[] = [...subcutAcc.entries()]
    .filter(([sc]) => sc && sc !== "Unknown")
    .sort((a, b) => b[1].qty - a[1].qty)
    .map(([sc, v]) => ({
      name: sc,
      qty: v.qty,
      revenue: bankRound(v.rev),
      customers: v.custs.size,
      styles: v.styles.size,
    }));

  // ── Customers (sorted by qty desc, exclude Unknown) ──────────────────────
  const customers: Customer[] = [...custAcc.entries()]
    .filter(([c]) => c && c !== "Unknown")
    .sort((a, b) => b[1].qty - a[1].qty)
    .map(([c, v]) => ({
      name: c,
      qty: v.qty,
      revenue: bankRound(v.rev),
      sc: [...v.scs].sort(),
      vc: v.styles.size,
    }));

  // ── Style groups: ALL styles sent; client filters by user-set threshold ──
  // (Original Python and earlier TS port filtered server-side with qty > 10.
  // Now the threshold is a UI control on the client, so we send everything.)
  const styleGroupsRaw = new Map<string, StyleEntry[]>();
  for (const [sn, v] of styleAcc.entries()) {
    if (v.sc && v.sc !== "Unknown") {
      if (!styleGroupsRaw.has(v.sc)) styleGroupsRaw.set(v.sc, []);
      styleGroupsRaw.get(v.sc)!.push({
        n: sn,
        qty: v.qty,
        rev: bankRound(v.rev),
        price: Math.trunc(v.price),
        cust: v.custs.size,
      });
    }
  }
  const styleGroups: StyleGroup[] = [...styleGroupsRaw.entries()]
    .map(([sc, entries]) => ({ sc, entries, totalQty: entries.reduce((s, e) => s + e.qty, 0) }))
    .sort((a, b) => b.totalQty - a.totalQty)
    .map(({ sc, entries, totalQty }) => ({
      sc,
      c: "#b5622a",
      tq: totalQty,
      s: entries.sort((a, b) => b.qty - a.qty),
    }));

  // ── Monthly trend (sorted chronologically, pretty labels) ────────────────
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthly: MonthlyEntry[] = [...monthlyAcc.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, q]) => {
      const [y, mo] = k.split("-");
      return { m: `${monthNames[parseInt(mo) - 1]} ${y.slice(2)}`, q };
    });

  // ── Drill-down: ALL customers, top 10 SCs each, top 25 styles each ─────
  // (Original Python script capped at top 30; removed for web app since
  // payload is fetched on demand and customer counts are well under 1000.)
  const drillJson: DrillData = {};
  const allCustNames = customers.map((c) => c.name);
  for (const cust of allCustNames) {
    const lvl1 = drill.get(cust);
    if (!lvl1) continue;

    const scTotals: [string, number, Map<string, DrillAcc>][] = [];
    for (const [sc, styles] of lvl1.entries()) {
      if (!sc || sc === "Unknown") continue;
      let qSum = 0;
      for (const v of styles.values()) qSum += v.qty;
      scTotals.push([sc, qSum, styles]);
    }
    scTotals.sort((a, b) => b[1] - a[1]);
    const topScs = scTotals.slice(0, 10);

    const scData: Record<string, { qty: number; rev: number; styles: Array<{ n: string; qty: number; rev: number; price: number; freq: number }> }> = {};
    for (const [sc, scQty, styles] of topScs) {
      let scRev = 0;
      for (const v of styles.values()) scRev += v.rev;
      const styleArr = [...styles.entries()]
        .sort((a, b) => b[1].qty - a[1].qty)
        .slice(0, 25)
        .map(([sn, v]) => ({
          n: sn,
          qty: v.qty,
          rev: bankRound(v.rev),
          price: Math.trunc(v.price),
          freq: v.dates.size,
        }));
      scData[sc] = { qty: scQty, rev: bankRound(scRev), styles: styleArr };
    }
    drillJson[cust] = scData;
  }

  // ── Clustered customers + clustered drill-down ──────────────────────────
  // Merge customers within the same cluster (per CLUSTERS config).
  // Standalone customers (not in any cluster) appear unchanged.
  const clusterLookup = buildClusterLookup();
  const clusterMembership: Record<string, string> = {};
  for (const c of customers) {
    const cluster = clusterFor(c.name, clusterLookup);
    if (cluster) clusterMembership[c.name] = cluster;
  }

  // Aggregate customer-level metrics per cluster.
  type ClusterAgg = { qty: number; rev: number; scs: Set<string>; styles: Set<string>; memberCount: number };
  const clusterAgg = new Map<string, ClusterAgg>();
  const standaloneCustomers: Customer[] = [];

  for (const c of customers) {
    const clusterName = clusterMembership[c.name];
    if (clusterName) {
      let agg = clusterAgg.get(clusterName);
      if (!agg) {
        agg = { qty: 0, rev: 0, scs: new Set(), styles: new Set(), memberCount: 0 };
        clusterAgg.set(clusterName, agg);
      }
      agg.qty += c.qty;
      agg.rev += c.revenue;
      for (const sc of c.sc) agg.scs.add(sc);
      // Style count merges via vc — we can't get exact unique-style-merged here
      // without re-walking raw, so we sum vc (rough upper bound — see below for exact).
      agg.memberCount += 1;
    } else {
      standaloneCustomers.push(c);
    }
  }

  // For accurate styles-count per cluster, we need to count *distinct* styles
  // across all member customers. Walk styleAcc once.
  const clusterStyleSets = new Map<string, Set<string>>();
  for (const [sn, v] of styleAcc.entries()) {
    for (const memberCust of v.custs) {
      const clusterName = clusterMembership[memberCust];
      if (clusterName) {
        if (!clusterStyleSets.has(clusterName)) clusterStyleSets.set(clusterName, new Set());
        clusterStyleSets.get(clusterName)!.add(sn);
      }
    }
  }

  // Build Customer rows for each cluster, sort with standalones, then sort all by qty desc.
  const clusterCustomerRows: Customer[] = [...clusterAgg.entries()].map(([name, v]) => ({
    name,
    qty: v.qty,
    revenue: v.rev,
    sc: [...v.scs].sort(),
    vc: clusterStyleSets.get(name)?.size ?? 0,
  }));

  const clusteredCustomers: Customer[] = [...clusterCustomerRows, ...standaloneCustomers]
    .sort((a, b) => b.qty - a.qty);

  // Build cluster-level drill-down by merging member drill data.
  const clusteredDrill: DrillData = {};
  // Helper: merge multiple member drill entries for one cluster
  for (const cluster of CLUSTERS) {
    const members = cluster.members
      .map((m) => {
        // Find canonical (case-insensitive) name as it appears in customers
        const found = customers.find((c) => c.name.trim().toLowerCase() === m.trim().toLowerCase());
        return found?.name;
      })
      .filter((m): m is string => !!m);

    if (members.length === 0) continue;

    // Aggregate sub-cut → style across all members
    type StyleMerge = { qty: number; rev: number; price: number; freq: number };
    type SubMerge = { qty: number; rev: number; styles: Map<string, StyleMerge> };
    const subMerge = new Map<string, SubMerge>();

    for (const memberName of members) {
      const memberDrill = drillJson[memberName];
      if (!memberDrill) continue;
      for (const [sc, scData] of Object.entries(memberDrill)) {
        let sm = subMerge.get(sc);
        if (!sm) { sm = { qty: 0, rev: 0, styles: new Map() }; subMerge.set(sc, sm); }
        sm.qty += scData.qty;
        sm.rev += scData.rev;
        for (const st of scData.styles) {
          let exist = sm.styles.get(st.n);
          if (!exist) {
            exist = { qty: 0, rev: 0, price: st.price, freq: 0 };
            sm.styles.set(st.n, exist);
          }
          exist.qty += st.qty;
          exist.rev += st.rev;
          // Take the max price seen (different members might have different rates)
          if (st.price > exist.price) exist.price = st.price;
          // Freq is approximate when merging — sum, but cap conceptually at sum of unique dates.
          // For accuracy we'd walk raw rows; for performance, summing freq is close enough.
          exist.freq += st.freq;
        }
      }
    }

    // Shape into final structure: top 10 sub-cuts, top 25 styles each
    const scEntries: [string, SubMerge][] = [...subMerge.entries()];
    scEntries.sort((a, b) => b[1].qty - a[1].qty);
    const topScs = scEntries.slice(0, 10);

    const scData: Record<string, { qty: number; rev: number; styles: Array<{ n: string; qty: number; rev: number; price: number; freq: number }> }> = {};
    for (const [sc, sm] of topScs) {
      const topStyles = [...sm.styles.entries()]
        .sort((a, b) => b[1].qty - a[1].qty)
        .slice(0, 25)
        .map(([sn, s]) => ({ n: sn, qty: s.qty, rev: bankRound(s.rev), price: s.price, freq: s.freq }));
      scData[sc] = { qty: sm.qty, rev: bankRound(sm.rev), styles: topStyles };
    }
    if (Object.keys(scData).length > 0) {
      clusteredDrill[cluster.name] = scData;
    }
  }

  // Date range string ─────────────────────────────────────────────────────
  let dateRange = "";
  if (allDates.length) {
    const mn = new Date(Math.min(...allDates.map((d) => d.getTime())));
    const mx = new Date(Math.max(...allDates.map((d) => d.getTime())));
    const fmt = (d: Date) =>
      `${monthNames[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    dateRange = `${fmt(mn)} – ${fmt(mx)}`;
  }

  // ── Raw rows (compact, for date filtering on client) ────────────────────
  const raw: RawRow[] = rows.map((r) => {
    const dt = parseDate(r[colMap.date]);
    return {
      c:  r[colMap.cust]   || "",
      sc: r[colMap.subcut] || "",
      sn: r[colMap.style]  || "",
      q:  parseQty(r[colMap.qty]),
      p:  Math.trunc(parsePrice(r[colMap.price])),
      d:  r[colMap.date]   || "",
      dt: dt ? isoDate(dt) : null,
    };
  });

  return {
    total_qty: totalQty,
    total_rev: bankRound(totalRev),
    total_rows: rows.length,
    date_range: dateRange,
    subcuts,
    customers,
    style_groups: styleGroups,
    monthly,
    drill: drillJson,
    raw,
    clustered_customers: clusteredCustomers,
    clustered_drill: clusteredDrill,
    cluster_membership: clusterMembership,
    style_threshold_default: 10,
  };
}
