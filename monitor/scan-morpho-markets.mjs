import { getAddress, parseAbi } from "viem";
import {
  DATA_DIR,
  FXRP,
  MORPHO,
  SCAN_START_BLOCK,
  loadSnapshot,
  readPinnedContract,
  scanExplorerLogs,
  verifyPinnedBlock,
  writeJsonAtomic,
} from "./snapshot.mjs";
import { join } from "node:path";

const snapshot = loadSnapshot();
await verifyPinnedBlock(snapshot);
const HEAD = BigInt(snapshot.blockNumber);
const TOPIC_CREATE = "0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac";
const ZERO = "0x0000000000000000000000000000000000000000";
const ercAbi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const morphoAbi = parseAbi([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);
const oracleAbi = parseAbi(["function price() view returns (uint256)"]);

console.log(`scanning Morpho CreateMarket events through pinned block ${snapshot.blockNumber}...`);
const logs = await scanExplorerLogs({ address: MORPHO, topic0: TOPIC_CREATE, fromBlock: SCAN_START_BLOCK, toBlock: HEAD });
const markets = [];
const seen = new Set();
for (const log of logs) {
  const key = `${log.transactionHash}:${log.logIndex}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (!Array.isArray(log.topics) || !/^0x[0-9a-f]{64}$/i.test(log.topics[1] || "")) throw new Error(`invalid CreateMarket topics: ${key}`);
  const data = String(log.data || "").replace(/^0x/, "");
  if (data.length !== 64 * 5) throw new Error(`invalid CreateMarket data: ${key}`);
  const word = (index) => data.slice(index * 64, (index + 1) * 64);
  const market = {
    id: log.topics[1].toLowerCase(),
    loanToken: getAddress(`0x${word(0).slice(24)}`),
    collateralToken: getAddress(`0x${word(1).slice(24)}`),
    oracle: getAddress(`0x${word(2).slice(24)}`),
    irm: getAddress(`0x${word(3).slice(24)}`),
    lltv: BigInt(`0x${word(4)}`),
    block: Number(BigInt(log.blockNumber)),
  };
  if (market.block > snapshot.blockNumber) throw new Error(`market event exceeds snapshot block: ${market.id}`);
  if ([market.loanToken, market.collateralToken, market.oracle, market.irm].every((address) => address === ZERO)) {
    const state = await readPinnedContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [market.id] }, { snapshot, label: `morpho.market(${market.id})` });
    if (state.slice(0, 4).some((value) => value !== 0n)) throw new Error("zero-address Morpho market unexpectedly has state");
    continue;
  }
  markets.push(market);
}
if (markets.length === 0) throw new Error("no non-zero Morpho markets found");
console.log(`  -> ${markets.length} non-zero markets created`);

const tokenMetadata = new Map();
async function token(address) {
  const key = address.toLowerCase();
  if (tokenMetadata.has(key)) return tokenMetadata.get(key);
  const [symbol, decimals] = await Promise.all([
    readPinnedContract({ address, abi: ercAbi, functionName: "symbol" }, { snapshot, label: `token.symbol(${address})` }),
    readPinnedContract({ address, abi: ercAbi, functionName: "decimals" }, { snapshot, label: `token.decimals(${address})` }),
  ]);
  const metadata = { symbol, decimals: Number(decimals) };
  if (!symbol || !Number.isSafeInteger(metadata.decimals) || metadata.decimals < 0 || metadata.decimals > 36) {
    throw new Error(`invalid token metadata: ${address}`);
  }
  tokenMetadata.set(key, metadata);
  return metadata;
}

const enriched = [];
for (const market of markets) {
  const [collateral, loan, state, oraclePrice] = await Promise.all([
    token(market.collateralToken),
    token(market.loanToken),
    readPinnedContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [market.id] }, { snapshot, label: `morpho.market(${market.id})` }),
    readPinnedContract({ address: market.oracle, abi: oracleAbi, functionName: "price" }, { snapshot, label: `oracle.price(${market.oracle})` }),
  ]);
  if (oraclePrice <= 0n) throw new Error(`non-positive Morpho oracle price: ${market.oracle}`);
  enriched.push({
    ...market,
    lltvPct: Number(market.lltv) / 1e16,
    collSym: collateral.symbol,
    collDec: collateral.decimals,
    loanSym: loan.symbol,
    loanDec: loan.decimals,
    totalSupplyAssets: state[0],
    totalSupplyShares: state[1],
    totalBorrowAssets: state[2],
    totalBorrowShares: state[3],
    price: oraclePrice,
  });
  const touchesFXRP = market.collateralToken.toLowerCase() === FXRP.toLowerCase() || market.loanToken.toLowerCase() === FXRP.toLowerCase();
  console.log(`  ${market.id.slice(0, 10)} ${collateral.symbol} -> ${loan.symbol}${touchesFXRP ? "  <== FXRP" : ""}`);
}

const output = join(DATA_DIR, "morpho-markets.json");
writeJsonAtomic(output, enriched);
console.log(`wrote ${output}`);
