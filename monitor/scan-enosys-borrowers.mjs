import { writeFileSync } from "fs";

const EXPLORER = "https://flare-explorer.flare.network/api";
const TOPIC_BORROW = "0x13ed6866d4e1ee6da46f845c46d7e54120883d75c5ea9a2dacc1c4ca8984ab80";
const TOPIC_MARKET_ENTERED = "0x3ab23ab0d51cccc0c3085aec51f99228625aa1a922b3a8ca89a26b0f2027a1a5";
const CAP = 1000;

const MARKETS = {
  isoUSDT0: "0xad7e7989796414c9572da9854DEb1B920724fd09",
  isoFXRP: "0xD1b7A5eFa9bd88F291F7A4563a8f6185c0249CB3",
  isoSTXRP: "0x870f7B89F0d408D7CA2E6586Df26D00Ea03aA358",
};
const COMPTROLLER = "0x15F69897E6aEBE0463401345543C26d1Fd994abB";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWindow(address, topic0, from, to, tries = 0) {
  const url = `${EXPLORER}?module=logs&action=getLogs&fromBlock=${from}&toBlock=${to}&address=${address}&topic0=${topic0}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (Array.isArray(j.result)) return j.result;
    if (/no logs/i.test(j.message || "")) return [];
    throw new Error(j.message || "bad response");
  } catch (e) {
    if (tries < 3) { await sleep(800 * (tries + 1)); return fetchWindow(address, topic0, from, to, tries + 1); }
    console.log(`      !! give up ${from}-${to}: ${e.message}`);
    return [];
  }
}

// Recursively split any window that comes back at the result cap.
async function scan(address, topic0, from, to, depth = 0) {
  const logs = await fetchWindow(address, topic0, from, to);
  if (logs.length < CAP || to - from <= 1) return logs;
  const mid = Math.floor((from + to) / 2);
  process.stdout.write(`\r    splitting ${from}-${to} (${logs.length} at cap, depth ${depth})            `);
  const [a, b] = [await scan(address, topic0, from, mid, depth + 1), await scan(address, topic0, mid + 1, to, depth + 1)];
  return [...a, ...b];
}

const START = 40_000_000, HEAD = 66_471_000;
const borrowers = new Set();
const perMarket = {};

for (const [name, addr] of Object.entries(MARKETS)) {
  process.stdout.write(`\n[${name}] scanning Borrow events...\n`);
  const logs = await scan(addr, TOPIC_BORROW, START, HEAD);
  const seen = new Set(), set = new Set();
  for (const l of logs) {
    const key = l.transactionHash + ":" + l.logIndex;
    if (seen.has(key)) continue;          // de-dup across overlapping splits
    seen.add(key);
    const data = l.data.replace(/^0x/, "");
    if (data.length < 64) continue;
    const b = ("0x" + data.slice(24, 64)).toLowerCase();
    set.add(b); borrowers.add(b);
  }
  perMarket[name] = { rawLogs: logs.length, uniqueEvents: seen.size, uniqueBorrowers: set.size };
  console.log(`\r  -> ${seen.size} unique Borrow events, ${set.size} unique borrowers                    `);
}

process.stdout.write(`\n[comptroller] scanning MarketEntered...\n`);
const meLogs = await scan(COMPTROLLER, TOPIC_MARKET_ENTERED, START, HEAD);
const seenMe = new Set(), entered = new Set();
for (const l of meLogs) {
  const key = l.transactionHash + ":" + l.logIndex;
  if (seenMe.has(key)) continue;
  seenMe.add(key);
  const data = l.data.replace(/^0x/, "");
  if (data.length >= 128) entered.add(("0x" + data.slice(88, 128)).toLowerCase());
}
console.log(`\r  -> ${seenMe.size} unique events, ${entered.size} unique accounts                        `);

console.log("\n================ SUMMARY (complete scan) ================");
console.table(perMarket);
console.log("unique borrowers (all markets)      :", borrowers.size);
console.log("unique accounts w/ collateral enabled:", entered.size);

const all = [...new Set([...borrowers, ...entered])];
writeFileSync("accounts.json", JSON.stringify({ borrowers: [...borrowers], entered: [...entered], all }, null, 2));
console.log("wrote accounts.json with", all.length, "candidate accounts");
