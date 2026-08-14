import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbi } from "viem";
import {
  DATA_DIR,
  loadSnapshot,
  pinnedMulticall,
  readPinnedContract,
  verifyPinnedBlock,
  writeJsonAtomic,
} from "./snapshot.mjs";
import { xrpDropToLiquidation } from "./risk-math.mjs";

const snapshot = loadSnapshot();
await verifyPinnedBlock(snapshot);
const COMPTROLLER = "0x15F69897E6aEBE0463401345543C26d1Fd994abB";
const MARKET_ADDRESSES = [
  { name: "isoUSDT0", address: "0xad7e7989796414c9572da9854DEb1B920724fd09", xrpLinked: false },
  { name: "isoFXRP", address: "0xD1b7A5eFa9bd88F291F7A4563a8f6185c0249CB3", xrpLinked: true },
  { name: "isoSTXRP", address: "0x870f7B89F0d408D7CA2E6586Df26D00Ea03aA358", xrpLinked: true },
];
const comptrollerAbi = parseAbi([
  "function oracle() view returns (address)",
  "function closeFactorMantissa() view returns (uint256)",
  "function liquidationIncentiveMantissa() view returns (uint256)",
  "function getAllMarkets() view returns (address[])",
  "function getAssetsIn(address account) view returns (address[])",
  "function markets(address cToken) view returns (bool isListed, uint256 collateralFactorMantissa)",
  "function getAccountLiquidity(address account) view returns (uint256 errorCode, uint256 liquidity, uint256 shortfall)",
]);
const oracleAbi = parseAbi(["function getUnderlyingPrice(address cToken) view returns (uint256)"]);
const marketAbi = parseAbi([
  "function getAccountSnapshot(address account) view returns (uint256 errorCode, uint256 cTokenBalance, uint256 borrowBalance, uint256 exchangeRateMantissa)",
  "function underlying() view returns (address)",
]);
const tokenAbi = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

const [oracle, closeFactorRaw, liquidationIncentiveRaw, allMarketAddresses] = await Promise.all([
  readPinnedContract({ address: COMPTROLLER, abi: comptrollerAbi, functionName: "oracle" }, { snapshot, label: "enosys.oracle" }),
  readPinnedContract({ address: COMPTROLLER, abi: comptrollerAbi, functionName: "closeFactorMantissa" }, { snapshot, label: "enosys.closeFactor" }),
  readPinnedContract({ address: COMPTROLLER, abi: comptrollerAbi, functionName: "liquidationIncentiveMantissa" }, { snapshot, label: "enosys.liquidationIncentive" }),
  readPinnedContract({ address: COMPTROLLER, abi: comptrollerAbi, functionName: "getAllMarkets" }, { snapshot, label: "enosys.getAllMarkets" }),
]);
const closeFactor = Number(closeFactorRaw) / 1e18;
const liquidationPenalty = Number(liquidationIncentiveRaw - 10n ** 18n) / 1e18;
if (!(closeFactor > 0 && closeFactor <= 1) || liquidationPenalty < 0) {
  throw new Error("invalid Enosys liquidation configuration");
}
const configuredMarkets = new Set(MARKET_ADDRESSES.map(({ address }) => address.toLowerCase()));
const liveMarkets = new Set(allMarketAddresses.map((address) => address.toLowerCase()));
if (configuredMarkets.size !== liveMarkets.size || [...configuredMarkets].some((address) => !liveMarkets.has(address))) {
  throw new Error("configured Enosys markets do not match the pinned comptroller market set");
}
const markets = [];
for (const configured of MARKET_ADDRESSES) {
  const [marketConfig, underlying, priceRaw] = await Promise.all([
    readPinnedContract({ address: COMPTROLLER, abi: comptrollerAbi, functionName: "markets", args: [configured.address] }, { snapshot, label: `enosys.markets(${configured.name})` }),
    readPinnedContract({ address: configured.address, abi: marketAbi, functionName: "underlying" }, { snapshot, label: `enosys.underlying(${configured.name})` }),
    readPinnedContract({ address: oracle, abi: oracleAbi, functionName: "getUnderlyingPrice", args: [configured.address] }, { snapshot, label: `enosys.price(${configured.name})` }),
  ]);
  const [decimals, symbol] = await Promise.all([
    readPinnedContract({ address: underlying, abi: tokenAbi, functionName: "decimals" }, { snapshot, label: `enosys.decimals(${configured.name})` }),
    readPinnedContract({ address: underlying, abi: tokenAbi, functionName: "symbol" }, { snapshot, label: `enosys.symbol(${configured.name})` }),
  ]);
  const underlyingDecimals = Number(decimals);
  const [isListed, collateralFactor] = marketConfig;
  if (!isListed || priceRaw <= 0n || !Number.isSafeInteger(underlyingDecimals)) throw new Error(`invalid Enosys market configuration: ${configured.name}`);
  markets.push({
    ...configured,
    symbol,
    decimals: underlyingDecimals,
    collateralFactor: Number(collateralFactor) / 1e18,
    priceUsd: Number(priceRaw) / 10 ** (36 - underlyingDecimals),
  });
}

