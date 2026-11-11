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

export function parsePrice(p: unknown): number {
  const s = String(p ?? "").trim().replace(/,/g, "");
  const m = s.match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

export function parseQty(q: unknown): number {
  const s = String(q ?? "").trim().replace(/,/g, "");
  if (!s) return 0;
  const v = parseFloat(s);
  if (!Number.isFinite(v)) return 0;
  const i = Math.trunc(v);
  return i > 0 ? i : 0;
}

export function bankRound(n: number): number {
  const floor = Math.floor(n);
  const diff = n - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

const MONTH_ABBR: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"];

function parseOracleDate(s: string): Date | null {
  const m = s.match(/^(\d{1,2})[/-]([A-Za-z]{3,9})[/-](\d{2,4})$/);
  if (!m) return null;
  const word = m[2].toLowerCase();
  const mo = MONTH_ABBR[word.slice(0, 3)];
  if (!mo || !MONTH_NAMES[mo - 1].startsWith(word)) return null;
  const day = parseInt(m[1], 10);
  const yRaw = parseInt(m[3], 10);
  const y = m[3].length === 2 ? 2000 + yRaw : yRaw;
  if (day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, day));
  if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === day) {
    return dt;
  }
  return null;
}

export function parseDate(d: unknown): Date | null {
  let s = String(d ?? "").trim();
  if (!s) return null;

  // 1. Handle Google Sheets Serial Dates (e.g. 45397 for April 15, 2024)
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = parseFloat(s);
    return new Date(Date.UTC(1899, 11, 30 + Math.floor(serial)));
  }

  // 2. Strip timestamps
  s = s.replace(/[T ]\d{1,2}:\d{2}.*$/, '').trim();

  const oracle = parseOracleDate(s);
  if (oracle) return oracle;

  // 3. Regex Patterns
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => [number, number, number]]> = [
    [/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2}|\d{4})$/, (m) => {
      let y = parseInt(m[3], 10);
      if (y < 100) y += 2000;
      const p1 = parseInt(m[1], 10);
      const p2 = parseInt(m[2], 10);
      // If middle number > 12, it MUST be mm/dd/yyyy
      if (p2 > 12) return [y, p1, p2];
      return [y, p2, p1]; // Default to dd/mm/yyyy
    }],
    [/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/, (m) => [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]]
  ];

  for (const [re, build] of patterns) {
    const m = s.match(re);
    if (m) {
      const [y, mo, day] = build(m);
      if (mo < 1 || mo > 12 || day < 1 || day > 31) continue;
      const dt = new Date(Date.UTC(y, mo - 1, day));
      if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === day) {
        return dt;
      }
    }
  }
  // No catch-all fallback: new Date("1") is 1 Jan 2001, so a junk cell would
  // land in 2001 instead of staying undated.
  return null;
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseDesign(s: unknown): { subcut: string; style: string } | null {
  const raw = String(s ?? "").trim();
  if (!raw) return null;
  const noPrefix = raw.replace(/^[A-Za-z]+-/, "");
  const dot = noPrefix.indexOf(".");
  if (dot === -1) return { subcut: "", style: noPrefix };
  const subcut = noPrefix.slice(0, dot).trim();
  const style = noPrefix.slice(dot + 1).trim();
  if (!style) return null;
  return { subcut, style };
}

// ─── COLUMN DETECTION ───────────────────────────────────────────────────────

const NEEDED: Record<string, string[]> = {
  qty:   ["qty", "quantity", "units"],
  cust:  ["order sent to", "customer", "order_sent_to", "party", "buyer name"],
  price: ["price", "mrp", "rate", "bp"],
  date:  ["customer dispatch date", "dispatch date", "date", "dispatch_date", "bill dt."],
};
const STYLE_ALIASES     = ["style number", "style_number", "style no", "style"];
const SUBCUT_ALIASES    = ["sub cut style", "sub_cut_style", "subcut", "cut style", "sub cut"];
const DESIGN_ALIASES    = ["design"];
const ITEM_DESC_ALIASES = ["item description", "item_description"];
const REMARKS_ALIASES   = ["remarks"];

