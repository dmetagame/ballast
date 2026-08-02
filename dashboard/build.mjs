#!/usr/bin/env node
// Injects the measured mainnet dataset into the dashboard template.
//
//   node dashboard/build.mjs
//
// Reads monitor/data/*.json (produced by the scanners), merges the two venues into the
// XRP-collateralised set the dashboard shows, and writes a self-contained dashboard/index.html
// with the data inlined — no runtime fetches, so the page works from a file:// URL.

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const enosys = JSON.parse(readFileSync(join(root, "monitor/data/positions.json"), "utf8"));
const morpho = JSON.parse(readFileSync(join(root, "monitor/data/morpho-positions.json"), "utf8"));

// Liquidation cost per venue: Enosys is a 10% incentive with a 0.5 close factor;
// Morpho's incentive at 77% LLTV is ~7.4% and it permits a full liquidation.
const E = enosys.map((p) => ({
  v: "Enosys", a: p.acct, m: "FXRP → USD₮0", h: p.health, d: p.debtUSD, c: p.collUSD,
  k: p.dropToLiq, pen: 0.1, cf: 0.5,
}));
const M = morpho
  .filter((p) => p.collUSD > 0 && p.xrpCollateral)
  .map((p) => ({
    v: "Morpho", a: p.acct, m: p.market.replace(/->/, "→"), h: p.health, d: p.debtUSD,
    c: p.collUSD, k: p.dropToLiq, pen: 0.074, cf: 1.0,
  }));

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;
const positions = [...E, ...M]
  .map((p) => ({ ...p, d: round(p.d, 2), c: round(p.c, 2), h: round(p.h, 4), k: p.k === null ? null : round(p.k, 2) }))
  .sort((x, y) => x.h - y.h);

const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const meta = {
  generated: "2026-08-02",
  block: 66470000,
  xrpUsd: 1.079504,
  positions: positions.length,
  addresses: new Set(positions.map((p) => p.a)).size,
  debt: Math.round(sum(positions, (p) => p.d)),
  collateral: Math.round(sum(positions, (p) => p.c)),
};

const payload = JSON.stringify({ meta, positions });
const template = readFileSync(join(here, "template.html"), "utf8");
const out = template.replace("/*__DATA__*/null", payload);
writeFileSync(join(here, "index.html"), out);

console.log(`positions   : ${meta.positions} across ${meta.addresses} addresses`);
console.log(`debt        : $${meta.debt.toLocaleString()}`);
console.log(`wrote       : dashboard/index.html (${(out.length / 1024).toFixed(0)} KB)`);
