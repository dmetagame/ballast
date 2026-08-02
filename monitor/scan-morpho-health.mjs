import { createPublicClient, http, parseAbi } from "viem";
import { readFileSync, writeFileSync } from "fs";

const EXPLORER = "https://flare-explorer.flare.network/api";
const MORPHO = "0xF4346F5132e810f80a28487a79c7559d9797E8B0";
const TOPIC_BORROW = "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43";
const TOPIC_SUPPLYCOLL = "0xa3b9472a1399e17e123f3c2e6586c23e504184d504de59cdaa2b375e880c6184";
const CAP = 1000, START = 40_000_000, HEAD = 66_471_000;

const flare = {
  id: 14, name: "Flare",
  nativeCurrency: { name: "Flare", symbol: "FLR", decimals: 18 },
  rpcUrls: { default: { http: ["https://flare-api.flare.network/ext/C/rpc"] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
};
const client = createPublicClient({ chain: flare, transport: http() });

// USD prices (FTSO-derived, 2026-08-02)
const USD = { "FXRP": 1.079504, "USD₮0": 0.998530, "WFLR": 0.006282, "stXRP": 1.079108, "PT-stXRP(FXRP)-2026/06/04": 1.079504 };
const XRP_LINKED = new Set(["FXRP", "stXRP", "PT-stXRP(FXRP)-2026/06/04"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchWindow(addr, topic0, from, to, t = 0) {
  try {
    const j = await (await fetch(`${EXPLORER}?module=logs&action=getLogs&fromBlock=${from}&toBlock=${to}&address=${addr}&topic0=${topic0}`)).json();
    if (Array.isArray(j.result)) return j.result;
    if (/no logs/i.test(j.message || "")) return [];
    throw new Error(j.message);
  } catch (e) {
    if (t < 3) { await sleep(700 * (t + 1)); return fetchWindow(addr, topic0, from, to, t + 1); }
    return [];
  }
}
async function scan(addr, topic0, from, to) {
  const logs = await fetchWindow(addr, topic0, from, to);
  if (logs.length < CAP || to - from <= 1) return logs;
  const mid = Math.floor((from + to) / 2);
  return [...(await scan(addr, topic0, from, mid)), ...(await scan(addr, topic0, mid + 1, to))];
}

const markets = JSON.parse(readFileSync("morpho-markets.json", "utf8"));
const byId = Object.fromEntries(markets.map((m) => [m.id.toLowerCase(), m]));

console.log("scanning Morpho Borrow + SupplyCollateral events...");
const [bLogs, sLogs] = [await scan(MORPHO, TOPIC_BORROW, START, HEAD), await scan(MORPHO, TOPIC_SUPPLYCOLL, START, HEAD)];
const seen = new Set();
const pairs = new Map(); // marketId -> Set(account)
const add = (id, acct) => {
  const k = id.toLowerCase();
  if (!pairs.has(k)) pairs.set(k, new Set());
  pairs.get(k).add(acct.toLowerCase());
};
let bCount = 0, sCount = 0;
for (const [logs, isB] of [[bLogs, true], [sLogs, false]]) {
  for (const l of logs) {
    const k = l.transactionHash + ":" + l.logIndex;
    if (seen.has(k)) continue;
    seen.add(k);
    isB ? bCount++ : sCount++;
    add(l.topics[1], "0x" + l.topics[2].slice(26)); // onBehalf
  }
}
console.log(`  -> ${bCount} Borrow events, ${sCount} SupplyCollateral events`);
console.log(`  -> ${pairs.size} markets touched, ${[...pairs.values()].reduce((s, x) => s + x.size, 0)} (market,account) pairs\n`);

const posAbi = parseAbi([
  "function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
]);

const positions = [];
for (const [id, accts] of pairs) {
  const m = byId[id];
  if (!m) { console.log("  unknown market", id); continue; }
  const tbA = BigInt(m.totalBorrowAssets), tbS = BigInt(m.totalBorrowShares);
  if (tbS === 0n) continue;
  const list = [...accts];
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const res = await client.multicall({
      contracts: chunk.map((a) => ({ address: MORPHO, abi: posAbi, functionName: "position", args: [m.id, a] })),
      allowFailure: true,
    });
    chunk.forEach((acct, j) => {
      const r = res[j];
      if (r.status !== "success") return;
      const [, borrowShares, collateral] = r.result;
      if (borrowShares === 0n) return;
      const borrowAssetsRaw = (BigInt(borrowShares) * tbA + tbS - 1n) / tbS; // round up
      const debt = Number(borrowAssetsRaw) / 10 ** m.loanDec;
      const coll = Number(collateral) / 10 ** m.collDec;
      const debtUSD = debt * (USD[m.loanSym] ?? 0);
      const collUSD = coll * (USD[m.collSym] ?? 0);
      const lltv = Number(m.lltv) / 1e18;
      const health = debtUSD > 0 ? (collUSD * lltv) / debtUSD : Infinity;
      const collX = XRP_LINKED.has(m.collSym), loanX = XRP_LINKED.has(m.loanSym);
      // liquidation when collUSD*k_c*lltv < debtUSD*k_d ; k = XRP multiplier
      let dropToLiq = null;
      if (collX && !loanX) dropToLiq = health > 0 ? (1 - 1 / health) * 100 : null;
      else if (collX && loanX) dropToLiq = null;      // both scale together: XRP-neutral
      else if (!collX && loanX) dropToLiq = null;      // hurt by XRP *rising*, not falling
      positions.push({
        market: `${m.collSym} -> ${m.loanSym}`, id: m.id, acct,
        lltvPct: +(lltv * 100).toFixed(0),
        collUSD: +collUSD.toFixed(2), debtUSD: +debtUSD.toFixed(2),
        health: +health.toFixed(4),
        dropToLiq: dropToLiq === null ? null : +dropToLiq.toFixed(2),
        xrpCollateral: collX, xrpDebt: loanX,
      });
    });
  }
  process.stdout.write(`\r  scored ${positions.length} positions...`);
}
console.log("\n");

positions.sort((a, b) => a.health - b.health);
const totalDebt = positions.reduce((s, p) => s + p.debtUSD, 0);
const xrpColl = positions.filter((p) => p.xrpCollateral);
const xrpOnly = positions.filter((p) => p.dropToLiq !== null);

console.log("============== MORPHO ON FLARE: LIVE BORROW POSITIONS ==============");
console.log("positions with debt            :", positions.length);
console.log("total debt                     : $" + totalDebt.toLocaleString(undefined, { maximumFractionDigits: 0 }));
console.log("positions w/ XRP-linked collateral:", xrpColl.length, "  debt $" + xrpColl.reduce((s, p) => s + p.debtUSD, 0).toLocaleString(undefined, { maximumFractionDigits: 0 }));
console.log("  of which exposed to XRP falling :", xrpOnly.length, "  debt $" + xrpOnly.reduce((s, p) => s + p.debtUSD, 0).toLocaleString(undefined, { maximumFractionDigits: 0 }));

console.log("\n--- per market ---");
const byMkt = {};
for (const p of positions) {
  byMkt[p.market] ??= { n: 0, debt: 0, coll: 0 };
  byMkt[p.market].n++; byMkt[p.market].debt += p.debtUSD; byMkt[p.market].coll += p.collUSD;
}
for (const [k, v] of Object.entries(byMkt).sort((a, b) => b[1].debt - a[1].debt))
  console.log(`  ${k.padEnd(34)} ${String(v.n).padStart(4)} pos  $${v.debt.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(12)} debt  $${v.coll.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(12)} coll`);

console.log("\n--- health buckets (XRP-collateral positions) ---");
for (const [label, fn] of [
  ["LIQUIDATABLE h<1.0", (p) => p.health < 1.0],
  ["CRITICAL 1.0-1.1", (p) => p.health >= 1.0 && p.health < 1.1],
  ["AT RISK  1.1-1.25", (p) => p.health >= 1.1 && p.health < 1.25],
  ["WATCH    1.25-1.5", (p) => p.health >= 1.25 && p.health < 1.5],
  ["SAFE     h>=1.5", (p) => p.health >= 1.5],
]) {
  const g = xrpColl.filter(fn);
  console.log(`  ${label.padEnd(20)} ${String(g.length).padStart(4)} pos   $${g.reduce((s, p) => s + p.debtUSD, 0).toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(12)} debt`);
}

console.log("\n--- XRP drop that triggers liquidation (Morpho only) ---");
for (const d of [5, 10, 15, 20, 30]) {
  const g = xrpOnly.filter((p) => p.dropToLiq <= d);
  console.log(`  XRP -${String(d).padStart(2)}%  =>  ${String(g.length).padStart(4)} positions, $${g.reduce((s, p) => s + p.debtUSD, 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} debt`);
}

console.log("\n--- 15 riskiest XRP-collateral positions ---");
console.log("  health  dropToLiq       debtUSD       collUSD  market                          account");
for (const p of xrpOnly.filter((x) => x.debtUSD > 500).slice(0, 15))
  console.log(`  ${p.health.toFixed(3).padStart(6)}  ${String(p.dropToLiq).padStart(8)}%  ${("$" + p.debtUSD.toLocaleString(undefined, { maximumFractionDigits: 0 })).padStart(12)}  ${("$" + p.collUSD.toLocaleString(undefined, { maximumFractionDigits: 0 })).padStart(12)}  ${p.market.padEnd(30)} ${p.acct}`);

writeFileSync("morpho-positions.json", JSON.stringify(positions, null, 2));
console.log("\nwrote morpho-positions.json");
