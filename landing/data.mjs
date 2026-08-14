#!/usr/bin/env node
// Derives the landing page's figures from the measured dataset.
//
//   node data.mjs
//
// Every number the landing renders comes from monitor/data, using the same definitions the
// dashboard uses. The two surfaces must never disagree, so this cross-checks its own output
// against the payload already embedded in dashboard/index.html and fails loudly on drift.
//
// Writes src/figures.json, which is committed. Vercel builds with a root directory of
// landing/, so the parent monitor/data may not be reachable at build time; the committed
// file is the fallback, exactly as dashboard/build.mjs falls back to the published snapshot.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const OUT = join(here, "src/figures.json");

const dataDir = join(root, "monitor/data");
if (!existsSync(join(dataDir, "positions.json"))) {
  if (!existsSync(OUT)) throw new Error("no monitor/data and no committed figures.json");
  console.log("monitor/data absent; keeping the committed figures.json");
  process.exit(0);
}

const read = (name) => JSON.parse(readFileSync(join(dataDir, name), "utf8"));

let generated = null;

// Venue liquidation parameters, matching dashboard/build.mjs. Enosys is a 10% incentive with
// a 0.5 close factor; Morpho's incentive at 77% LLTV is ~7.4% with full liquidation.
const enosys = read("positions.json").map((p) => ({
  h: p.health, d: p.debtUSD, c: p.collUSD, k: p.dropToLiq, pen: 0.1, cf: 0.5, a: p.acct,
}));
const morpho = read("morpho-positions.json")
  .filter((p) => p.collUSD > 0 && p.xrpCollateral)
  .map((p) => ({ h: p.health, d: p.debtUSD, c: p.collUSD, k: p.dropToLiq, pen: 0.074, cf: 1.0, a: p.acct }));

const positions = [...enosys, ...morpho];
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

// A position is liquidated at drop x when the XRP fall it can absorb is at or below x.
const liquidatedAt = (drop) => positions.filter((p) => p.k !== null && p.k <= drop);

const drawdown = [10, 20, 30].map((drop) => {
  const hit = liquidatedAt(drop);
  return {
    drop,
    positions: hit.length,
    debt: Math.round(sum(hit, (p) => p.d)),
    // What borrowers hand to liquidators: debt closed times the venue's incentive.
    penalties: Math.round(sum(hit, (p) => p.d * p.cf * p.pen)),
  };
});

const nearBand = positions.filter((p) => p.h >= 1 && p.h <= 1.25);

const figures = {
  generated,
  positions: positions.length,
  addresses: new Set(positions.map((p) => p.a)).size,
  debt: Math.round(sum(positions, (p) => p.d)),
  collateral: Math.round(sum(positions, (p) => p.c)),
  nearBand: { positions: nearBand.length, debt: Math.round(sum(nearBand, (p) => p.d)) },
  drawdown,
};

// Cross-check against what the dashboard actually shipped. If these drift, one of the two
// pages is publishing a wrong number, and a wrong number is the one failure this project
// cannot afford.
const dashboard = join(root, "dashboard/index.html");
if (existsSync(dashboard)) {
  const html = readFileSync(dashboard, "utf8");
  const match = html.match(/const DATA = (\{.*?\});/s);
  if (!match) throw new Error("could not read the dashboard payload for cross-check");
  const { meta } = JSON.parse(match[1]);
  generated = meta.generated;
  figures.generated = generated;
  for (const key of ["positions", "addresses", "debt", "collateral"]) {
    if (meta[key] !== figures[key]) {
      throw new Error(
        `figure drift on '${key}': landing ${figures[key]} vs dashboard ${meta[key]}. ` +
          "Rebuild the dashboard, or reconcile the definitions before publishing either.",
      );
    }
  }
  if (meta.healthBandPositions !== figures.nearBand.positions || meta.healthBandDebt !== figures.nearBand.debt) {
    throw new Error(
      `health-band drift: landing ${figures.nearBand.positions}/$${figures.nearBand.debt} ` +
        `vs dashboard ${meta.healthBandPositions}/$${meta.healthBandDebt}`,
    );
  }
  console.log("cross-check : matches dashboard/index.html");
} else {
  console.log("cross-check : skipped, dashboard/index.html not present");
}

writeFileSync(OUT, `${JSON.stringify(figures, null, 2)}\n`);
console.log(`positions   : ${figures.positions} across ${figures.addresses} addresses`);
console.log(`debt        : $${figures.debt.toLocaleString()}`);
console.log(`at -20%     : ${drawdown[1].positions} liquidated, $${drawdown[1].penalties.toLocaleString()} in penalties`);
console.log(`wrote       : src/figures.json`);
