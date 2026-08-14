#!/usr/bin/env node
// Injects the measured mainnet dataset into the dashboard template.
//
//   node dashboard/build.mjs
//
// Reads monitor/data/*.json (produced by the scanners), merges the two venues into the
// XRP-collateralised set the dashboard shows, and writes a self-contained dashboard/index.html
// with the data inlined — no runtime fetches, so the page works from a file:// URL.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Local files when present (normal development); otherwise pull the published snapshot from
// the public repo, so a hosting provider can build this without vendoring the data.
const SNAPSHOT = "https://raw.githubusercontent.com/dmetagame/ballast/main/monitor/data";

async function load(name) {
  const local = join(root, "monitor/data", name);
  if (existsSync(local)) return JSON.parse(readFileSync(local, "utf8"));
  const res = await fetch(`${SNAPSHOT}/${name}`);
  if (!res.ok) throw new Error(`cannot read ${name}: ${res.status} ${res.statusText}`);
  console.log(`  fetched ${name} from the published snapshot`);
  return res.json();
}

const enosys = await load("positions.json");
const morpho = await load("morpho-positions.json");
const snapshot = await load("snapshot.json");

const E = enosys
  .filter((p) => p.collXrpUSD > 0)
  .map((p) => ({
    v: "Enosys", a: p.acct, m: "Enosys isolated markets", h: p.health, d: p.debtUSD, c: p.collUSD,
    k: p.dropToLiq, pen: p.liquidationPenalty, cf: p.closeFactor,
  }));
const M = morpho
  .filter((p) => p.debtUSD > 1 && p.collUSD > 0 && p.xrpCollateral)
  .map((p) => ({
    v: "Morpho", a: p.acct, m: p.market.replace(/->/, "→"), h: p.health, d: p.debtUSD,
    c: p.collUSD, k: p.dropToLiq, pen: p.liquidationPenalty, cf: p.closeFactor,
  }));

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;
const measuredPositions = [...E, ...M];
const positions = measuredPositions
  .map((p) => ({ ...p, d: round(p.d, 2), c: round(p.c, 2), h: round(p.h, 4), k: p.k === null ? null : round(p.k, 2) }))
  .sort((x, y) => x.h - y.h);

const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const healthBand = measuredPositions.filter((p) => p.h >= 1 && p.h <= 1.25);
const meta = {
  generated: snapshot.generated,
  block: snapshot.blockNumber,
  blockHash: snapshot.blockHash,
  blockTimestamp: snapshot.blockTimestamp,
  xrpUsd: snapshot.prices.FXRP.usd,
  positions: positions.length,
  addresses: new Set(positions.map((p) => p.a)).size,
  debt: Math.round(sum(positions, (p) => p.d)),
  collateral: Math.round(sum(positions, (p) => p.c)),
  healthBandPositions: healthBand.length,
  healthBandDebt: Math.round(sum(healthBand, (p) => p.d)),
};

// Compact wire form: intern the repeated strings and emit rows as tuples. The venue implies
// the liquidation parameters, so they are not repeated per row. Roughly halves the page.
const VENUES = [...new Set(positions.map((p) => p.v))];
const MARKETS = [...new Set(positions.map((p) => p.m))];
const rows = positions.map((p) => [
  VENUES.indexOf(p.v), p.a, MARKETS.indexOf(p.m), p.h, p.d, p.c, p.k, p.pen, p.cf,
]);
const payload = JSON.stringify({ meta, venues: VENUES, markets: MARKETS, rows });
const template = readFileSync(join(here, "template.html"), "utf8");
const out = template
  .replace("/*__DATA__*/null", payload)
  .replace("__SNAPSHOT_BLOCK__", meta.block.toLocaleString("en-US"))
  .replace("__SNAPSHOT_DATE__", meta.generated)
  .replace("__SNAPSHOT_XRP__", meta.xrpUsd.toFixed(6))
  .replace("__SNAPSHOT_HASH__", meta.blockHash);
writeFileSync(join(here, "index.html"), out);

console.log(`positions   : ${meta.positions} across ${meta.addresses} addresses`);
console.log(`debt        : $${meta.debt.toLocaleString()}`);
console.log(`wrote       : dashboard/index.html (${(out.length / 1024).toFixed(0)} KB)`);
