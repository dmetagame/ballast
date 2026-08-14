import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbi } from "viem";
import {
  DATA_DIR,
  MORPHO,
  SCAN_START_BLOCK,
  loadSnapshot,
  pinnedMulticall,
  scanExplorerLogs,
  snapshotPrice,
  tokenRatioFromOracle,
  verifyPinnedBlock,
  writeJsonAtomic,
} from "./snapshot.mjs";
import { morphoLiquidationPenaltyRate } from "./risk-math.mjs";

const snapshot = loadSnapshot();
await verifyPinnedBlock(snapshot);
const HEAD = BigInt(snapshot.blockNumber);
const TOPIC_BORROW = "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43";
const TOPIC_SUPPLY_COLLATERAL = "0xa3b9472a1399e17e123f3c2e6586c23e504184d504de59cdaa2b375e880c6184";
const XRP_LINKED = new Set(["FXRP", "stXRP", "PT-stXRP(FXRP)-2026/06/04"]);
const markets = JSON.parse(readFileSync(join(DATA_DIR, "morpho-markets.json"), "utf8"));
const byId = Object.fromEntries(markets.map((market) => [market.id.toLowerCase(), market]));
const positionAbi = parseAbi([
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
]);

console.log(`scanning Morpho borrower events through pinned block ${snapshot.blockNumber}...`);
const [borrowLogs, collateralLogs] = await Promise.all([
  scanExplorerLogs({ address: MORPHO, topic0: TOPIC_BORROW, fromBlock: SCAN_START_BLOCK, toBlock: HEAD }),
  scanExplorerLogs({ address: MORPHO, topic0: TOPIC_SUPPLY_COLLATERAL, fromBlock: SCAN_START_BLOCK, toBlock: HEAD }),
]);
const seen = new Set();
const pairs = new Map();
for (const logs of [borrowLogs, collateralLogs]) {
  for (const log of logs) {
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const marketId = log.topics?.[1]?.toLowerCase();
    const accountTopic = log.topics?.[2];
    if (!/^0x[0-9a-f]{64}$/i.test(marketId || "") || !/^0x[0-9a-f]{64}$/i.test(accountTopic || "")) {
      throw new Error(`invalid Morpho borrower event: ${key}`);
    }
    if (!byId[marketId]) throw new Error(`borrower event references an unknown market: ${marketId}`);
    const account = `0x${accountTopic.slice(-40)}`.toLowerCase();
    if (!pairs.has(marketId)) pairs.set(marketId, new Set());
    pairs.get(marketId).add(account);
  }
}
console.log(`  -> ${seen.size} unique events, ${[...pairs.values()].reduce((sum, accounts) => sum + accounts.size, 0)} market/account pairs`);

const positions = [];
for (const [id, accounts] of pairs) {
  const market = byId[id];
  const totalBorrowAssets = BigInt(market.totalBorrowAssets);
  const totalBorrowShares = BigInt(market.totalBorrowShares);
  if (totalBorrowShares === 0n) continue;
  const loanUsd = snapshotPrice(snapshot, market.loanSym);
  const collateralUsd = tokenRatioFromOracle(BigInt(market.price), market.collDec, market.loanDec) * loanUsd;
  if (!Number.isFinite(collateralUsd) || collateralUsd <= 0) throw new Error(`invalid oracle-derived USD price for ${market.collSym}`);
  const list = [...accounts];
  for (let index = 0; index < list.length; index += 150) {
    const chunk = list.slice(index, index + 150);
    const results = await pinnedMulticall(chunk.map((account) => ({
      address: MORPHO,
      abi: positionAbi,
      functionName: "position",
      args: [market.id, account],
    })), { snapshot, label: `morpho.position(${id.slice(0, 10)})` });
    results.forEach((result, resultIndex) => {
      const [, borrowShares, collateral] = result;
      if (borrowShares === 0n) return;
      const borrowAssetsRaw = (BigInt(borrowShares) * totalBorrowAssets + totalBorrowShares - 1n) / totalBorrowShares;
      const debt = Number(borrowAssetsRaw) / 10 ** market.loanDec;
      const collateralTokens = Number(collateral) / 10 ** market.collDec;
      const debtUsd = debt * loanUsd;
      const collateralValueUsd = collateralTokens * collateralUsd;
      const health = Number(collateral) * Number(BigInt(market.price)) * (Number(BigInt(market.lltv)) / 1e18)
        / (Number(borrowAssetsRaw) * 1e36);
      if (!Number.isFinite(health) || health < 0) throw new Error(`invalid Morpho health for ${chunk[resultIndex]}`);
      const collateralXrp = XRP_LINKED.has(market.collSym);
      const loanXrp = XRP_LINKED.has(market.loanSym);
      const dropToLiq = collateralXrp && !loanXrp && health > 0 ? (1 - 1 / health) * 100 : null;
      positions.push({
        market: `${market.collSym} -> ${market.loanSym}`,
        id: market.id,
        acct: chunk[resultIndex],
        lltvPct: Number((Number(BigInt(market.lltv)) / 1e16).toFixed(2)),
        collUSD: Number(collateralValueUsd.toFixed(2)),
        debtUSD: Number(debtUsd.toFixed(2)),
        health: Number(health.toFixed(4)),
        dropToLiq: dropToLiq === null ? null : Number(dropToLiq.toFixed(2)),
        xrpCollateral: collateralXrp,
        xrpDebt: loanXrp,
        closeFactor: 1,
        liquidationPenalty: morphoLiquidationPenaltyRate(BigInt(market.lltv)),
      });
    });
  }
  process.stdout.write(`\r  scored ${positions.length} positions                    `);
}
console.log();
positions.sort((left, right) => left.health - right.health);
const output = join(DATA_DIR, "morpho-positions.json");
writeJsonAtomic(output, positions);
console.log(`wrote ${output} (${positions.length} positions)`);
