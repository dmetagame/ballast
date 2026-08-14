#!/usr/bin/env node
import { getAddress, parseAbi } from "viem";
import {
  FTSO_V2,
  MORPHO,
  SNAPSHOT_PATH,
  client,
  ftsoAbi,
  readPinnedContract,
  verifyPinnedBlock,
  withRetry,
  writeJsonAtomic,
} from "./snapshot.mjs";

const CONFIRMATIONS = 12n;
const requestedBlock = process.env.SNAPSHOT_BLOCK?.trim();
const latest = await withRetry(() => client.getBlockNumber(), { label: "rpc.getBlockNumber" });
const blockNumber = requestedBlock ? BigInt(requestedBlock) : latest - CONFIRMATIONS;
if (blockNumber <= 0n || blockNumber > latest) throw new Error(`invalid SNAPSHOT_BLOCK: ${blockNumber}`);
const block = await withRetry(() => client.getBlock({ blockNumber }), { label: "rpc.getSnapshotBlock" });
if (!block.hash) throw new Error("snapshot block has no hash");

const FEEDS = {
  "XRP/USD": "0x015852502f55534400000000000000000000000000",
  "FLR/USD": "0x01464c522f55534400000000000000000000000000",
  "USDT/USD": "0x01555344542f555344000000000000000000000000",
  "USDC/USD": "0x01555344432f555344000000000000000000000000",
  "stXRP/USD": "0x2173745852502f5553440000000000000000000000",
};

const feeds = {};
for (const [name, id] of Object.entries(FEEDS)) {
  const result = await withRetry(() => client.readContract({
    address: FTSO_V2,
    abi: ftsoAbi,
    functionName: "getFeedById",
    args: [id],
    blockNumber,
  }), { label: `rpc.ftso.${name}` });
  const [value, decimals, timestamp] = result;
  const precision = Number(decimals);
  const feedTimestamp = Number(timestamp);
  if (!Number.isSafeInteger(precision) || precision < 0 || precision > 18) throw new Error(`invalid decimals for ${name}`);
  if (feedTimestamp > Number(block.timestamp) || Number(block.timestamp) - feedTimestamp > 300) {
    throw new Error(`stale or future feed timestamp for ${name}: ${feedTimestamp}`);
  }
  feeds[name] = {
    id,
    value: value.toString(),
    decimals: precision,
    timestamp: feedTimestamp,
    usd: Number(value) / 10 ** precision,
  };
}

const ptOracle = getAddress("0x405a251e9152939f241ad290cc7e8a80de53171a");
const oracleAbi = parseAbi(["function price() view returns (uint256)"]);
const provisional = {
  version: 1,
  chainId: 14,
  blockNumber: Number(blockNumber),
  blockHash: block.hash,
  blockTimestamp: Number(block.timestamp),
  generated: new Date(Number(block.timestamp) * 1_000).toISOString().slice(0, 10),
  capturedAt: new Date(Number(block.timestamp) * 1_000).toISOString(),
  sources: {
    rpc: "https://flare-api.flare.network/ext/C/rpc",
    explorer: "https://flare-explorer.flare.network",
    ftsoFeeds: "https://dev.flare.network/ftso/feeds/",
    ftsoReference: "https://dev.flare.network/ftso/solidity-reference/",
  },
  contracts: {
    morpho: MORPHO,
    ftsoV2: FTSO_V2,
    ptStXrpUsdT0Oracle: ptOracle,
  },
};
const ptOracleRaw = await readPinnedContract({ address: ptOracle, abi: oracleAbi, functionName: "price" }, {
  snapshot: provisional,
  label: "ptStXrpOracle.price",
});
const ptTokenRatio = Number(ptOracleRaw) / 1e36;
const usdtUsd = feeds["USDT/USD"].usd;

const snapshot = {
  ...provisional,
  feeds,
  prices: {
    FXRP: { usd: feeds["XRP/USD"].usd, source: "FTSOv2 XRP/USD", feedId: FEEDS["XRP/USD"] },
    "USD₮0": { usd: usdtUsd, source: "FTSOv2 USDT/USD", feedId: FEEDS["USDT/USD"] },
    WFLR: { usd: feeds["FLR/USD"].usd, source: "FTSOv2 FLR/USD", feedId: FEEDS["FLR/USD"] },
    stXRP: { usd: feeds["stXRP/USD"].usd, source: "FTSOv2 stXRP/USD", feedId: FEEDS["stXRP/USD"] },
    "PT-stXRP(FXRP)-2026/06/04": {
      usd: ptTokenRatio * usdtUsd,
      source: "Pinned Morpho PT-stXRP/USD₮0 oracle × FTSOv2 USDT/USD",
      oracle: ptOracle,
      oracleRaw: ptOracleRaw.toString(),
    },
  },
};

await verifyPinnedBlock(snapshot);
writeJsonAtomic(SNAPSHOT_PATH, snapshot);
console.log(`snapshot pinned: block=${snapshot.blockNumber} hash=${snapshot.blockHash} time=${snapshot.capturedAt}`);
for (const [symbol, price] of Object.entries(snapshot.prices)) console.log(`  ${symbol.padEnd(30)} $${price.usd}`);