interface ColumnMap {
  qty: string;
  cust: string;
  price: string;
  date: string;
  style?: string;
  subcut?: string;
  design?: string;
  itemDesc?: string;
  remarks?: string;
}

function detectColumns(headers: string[], sourceLabel: string): ColumnMap {
  const headersLower: Record<string, string> = {};
  for (const h of headers) headersLower[h.toLowerCase().trim()] = h;

  const colMap: Partial<ColumnMap> = {};
  for (const [key, candidates] of Object.entries(NEEDED)) {
    for (const c of candidates) {
      if (c in headersLower) { (colMap as Record<string, string>)[key] = headersLower[c]; break; }
    }
    if (!(key in colMap)) {
      throw new Error(
        `${sourceLabel}: cannot find column for '${key}'. Found columns: ${headers.join(", ")}`,
      );
    }
  }

  for (const c of STYLE_ALIASES)     if (c in headersLower) { colMap.style    = headersLower[c]; break; }
  for (const c of SUBCUT_ALIASES)    if (c in headersLower) { colMap.subcut   = headersLower[c]; break; }
  for (const c of DESIGN_ALIASES)    if (c in headersLower) { colMap.design   = headersLower[c]; break; }
  for (const c of ITEM_DESC_ALIASES) if (c in headersLower) { colMap.itemDesc = headersLower[c]; break; }
  for (const c of REMARKS_ALIASES)   if (c in headersLower) { colMap.remarks  = headersLower[c]; break; }

  if (!colMap.style && !colMap.design) {
    throw new Error(
      `${sourceLabel}: cannot find a style-number column, or a "Design" column to derive one from. Found columns: ${headers.join(", ")}`,
    );
  }

  return colMap as ColumnMap;
}

export type Brand = "kk" | "rstudio" | "labotanica" | "unstitched" | "other" | "unknown";

export function classifyBrand(
  itemDesc: string | undefined,
  sn: string,
  ctx: { design?: string; remarks?: string } = {},
): Brand {
  if (itemDesc !== undefined) {
    const d = itemDesc.trim().toUpperCase();
    if (!d) return "unknown";
    if (d.includes("GOWN")) return d.startsWith("KK") ? "kk" : "rstudio";
    if (d.startsWith("DUPATTA")) return "other";           

    const design = (ctx.design ?? "").trim();
    const remarks = (ctx.remarks ?? "").trim();

    if (d.startsWith("SAAR") || d.startsWith("RAAS")) return "unstitched";
    if (/^E-/i.test(design)) return "unstitched";
    if (/^[A-Za-z]-/.test(design) || remarks || d.includes("FABRIC")) return "labotanica";
    
    const digits = design.match(/\d+/);
    if (digits && (digits[0].length === 4 || digits[0].length === 5)) return "unstitched";
    return "labotanica";
  }
  const s = String(sn || "").trim();
  if (!s) return "unknown";
  if (/^(NR|CH)-?/i.test(s)) return "rstudio";
  if (/^\d+$/.test(s)) return Number(s) < 50000 ? "kk" : "rstudio";
  return "unknown";
}

function fabricName(itemDesc: string | undefined): string {
  const words = String(itemDesc ?? "").toUpperCase().replace(/[\[\]]/g, " ").split(/\s+/)
    .filter((w) => w && !/^[\d.]+$/.test(w));
  return words.slice(0, 2).join(" ").replace(/[.,]+$/, "") || "FABRIC";
}

interface ParsedRow {
  cust: string;
  sc: string;
  sn: string;
  qty: number;
  price: number;
  date: string;
  brand: Brand;
}

const SUBCUT_SAME: Record<string, string> = { AKE: "AK", SGO: "SG", LCO: "LC" };

