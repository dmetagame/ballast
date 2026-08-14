import { join } from "node:path";
import {
  DATA_DIR,
  SCAN_START_BLOCK,
  loadSnapshot,
  scanExplorerLogs,
  verifyPinnedBlock,
  writeJsonAtomic,
} from "./snapshot.mjs";

const snapshot = loadSnapshot();
await verifyPinnedBlock(snapshot);
const HEAD = BigInt(snapshot.blockNumber);
const TOPIC_BORROW = "0x13ed6866d4e1ee6da46f845c46d7e54120883d75c5ea9a2dacc1c4ca8984ab80";
const TOPIC_MARKET_ENTERED = "0x3ab23ab0d51cccc0c3085aec51f99228625aa1a922b3a8ca89a26b0f2027a1a5";
const MARKETS = {
  isoUSDT0: "0xad7e7989796414c9572da9854DEb1B920724fd09",
  isoFXRP: "0xD1b7A5eFa9bd88F291F7A4563a8f6185c0249CB3",
  isoSTXRP: "0x870f7B89F0d408D7CA2E6586Df26D00Ea03aA358",
};
const COMPTROLLER = "0x15F69897E6aEBE0463401345543C26d1Fd994abB";
const borrowers = new Set();
const perMarket = {};

for (const [name, address] of Object.entries(MARKETS)) {
  console.log(`[${name}] scanning Borrow events through pinned block ${snapshot.blockNumber}...`);
  const logs = await scanExplorerLogs({ address, topic0: TOPIC_BORROW, fromBlock: SCAN_START_BLOCK, toBlock: HEAD });
  const seen = new Set();
  const marketBorrowers = new Set();
  for (const log of logs) {
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const data = String(log.data || "").replace(/^0x/, "");
    if (data.length < 64 || !/^[0-9a-f]+$/i.test(data)) throw new Error(`invalid Enosys Borrow event: ${key}`);
    const borrower = `0x${data.slice(24, 64)}`.toLowerCase();
    marketBorrowers.add(borrower);
    borrowers.add(borrower);
  }
  perMarket[name] = { rawLogs: logs.length, uniqueEvents: seen.size, uniqueBorrowers: marketBorrowers.size };
  console.log(`  -> ${seen.size} unique events, ${marketBorrowers.size} borrowers`);
}

console.log("[comptroller] scanning MarketEntered events...");
const enteredLogs = await scanExplorerLogs({ address: COMPTROLLER, topic0: TOPIC_MARKET_ENTERED, fromBlock: SCAN_START_BLOCK, toBlock: HEAD });
const entered = new Set();
const seenEntered = new Set();
for (const log of enteredLogs) {
  const key = `${log.transactionHash}:${log.logIndex}`;
  if (seenEntered.has(key)) continue;
  seenEntered.add(key);
  const data = String(log.data || "").replace(/^0x/, "");
  if (data.length < 128 || !/^[0-9a-f]+$/i.test(data)) throw new Error(`invalid MarketEntered event: ${key}`);
  entered.add(`0x${data.slice(88, 128)}`.toLowerCase());
}

const all = [...new Set([...borrowers, ...entered])].sort();
const output = join(DATA_DIR, "accounts.json");
writeJsonAtomic(output, { snapshotBlock: snapshot.blockNumber, perMarket, borrowers: [...borrowers].sort(), entered: [...entered].sort(), all });
console.log(`wrote ${output} with ${all.length} candidate accounts`);
