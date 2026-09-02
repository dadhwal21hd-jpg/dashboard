/**
 * Shape of a single row from the Google Sheet (after header normalisation).
 * Keys come from the CSV column mapping in processor.ts.
 */
export interface SheetRow {
  [key: string]: string;
}

/**
 * Final dashboard data shape — must match exactly what the original Python
 * processor produced, because dashboard_template.html consumes this verbatim
 * as `const DATA = ...`.
 */
export interface SubCut {
  name: string;
  qty: number;
  revenue: number;
  customers: number;
  styles: number;
}

export interface Customer {
  name: string;
  qty: number;
  revenue: number;
  sc: string[];
  vc: number;
}

export interface StyleEntry {
  n: string;
  qty: number;
  rev: number;
  price: number;
  cust: number;
}

export interface StyleGroup {
  sc: string;
  c: string;
  tq: number;
  s: StyleEntry[];
}

export interface MonthlyEntry {
  m: string;
  q: number;
}

export interface DrillStyle {
  n: string;
  qty: number;
  rev: number;
  price: number;
  freq: number;
}

export interface DrillSubCut {
  qty: number;
  rev: number;
  styles: DrillStyle[];
}

export type DrillData = Record<string, Record<string, DrillSubCut>>;

export interface RawRow {
  c: string;
  sc: string;
  sn: string;
  q: number;
  p: number;
  d: string;
  dt: string | null;
}

export interface DashboardData {
  total_qty: number;
  total_rev: number;
  total_rows: number;
  date_range: string;
  subcuts: SubCut[];
  customers: Customer[];
  style_groups: StyleGroup[];
  monthly: MonthlyEntry[];
  drill: DrillData;
  raw: RawRow[];
  /** Clustered view of customers — same shape as `customers`, members merged. */
  clustered_customers: Customer[];
  /** Drill-down data keyed by cluster name (merged across all member customers). */
  clustered_drill: DrillData;
  /** Map: original customer name → cluster name (for those that belong to a cluster). */
  cluster_membership: Record<string, string>;
  /** Default qty threshold for Style Numbers tab (UI default; user can override). */
  style_threshold_default: number;
  /** Style number → Drive folder ID. Empty when designs aren't configured. */
  _designs?: Record<string, string>;
  /** Absolute base URL of /api/design (the iframe can't use relative URLs). */
  _design_base?: string;
  /** Signed, expiring token authorising design-image reads. */
  _design_token?: string;
}
