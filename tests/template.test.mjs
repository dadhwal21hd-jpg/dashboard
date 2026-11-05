// Tests for pure functions inside public/dashboard_template.html.
// The template isn't a module, so each test pulls the named functions out of
// the file and runs them in a sandbox with only the globals they need.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../public/dashboard_template.html", import.meta.url), "utf8");

/** Source of `function name(...) {...}`, matched by braces. */
function fnSource(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in template`);
  let i = SRC.indexOf("{", SRC.indexOf(")", start)), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}
/** Source of `const name = ...;` (single statement). */
function constSource(name) {
  const m = SRC.match(new RegExp(`const ${name} = [^\\n]*;`));
  if (!m) throw new Error(`const ${name} not found in template`);
  return m[0];
}

function load(fns, consts = [], globals = {}) {
  const ctx = vm.createContext({ ...globals });
  vm.runInContext([...consts.map(constSource), ...fns.map(fnSource)].join("\n") +
    `\n;Object.assign(globalThis,{${[...fns, ...consts].join(",")}});`, ctx);
  return ctx;
}

// ── Financial year (Apr–Mar) ─────────────────────────────────────────────

test("fyKey puts April onwards into the next FY", () => {
  const { fyKey } = load(["fyKey"]);
  assert.equal(fyKey("2026-03-31"), "FY25-26");
  assert.equal(fyKey("2026-04-01"), "FY26-27");
  assert.equal(fyKey("2021-01-15"), "FY20-21");
  assert.equal(fyKey("1999-12-01"), "FY99-00");
  assert.equal(fyKey(""), null);
  assert.equal(fyKey(null), null);
});

test("fyRange gives 1 Apr to 31 Mar", () => {
  const { fyRange } = load(["fyRange"]);
  assert.deepEqual([...fyRange("FY25-26")], ["2025-04-01", "2026-03-31"]);
  assert.deepEqual([...fyRange("FY99-00")], ["1999-04-01", "2000-03-31"]);
});

test("FY_MONTHS runs April to March", () => {
  const { FY_MONTHS } = load([], ["FY_MONTHS"]);
  assert.deepEqual([...FY_MONTHS], [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]);
});

test("monthsLabel reads in financial-year order", () => {
  const { monthsLabel } = load(["monthsLabel"], ["MONTHS_SHORT", "FY_MONTHS"]);
  assert.equal(monthsLabel([1, 2, 3, 12]), "Dec–Mar");
  assert.equal(monthsLabel([4, 5, 6]), "Apr–Jun");
  assert.equal(monthsLabel([3, 4]), "Apr, Mar");
  assert.equal(monthsLabel([4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]), "Apr–Mar");
});

test("cmpCoverage keys the data by financial year", () => {
  const D = { raw: [{ dt: "2025-03-10" }, { dt: "2025-04-02" }, { dt: "2026-01-05" }, { dt: null }] };
  const ctx = load(["cmpCoverage", "cmpAllYears", "rowDateStr", "fyKey"], [], { D, _cmpCov: null });
  const cov = ctx.cmpCoverage();
  assert.deepEqual(Object.keys(cov).sort(), ["FY24-25", "FY25-26"]);
  assert.deepEqual([...cov["FY24-25"]], [3]);
  assert.deepEqual([...cov["FY25-26"]].sort((a, b) => a - b), [1, 4]);
  assert.deepEqual([...ctx.cmpAllYears()], ["FY24-25", "FY25-26"]);
});

// ── Customer month-on-month across financial years ───────────────────────

const ROWS = [
  { c: "SHAM", dt: "2025-04-10", q: 10, p: 100 },   // FY25-26 Apr
  { c: "SHAM", dt: "2025-04-20", q: 5, p: 100 },    // FY25-26 Apr
  { c: "SHAM", dt: "2026-03-31", q: 2, p: 50 },     // FY25-26 Mar
  { c: "SHAM", dt: "2026-04-01", q: 20, p: 100 },   // FY26-27 Apr
  { c: "SHAM", dt: null, q: 99, p: 1 },             // undated — skipped
  { c: "OTHER", dt: "2026-04-05", q: 7, p: 10 },    // not this customer
];

test("custFyMonthly buckets one customer's dispatches by FY and month", () => {
  const { custFyMonthly } = load(["custFyMonthly", "fyMonthly", "rowDateStr", "fyKey"]);
  const acc = custFyMonthly(ROWS, new Set(["SHAM"]));
  assert.deepEqual(Object.keys(acc).sort(), ["FY25-26", "FY26-27"]);
  assert.deepEqual({ ...acc["FY25-26"][4] }, { q: 15, rev: 1500 });
  assert.deepEqual({ ...acc["FY25-26"][3] }, { q: 2, rev: 100 });
  assert.deepEqual({ ...acc["FY26-27"][4] }, { q: 20, rev: 2000 });
  assert.equal(acc["FY26-27"][5], undefined);
});

test("custFyMonthly adds up every member of a cluster", () => {
  const { custFyMonthly } = load(["custFyMonthly", "fyMonthly", "rowDateStr", "fyKey"]);
  const acc = custFyMonthly(ROWS, new Set(["SHAM", "OTHER"]));
  assert.deepEqual({ ...acc["FY26-27"][4] }, { q: 27, rev: 2070 });
});

test("fyCompareRows lines months up Apr→Mar with totals and change", () => {
  const { custFyMonthly, fyCompareRows } = load(["custFyMonthly", "fyMonthly", "fyCompareRows", "rowDateStr", "fyKey"], ["FY_MONTHS"]);
  const acc = custFyMonthly(ROWS, new Set(["SHAM"]));
  // Coverage: FY26-27 only has data up to April so far.
  const cov = { "FY25-26": new Set([4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]), "FY26-27": new Set([4]) };
  const T = fyCompareRows(acc, ["FY25-26", "FY26-27"], cov, "rev");
  assert.equal(T.rows.length, 12);
  assert.equal(T.rows[0].m, 4);
  assert.equal(T.rows[11].m, 3);
  assert.deepEqual([...T.rows[0].v], [1500, 2000]);
  assert.equal(T.rows[0].delta, (2000 - 1500) / 1500);
  // May: nothing from SHAM last year, and FY26-27 has no data yet at all → null, not 0
  assert.deepEqual([...T.rows[1].v], [0, null]);
  assert.equal(T.rows[1].delta, null);
  // March: only last year
  assert.deepEqual([...T.rows[11].v], [100, null]);
  assert.deepEqual([...T.totals], [1600, 2000]);
  // Like-for-like: last year's total over only the months the newest FY has
  assert.equal(T.sameMonthsPrev, 1500);
});

test("fyCompareRows can rank by units", () => {
  const { custFyMonthly, fyCompareRows } = load(["custFyMonthly", "fyMonthly", "fyCompareRows", "rowDateStr", "fyKey"], ["FY_MONTHS"]);
  const acc = custFyMonthly(ROWS, new Set(["SHAM"]));
  const cov = { "FY25-26": new Set([4, 3]), "FY26-27": new Set([4]) };
  const T = fyCompareRows(acc, ["FY25-26", "FY26-27"], cov, "q");
  assert.deepEqual([...T.rows[0].v], [15, 20]);
  assert.deepEqual([...T.totals], [17, 20]);
});

test("fyCompareRows with one FY has no change column", () => {
  const { custFyMonthly, fyCompareRows } = load(["custFyMonthly", "fyMonthly", "fyCompareRows", "rowDateStr", "fyKey"], ["FY_MONTHS"]);
  const acc = custFyMonthly(ROWS, new Set(["SHAM"]));
  const T = fyCompareRows(acc, ["FY26-27"], { "FY26-27": new Set([4]) }, "rev");
  assert.equal(T.rows[0].delta, null);
  assert.equal(T.sameMonthsPrev, null);
});

// ── Sub cut / style month-on-month ───────────────────────────────────────

const SC_ROWS = [
  { c: "SHAM", sc: "SGONC", sn: "84752", dt: "2025-05-02", q: 4, p: 1000 },
  { c: "SHAM", sc: "SGONC", sn: "84752", dt: "2026-05-09", q: 6, p: 1000 },
  { c: "SHAM", sc: "SGONC", sn: "90001", dt: "2026-05-11", q: 1, p: 500 },
  { c: "SHAM", sc: "OTHER", sn: "11111", dt: "2026-05-11", q: 9, p: 10 },
  { c: "RAJ", sc: "SGONC", sn: "84752", dt: "2026-05-20", q: 3, p: 1000 },
];

test("fyMonthly keeps only the rows asked for", () => {
  const { fyMonthly } = load(["fyMonthly", "rowDateStr", "fyKey"]);
  const acc = fyMonthly(SC_ROWS, r => r.sc === "SGONC");
  assert.deepEqual({ ...acc["FY25-26"][5] }, { q: 4, rev: 4000 });
  assert.deepEqual({ ...acc["FY26-27"][5] }, { q: 10, rev: 9500 });
  const one = fyMonthly(SC_ROWS, r => r.sc === "SGONC" && r.c === "SHAM" && r.sn === "84752");
  assert.deepEqual({ ...one["FY26-27"][5] }, { q: 6, rev: 6000 });
});

test("scStyleList ranks a sub cut's styles by units", () => {
  const { scStyleList } = load(["scStyleList"]);
  const list = scStyleList(SC_ROWS.filter(r => r.sc === "SGONC"));
  assert.deepEqual(JSON.parse(JSON.stringify(list.map(s => [s.sn, s.q]))), [["84752", 13], ["90001", 1]]);
});

test("drillFyDefault picks the customer's latest two FYs", () => {
  const { drillFyDefault } = load(["drillFyDefault"]);
  assert.deepEqual([...drillFyDefault(["FY22-23", "FY24-25", "FY25-26"])], ["FY24-25", "FY25-26"]);
  assert.deepEqual([...drillFyDefault(["FY25-26"])], ["FY25-26"]);
  assert.deepEqual([...drillFyDefault([])], []);
});

test("fyOfRange recognises a whole financial year in From/To", () => {
  const { fyOfRange } = load(["fyOfRange", "fyKey", "fyRange"]);
  assert.equal(fyOfRange("2025-04-01", "2026-03-31"), "FY25-26");
  assert.equal(fyOfRange("2025-01-01", "2025-12-31"), null);
  assert.equal(fyOfRange("2025-04-01", ""), null);
  assert.equal(fyOfRange("", ""), null);
});

test("fyMonthKey turns an FY month back into a calendar month", () => {
  const { fyMonthKey } = load(["fyMonthKey", "fyRange"]);
  assert.equal(fyMonthKey("FY25-26", 12), "2025-12");
  assert.equal(fyMonthKey("FY25-26", 1), "2026-01");
  assert.equal(fyMonthKey("FY26-27", 4), "2026-04");
  assert.equal(fyMonthKey("FY26-27", 3), "2027-03");
});