const accountsPayload = JSON.parse(readFileSync(join(DATA_DIR, "accounts.json"), "utf8"));
if (accountsPayload.snapshotBlock !== snapshot.blockNumber || !Array.isArray(accountsPayload.all)) {
  throw new Error("Enosys account discovery does not match the pinned snapshot");
}
const positions = [];
const chunkSize = 120;
console.log(`scanning ${accountsPayload.all.length} Enosys accounts at pinned block ${snapshot.blockNumber}...`);
for (let index = 0; index < accountsPayload.all.length; index += chunkSize) {
  const accounts = accountsPayload.all.slice(index, index + chunkSize);
  const [results, memberships] = await Promise.all([
    pinnedMulticall(accounts.flatMap((account) => markets.map((market) => ({
      address: market.address,
      abi: marketAbi,
      functionName: "getAccountSnapshot",
      args: [account],
    }))), { snapshot, label: "enosys.getAccountSnapshot" }),
    pinnedMulticall(accounts.map((account) => ({
      address: COMPTROLLER,
      abi: comptrollerAbi,
      functionName: "getAssetsIn",
      args: [account],
    })), { snapshot, label: "enosys.getAssetsIn" }),
  ]);
  accounts.forEach((account, accountIndex) => {
    const enteredMarkets = new Set(memberships[accountIndex].map((address) => address.toLowerCase()));
    let collateralUsd = 0;
    let xrpCollateralUsd = 0;
    let stableCollateralUsd = 0;
    let debtUsd = 0;
    let xrpDebtUsd = 0;
    let stableDebtUsd = 0;
    const legs = [];
    markets.forEach((market, marketIndex) => {
      const [errorCode, cTokenBalance, borrowBalance, exchangeRate] = results[accountIndex * markets.length + marketIndex];
      if (errorCode !== 0n) throw new Error(`Enosys account snapshot error ${errorCode}: ${account}/${market.name}`);
      const supplied = Number(cTokenBalance) * Number(exchangeRate) / 1e18 / 10 ** market.decimals;
      const borrowed = Number(borrowBalance) / 10 ** market.decimals;
      const supplyUsd = supplied * market.priceUsd;
      const borrowUsd = borrowed * market.priceUsd;
      const collateralEnabled = enteredMarkets.has(market.address.toLowerCase());
      const weighted = collateralEnabled ? supplyUsd * market.collateralFactor : 0;
      collateralUsd += weighted;
      if (market.xrpLinked) xrpCollateralUsd += weighted;
      else stableCollateralUsd += weighted;
      debtUsd += borrowUsd;
      if (market.xrpLinked) xrpDebtUsd += borrowUsd;
      else stableDebtUsd += borrowUsd;
      if (supplyUsd > 0.01 || borrowUsd > 0.01) {
        legs.push({
          m: market.name,
          supplyUSD: Number(supplyUsd.toFixed(2)),
          borrowUSD: Number(borrowUsd.toFixed(2)),
          collateralEnabled,
        });
      }
    });
    if (debtUsd <= 1) return;
    const health = collateralUsd / debtUsd;
    const dropToLiq = xrpDropToLiquidation({
      stableCollateralUsd,
      xrpCollateralUsd,
      stableDebtUsd,
      xrpDebtUsd,
    });
    positions.push({
      acct: account,
      health: Number(health.toFixed(4)),
      collUSD: Number(collateralUsd.toFixed(2)),
      debtUSD: Number(debtUsd.toFixed(2)),
      collXrpUSD: Number(xrpCollateralUsd.toFixed(2)),
      collStableUSD: Number(stableCollateralUsd.toFixed(2)),
      debtXrpUSD: Number(xrpDebtUsd.toFixed(2)),
      debtStableUSD: Number(stableDebtUsd.toFixed(2)),
      dropToLiq: dropToLiq === null ? null : Number(dropToLiq.toFixed(2)),
      closeFactor,
      liquidationPenalty,
      legs,
    });
  });
  process.stdout.write(`\r  ${Math.min(index + chunkSize, accountsPayload.all.length)}/${accountsPayload.all.length} accounts; ${positions.length} positions                    `);
}
console.log();
positions.sort((left, right) => left.health - right.health);

for (let index = 0; index < positions.length; index += chunkSize) {
  const batch = positions.slice(index, index + chunkSize);
  const liquidityResults = await pinnedMulticall(batch.map((position) => ({
    address: COMPTROLLER,
    abi: comptrollerAbi,
    functionName: "getAccountLiquidity",
    args: [position.acct],
  })), { snapshot, label: "enosys.getAccountLiquidity" });
  batch.forEach((position, resultIndex) => {
    const [errorCode, liquidityRaw, shortfallRaw] = liquidityResults[resultIndex];
    if (errorCode !== 0n) throw new Error(`Enosys liquidity cross-check failed for ${position.acct}: ${errorCode}`);
    const actualMargin = Number(liquidityRaw - shortfallRaw) / 1e18;
    const expectedMargin = position.collUSD - position.debtUSD;
    const tolerance = Math.max(0.25, Math.abs(actualMargin) * 1e-6);
    if (Math.abs(actualMargin - expectedMargin) > tolerance) {
      throw new Error(`Enosys liquidity mismatch for ${position.acct}: computed=${expectedMargin}, onchain=${actualMargin}`);
    }
  });
}

const output = join(DATA_DIR, "positions.json");
writeJsonAtomic(output, positions);
console.log(`wrote ${output} (${positions.length} positions)`);
