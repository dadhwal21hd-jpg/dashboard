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
}