function extractRow(colMap: ColumnMap, r: SheetRow): ParsedRow {
  const qty   = parseQty(r[colMap.qty]);
  const price = parsePrice(r[colMap.price]);
  const cust  = (r[colMap.cust] || "Unknown").trim() || "Unknown";
  const date  = (r[colMap.date] || "").trim();

  let sc: string, sn: string;
  if (colMap.style) {
    sn = (r[colMap.style] || "Unknown").trim() || "Unknown";
    sc = (colMap.subcut ? r[colMap.subcut] : "") || "Unknown";
    sc = sc.trim() || "Unknown";
  } else {
    const parsed = parseDesign(r[colMap.design!]);
    sn = parsed?.style || "Unknown";
    sc = parsed?.subcut || "Unknown";
  }

  sc = SUBCUT_SAME[sc.toUpperCase()] ?? sc;

  const itemDesc = colMap.itemDesc ? r[colMap.itemDesc] : undefined;
  const design = colMap.design ? String(r[colMap.design] ?? "").trim() : "";
  const remarks = colMap.remarks ? String(r[colMap.remarks] ?? "").trim() : "";
  const brand = classifyBrand(itemDesc, sn, { design, remarks });

  const code = design
    .replace(/(?:\s*(?:[[\]]\s*(?:SOLO|NK|WN)\s*[[\]]?|(?:SOLO|NK|WN)\s*[[\]]|SOLO))+\s*$/i, "")
    .trim();
  if (brand === "labotanica") {
    sn = code || "Unknown";
    sc = fabricName(itemDesc);
  } else if (brand === "unstitched") {
    sn = code || "Unknown";
    sc = fabricName((itemDesc ?? "").replace(/^\s*(SAARR?|RAAS)\s+/i, ""));
  }
  return { cust, sc, sn, qty, price, date, brand };
}

// ─── MAIN PROCESSOR ─────────────────────────────────────────────────────────

const EXCLUDED_BUYERS = new Set(["CHANGE BARCODE", "CANCEL"]);

function isExcludedBuyer(name: unknown): boolean {
  return EXCLUDED_BUYERS.has(String(name ?? "").trim().toUpperCase());
}

