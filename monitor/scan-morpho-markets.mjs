import { createPublicClient, http, parseAbi } from "viem";
import { writeFileSync } from "fs";

const EXPLORER = "https://flare-explorer.flare.network/api";
const MORPHO = "0xF4346F5132e810f80a28487a79c7559d9797E8B0";
const FXRP = "0xad552a648c74d49e10027ab8a618a3ad4901c5be";
const TOPIC_CREATE = "0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac";
const CAP = 1000, START = 40_000_000, HEAD = 66_471_000;

const flare = {
  id: 14, name: "Flare",
  nativeCurrency: { name: "Flare", symbol: "FLR", decimals: 18 },
  rpcUrls: { default: { http: ["https://flare-api.flare.network/ext/C/rpc"] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
};
const client = createPublicClient({ chain: flare, transport: http() });

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

console.log("scanning Morpho CreateMarket events...");
const logs = await scan(MORPHO, TOPIC_CREATE, START, HEAD);
const seen = new Set();
const markets = [];
for (const l of logs) {
  const k = l.transactionHash + ":" + l.logIndex;
  if (seen.has(k)) continue;
  seen.add(k);
  const id = l.topics[1];
  const d = l.data.replace(/^0x/, "");
  const w = (i) => d.slice(i * 64, (i + 1) * 64);
  markets.push({
    id,
    loanToken: "0x" + w(0).slice(24),
    collateralToken: "0x" + w(1).slice(24),
    oracle: "0x" + w(2).slice(24),
    irm: "0x" + w(3).slice(24),
    lltv: BigInt("0x" + w(4)),
    block: parseInt(l.blockNumber, 16),
  });
}
console.log(`  -> ${markets.length} markets created\n`);

const erc = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const mAbi = parseAbi([
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);
const oAbi = parseAbi(["function price() view returns (uint256)"]);

const meta = {};
async function tok(a) {
  if (meta[a]) return meta[a];
  try {
    const [s, d] = await Promise.all([
      client.readContract({ address: a, abi: erc, functionName: "symbol" }),
      client.readContract({ address: a, abi: erc, functionName: "decimals" }),
    ]);
    meta[a] = { symbol: s, decimals: Number(d) };
  } catch { meta[a] = { symbol: "?", decimals: 18 }; }
  return meta[a];
}

console.log("id".padEnd(12), "collateral -> loan".padEnd(24), "LLTV".padStart(6), "supplied".padStart(16), "borrowed".padStart(16), " oraclePrice");
const enriched = [];
for (const m of markets) {
  const [ct, lt] = [await tok(m.collateralToken), await tok(m.loanToken)];
  const st = await client.readContract({ address: MORPHO, abi: mAbi, functionName: "market", args: [m.id] });
  let price = null;
  try { price = await client.readContract({ address: m.oracle, abi: oAbi, functionName: "price" }); } catch { }
  const supplied = Number(st[0]) / 10 ** lt.decimals;
  const borrowed = Number(st[2]) / 10 ** lt.decimals;
  const row = { ...m, lltvPct: Number(m.lltv) / 1e16, collSym: ct.symbol, collDec: ct.decimals, loanSym: lt.symbol, loanDec: lt.decimals,
                totalSupplyAssets: st[0], totalSupplyShares: st[1], totalBorrowAssets: st[2], totalBorrowShares: st[3], price };
  enriched.push(row);
  const touchesFXRP = m.collateralToken.toLowerCase() === FXRP || m.loanToken.toLowerCase() === FXRP;
  console.log(
    m.id.slice(0, 10).padEnd(12),
    `${ct.symbol} -> ${lt.symbol}`.padEnd(24),
    (Number(m.lltv) / 1e16).toFixed(0).padStart(5) + "%",
    supplied.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(16),
    borrowed.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(16),
    price === null ? " (no price)" : " " + price.toString().slice(0, 12) + "...",
    touchesFXRP ? "  <== FXRP" : ""
  );
}

writeFileSync("morpho-markets.json", JSON.stringify(enriched, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log("\nwrote morpho-markets.json");
