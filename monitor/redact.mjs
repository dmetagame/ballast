#!/usr/bin/env node
// Redacts borrower addresses in the published data snapshot.
//
//   node monitor/redact.mjs
//
// The scanners need full addresses at runtime — they call `getAccountLiquidity` and
// `position(id, user)` with them. What gets committed does not. This rewrites the result
// files in place so every borrower is identified only by a truncated label.
//
// These positions are public on-chain state and anyone can recompute them, but a ranked
// list of who is closest to liquidation is directly useful to a liquidation bot, and
// publishing one is a different act from the data merely existing. Aggregates are unchanged.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, "data");

const isFull = (s) => typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
const shorten = (a) => a.slice(0, 6) + "…" + a.slice(-4);

/** Truncate, but refuse to collapse two distinct addresses onto one label. */
function buildMap(addresses) {
  const map = new Map();
  const taken = new Map(); // label -> full address
  for (const full of addresses) {
    if (map.has(full)) continue;
    let label = shorten(full);
    if (taken.has(label) && taken.get(label) !== full) {
      // Widen until unique so counts of distinct addresses stay exact.
      for (let n = 5; n <= 20; n++) {
        label = full.slice(0, 2 + n) + "…" + full.slice(-4);
        if (!taken.has(label)) break;
      }
      if (taken.has(label)) throw new Error(`cannot disambiguate ${full}`);
    }
    taken.set(label, full);
    map.set(full, label);
  }
  return map;
}

const FILES = [
  { name: "positions.json", key: "acct" },
  { name: "morpho-positions.json", key: "acct" },
];

let touched = 0;
for (const { name, key } of FILES) {
  const path = join(DATA, name);
  if (!existsSync(path)) {
    console.log(`  skip     ${name} (not present)`);
    continue;
  }
  const rows = JSON.parse(readFileSync(path, "utf8"));
  const full = rows.map((r) => r[key]).filter(isFull);
  if (full.length === 0) {
    console.log(`  already  ${name} (${rows.length} rows, no full addresses)`);
    continue;
  }
  const map = buildMap(full);
  for (const r of rows) if (isFull(r[key])) r[key] = map.get(r[key]);
  writeFileSync(path, JSON.stringify(rows, null, 2));
  console.log(`  redacted ${name}: ${map.size} distinct addresses across ${rows.length} rows`);
  touched++;
}

console.log(touched ? "\ndone — rebuild the dashboard with: node dashboard/build.mjs" : "\nnothing to do");
