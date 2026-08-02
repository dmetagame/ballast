import { createPublicClient, http, parseAbi } from "viem";
import { readFileSync, writeFileSync } from "fs";

const flareChain = {
  id: 14,
  name: "Flare",
  nativeCurrency: { name: "Flare", symbol: "FLR", decimals: 18 },
  rpcUrls: { default: { http: ["https://flare-api.flare.network/ext/C/rpc"] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
};
const client = createPublicClient({
  chain: flareChain,
  transport: http("https://flare-api.flare.network/ext/C/rpc"),
});

const COMPTROLLER = "0x15F69897E6aEBE0463401345543C26d1Fd994abB";
const MARKETS = [
  { name: "isoUSDT0", addr: "0xad7e7989796414c9572da9854DEb1B920724fd09", dec: 6, cf: 0.80, price: 0.998530, xrpLinked: false },
  { name: "isoFXRP",  addr: "0xD1b7A5eFa9bd88F291F7A4563a8f6185c0249CB3", dec: 6, cf: 0.70, price: 1.079504, xrpLinked: true },
  { name: "isoSTXRP", addr: "0x870f7B89F0d408D7CA2E6586Df26D00Ea03aA358", dec: 6, cf: 0.00, price: 1.079108, xrpLinked: true },
];

const snapAbi = parseAbi([
  "function getAccountSnapshot(address) view returns (uint256 err, uint256 cTokenBalance, uint256 borrowBalance, uint256 exchangeRateMantissa)",
]);
const compAbi = parseAbi([
  "function getAccountLiquidity(address) view returns (uint256 err, uint256 liquidity, uint256 shortfall)",
]);

const { all } = JSON.parse(readFileSync("accounts.json", "utf8"));
console.log("scanning", all.length, "accounts across", MARKETS.length, "markets\n");

const positions = [];
const CHUNK = 150;
for (let i = 0; i < all.length; i += CHUNK) {
  const batch = all.slice(i, i + CHUNK);
  const calls = [];
  for (const acct of batch)
    for (const m of MARKETS)
      calls.push({ address: m.addr, abi: snapAbi, functionName: "getAccountSnapshot", args: [acct] });

  const res = await client.multicall({ contracts: calls, allowFailure: true });

  batch.forEach((acct, bi) => {
    let collUSD = 0, collXrpUSD = 0, collStableUSD = 0, debtUSD = 0;
    const legs = [];
    MARKETS.forEach((m, mi) => {
      const r = res[bi * MARKETS.length + mi];
      if (r.status !== "success") return;
      const [, cBal, bBal, exRate] = r.result;
      const supplied = (Number(cBal) * Number(exRate)) / 1e18 / 10 ** m.dec;
      const borrowed = Number(bBal) / 10 ** m.dec;
      const sUSD = supplied * m.price;
      const bUSD = borrowed * m.price;
      const weighted = sUSD * m.cf;
      collUSD += weighted;
      if (m.xrpLinked) collXrpUSD += weighted; else collStableUSD += weighted;
      debtUSD += bUSD;
      if (sUSD > 0.01 || bUSD > 0.01) legs.push({ m: m.name, supplyUSD: +sUSD.toFixed(2), borrowUSD: +bUSD.toFixed(2) });
    });
    if (debtUSD > 1) {
      const health = collUSD / debtUSD;
      // how far can XRP fall before shortfall?  collStable + collXrp*k = debt
      const k = collXrpUSD > 0 ? (debtUSD - collStableUSD) / collXrpUSD : null;
      const dropToLiq = k === null ? null : 1 - k;
      positions.push({
        acct, health: +health.toFixed(4),
        collUSD: +collUSD.toFixed(2), debtUSD: +debtUSD.toFixed(2),
        collXrpUSD: +collXrpUSD.toFixed(2), collStableUSD: +collStableUSD.toFixed(2),
        dropToLiq: dropToLiq === null ? null : +(dropToLiq * 100).toFixed(2),
        legs,
      });
    }
  });
  process.stdout.write(`\r  ${Math.min(i + CHUNK, all.length)}/${all.length}  positions with debt: ${positions.length}`);
}
console.log("\n");

positions.sort((a, b) => a.health - b.health);

const live = positions.filter((p) => p.debtUSD > 1);
const totalDebt = live.reduce((s, p) => s + p.debtUSD, 0);
const totalColl = live.reduce((s, p) => s + p.collUSD, 0);

console.log("================= LIVE BORROW POSITIONS =================");
console.log("accounts with outstanding debt :", live.length);
console.log("total debt                     : $" + totalDebt.toLocaleString(undefined, { maximumFractionDigits: 0 }));
console.log("total CF-weighted collateral   : $" + totalColl.toLocaleString(undefined, { maximumFractionDigits: 0 }));

const buckets = [
  ["ALREADY LIQUIDATABLE (h<1.0)", (p) => p.health < 1.0],
  ["CRITICAL   1.0 <= h < 1.1", (p) => p.health >= 1.0 && p.health < 1.1],
  ["AT RISK    1.1 <= h < 1.25", (p) => p.health >= 1.1 && p.health < 1.25],
  ["WATCH      1.25 <= h < 1.5", (p) => p.health >= 1.25 && p.health < 1.5],
  ["SAFE       h >= 1.5", (p) => p.health >= 1.5],
];
console.log("\n--- by health factor ---");
for (const [label, fn] of buckets) {
  const g = live.filter(fn);
  const d = g.reduce((s, p) => s + p.debtUSD, 0);
  console.log(`  ${label.padEnd(30)} ${String(g.length).padStart(5)} accts   $${d.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(12)} debt`);
}

console.log("\n--- XRP price drop that triggers liquidation ---");
for (const d of [5, 10, 15, 20, 30, 40]) {
  const g = live.filter((p) => p.dropToLiq !== null && p.dropToLiq <= d && p.dropToLiq > -1e9);
  const debt = g.reduce((s, p) => s + p.debtUSD, 0);
  const coll = g.reduce((s, p) => s + p.collUSD, 0);
  console.log(`  XRP -${String(d).padStart(2)}%  =>  ${String(g.length).padStart(5)} positions liquidatable, $${debt.toLocaleString(undefined, { maximumFractionDigits: 0 })} debt / $${coll.toLocaleString(undefined, { maximumFractionDigits: 0 })} collateral`);
}

console.log("\n--- 15 riskiest positions with real size ---");
console.log("  health   dropToLiq     debtUSD      collUSD   account");
for (const p of live.filter((x) => x.debtUSD > 100).slice(0, 15)) {
  console.log(
    `  ${p.health.toFixed(3).padStart(6)}   ${String(p.dropToLiq ?? "n/a").padStart(8)}%  ${("$" + p.debtUSD.toLocaleString(undefined, { maximumFractionDigits: 0 })).padStart(11)}  ${("$" + p.collUSD.toLocaleString(undefined, { maximumFractionDigits: 0 })).padStart(11)}   ${p.acct}`
  );
}

writeFileSync("positions.json", JSON.stringify(live, null, 2));
console.log("\nwrote positions.json (" + live.length + " positions)");

// cross-check a few against comptroller.getAccountLiquidity
console.log("\n--- cross-check vs comptroller.getAccountLiquidity ---");
for (const p of live.slice(0, 5)) {
  const [, liq, short] = await client.readContract({ address: COMPTROLLER, abi: compAbi, functionName: "getAccountLiquidity", args: [p.acct] });
  console.log(`  ${p.acct}  myHealth=${p.health.toFixed(3)}  liquidity=$${(Number(liq) / 1e18).toFixed(2)}  shortfall=$${(Number(short) / 1e18).toFixed(2)}`);
}