export function process(
  rowsIn: SheetRow[],
  returnRowsIn: SheetRow[] = [],
  opts: { skipReturnBrands?: Brand[]; dropBrands?: Brand[] } = {},
): DashboardData {
  if (!rowsIn.length) {
    throw new Error("Sheet has no data rows.");
  }

  const colMap = detectColumns(Object.keys(rowsIn[0]), "Sales sheet");
  const returnsColMap = returnRowsIn.length
    ? detectColumns(Object.keys(returnRowsIn[0]), "Goods Return sheet")
    : null;

  // dropBrands: gone from sales AND returns, everywhere. skipReturnBrands: returns only.
  const drop = new Set(opts.dropBrands ?? []);
  const skipRet = new Set([...(opts.skipReturnBrands ?? []), ...drop]);
  let rows = rowsIn.filter((r) => !isExcludedBuyer(r[colMap.cust]) &&
    !(drop.size && drop.has(extractRow(colMap, r).brand)));
  let returnRows = returnsColMap
    ? returnRowsIn.filter((r) => !isExcludedBuyer(r[returnsColMap.cust]) &&
        !(skipRet.size && skipRet.has(extractRow(returnsColMap, r).brand)))
    : returnRowsIn;

  const nameKey = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  const spellings = new Map<string, Map<string, number>>();
  const countName = (s: unknown, w: number) => {
    const raw = String(s ?? "").trim();
    if (!raw) return;
    const m = spellings.get(nameKey(raw)) ?? new Map<string, number>();
    m.set(raw, (m.get(raw) ?? 0) + w);
    spellings.set(nameKey(raw), m);
  };
  for (const r of rows) countName(r[colMap.cust], 1);
  if (returnsColMap) for (const r of returnRows) countName(r[returnsColMap.cust], 0);
  const canon = new Map<string, string>();
  for (const m of spellings.values()) {
    if (m.size < 2) continue;
    const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    for (const raw of m.keys()) if (raw !== best) canon.set(raw, best);
  }
  if (canon.size) {
    const fold = (r: SheetRow, col: string): SheetRow => {
      const to = canon.get(String(r[col] ?? "").trim());
      return to ? { ...r, [col]: to } : r;
    };
    rows = rows.map((r) => fold(r, colMap.cust));
    if (returnsColMap) returnRows = returnRows.map((r) => fold(r, returnsColMap.cust));
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
    const { cust, sc, sn, qty, price, date } = extractRow(colMap, r);
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

  const returns: RawRow[] = [];
  if (returnsColMap) {
    for (const r of returnRows) {
      const { cust, sc, sn, qty, price, date, brand } = extractRow(returnsColMap, r);
      const rev = qty * price;
      totalQty -= qty;
      totalRev -= rev;

      const sub = getSub(sc);
      sub.qty -= qty; sub.rev -= rev;

      const cu = getCust(cust);
      cu.qty -= qty; cu.rev -= rev;

      const st = getStyle(sn);
      st.qty -= qty; st.rev -= rev;

      const dr = getDrill(cust, sc, sn);
      dr.qty -= qty; dr.rev -= rev;

      const dt = parseDate(date);
      returns.push({
        c: cust, sc, sn, q: qty, p: Math.trunc(price),
        d: date, dt: dt ? isoDate(dt) : null, br: brand,
      });
    }
  }

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

  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthly: MonthlyEntry[] = [...monthlyAcc.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, q]) => {
      const [y, mo] = k.split("-");
      return { m: `${monthNames[parseInt(mo) - 1]} ${y.slice(2)}`, q };
    });

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

  const clusterLookup = buildClusterLookup();
  const clusterMembership: Record<string, string> = {};
  for (const c of customers) {
    const cluster = clusterFor(c.name, clusterLookup);
    if (cluster) clusterMembership[c.name] = cluster;
  }

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
      agg.memberCount += 1;
    } else {
      standaloneCustomers.push(c);
    }
  }

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

  const clusterCustomerRows: Customer[] = [...clusterAgg.entries()].map(([name, v]) => ({
    name,
    qty: v.qty,
    revenue: v.rev,
    sc: [...v.scs].sort(),
    vc: clusterStyleSets.get(name)?.size ?? 0,
  }));

  const clusteredCustomers: Customer[] = [...clusterCustomerRows, ...standaloneCustomers]
    .sort((a, b) => b.qty - a.qty);

  const clusteredDrill: DrillData = {};
  for (const cluster of CLUSTERS) {
    const members = cluster.members
      .map((m) => {
        const found = customers.find((c) => c.name.trim().toLowerCase() === m.trim().toLowerCase());
        return found?.name;
      })
      .filter((m): m is string => !!m);

    if (members.length === 0) continue;

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
          if (st.price > exist.price) exist.price = st.price;
          exist.freq += st.freq;
        }
      }
    }

    const scEntries: [string, SubMerge][] = [...subMerge.entries()];
    scEntries.sort((a, b) => b[1].qty - a[1].qty);
    const topScs = scEntries.slice(0, 10);

    const scData: Record<string, { qty: number; rev: number; styles: Array<{ n: string; qty: number; rev: number; price: number; freq: number }> }> = {};
    for (const [sc, sm] of topScs) {
      const topStyles = [...sm.styles.entries()]
        .sort((a, b) => b[1].qty - a[1].qty)
        .map(([sn, s]) => ({ n: sn, qty: s.qty, rev: bankRound(s.rev), price: s.price, freq: s.freq }));
      scData[sc] = { qty: sm.qty, rev: bankRound(sm.rev), styles: topStyles };
    }
    if (Object.keys(scData).length > 0) {
      clusteredDrill[cluster.name] = scData;
    }
  }

  let dateRange = "";
  if (allDates.length) {
    const mn = new Date(Math.min(...allDates.map((d) => d.getTime())));
    const mx = new Date(Math.max(...allDates.map((d) => d.getTime())));
    const fmt = (d: Date) =>
      `${monthNames[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    dateRange = `${fmt(mn)} – ${fmt(mx)}`;
  }

  const raw: RawRow[] = rows.map((r) => {
    const { cust, sc, sn, qty, price, date, brand } = extractRow(colMap, r);
    const dt = parseDate(date);
    return {
      c: cust, sc, sn,
      q: qty,
      p: Math.trunc(price),
      d: date,
      dt: dt ? isoDate(dt) : null,
      br: brand,
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
    returns_raw: returns,
    clustered_customers: clusteredCustomers,
    clustered_drill: clusteredDrill,
    cluster_membership: clusterMembership,
    style_threshold_default: 0,
  };
}