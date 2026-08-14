#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  formatUnits,
  getAddress,
  toEventSelector,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = process.env.RPC_URL || "https://flare-api.flare.network/ext/C/rpc";
const BLOCKSCOUT_URL = (process.env.BLOCKSCOUT_URL
  || process.env.EXPLORER_URL?.replace(/\/api\/?$/, "")
  || "https://flare-explorer.flare.network").replace(/\/$/, "");
const BALLAST = getAddress(process.env.BALLAST || "0x746066ACe5dc89a3692137b8cdE3c31328629d09");
const MORPHO = getAddress(process.env.MORPHO || "0xF4346F5132e810f80a28487a79c7559d9797E8B0");
const MANAGER_VERSION = process.env.MANAGER_VERSION || "v3";
const DEFAULT_DEPLOYMENT_BLOCK = 67019411n;
const FROM_BLOCK = BigInt(process.env.FROM_BLOCK || DEFAULT_DEPLOYMENT_BLOCK);
const STATE_FILE = process.env.STATE_FILE || join(process.env.HOME || process.cwd(), ".config", "ballast", "keeper-state.json");
const HEALTH_STATE_FILE = process.env.HEALTH_STATE_FILE || join(process.env.HOME || process.cwd(), ".config", "ballast", "health-state.json");
const EXECUTION_LOCK_FILE = process.env.EXECUTION_LOCK_FILE || join(process.env.HOME || process.cwd(), ".config", "ballast", "execution.lock");
const CONFIRMATION_BLOCKS = nonNegativeInteger("CONFIRMATION_BLOCKS", 12);
const RPC_LOG_PAGE_BLOCKS = boundedPositiveInteger("RPC_LOG_PAGE_BLOCKS", 30, 30);
const LOG_QUERY_CONCURRENCY = positiveInteger("LOG_QUERY_CONCURRENCY", 4);
const EXECUTE = process.env.EXECUTE === "true";
const RUN_ONCE = process.env.RUN_ONCE === "true";
const PRIVATE_KEY = EXECUTE ? loadPrivateKey() : undefined;
const MAX_POSITIONS = nonNegativeInteger("MAX_POSITIONS", 0);
const MAX_CONCURRENCY = positiveInteger("MAX_CONCURRENCY", 4);
const POLL_INTERVAL_MS = positiveInteger("POLL_INTERVAL_MS", 30_000);
const RETRY_ATTEMPTS = positiveInteger("RETRY_ATTEMPTS", 4);
const RETRY_BASE_DELAY_MS = positiveInteger("RETRY_BASE_DELAY_MS", 500);
const MAX_GAS_FLR_WEI = optionalBigInt("MAX_GAS_FLR_WEI");
const MIN_KEEPER_FEE_UNITS = optionalBigInt("MIN_KEEPER_FEE_UNITS");
const LOAN_TOKEN_UNITS_PER_FLR = optionalBigInt("LOAN_TOKEN_UNITS_PER_FLR");
const MIN_PROFIT_FLR_WEI = optionalBigInt("MIN_PROFIT_FLR_WEI");
const SPARKDEX_QUOTER = optionalAddress("SPARKDEX_QUOTER");
const SPARKDEX_FACTORY = optionalAddress("SPARKDEX_FACTORY");
const SPARKDEX_QUOTE_DEPLOYER = optionalAddress("SPARKDEX_QUOTE_DEPLOYER");
const ADAPTER = optionalAddress("ADAPTER");
const ACTIVE_POOL = optionalAddress("ACTIVE_POOL");
const COLLATERAL_TOKEN = optionalAddress("COLLATERAL_TOKEN");
const LOAN_TOKEN = optionalAddress("LOAN_TOKEN");
const QUOTE_HAIRCUT_BPS = optionalNonNegativeInteger("QUOTE_HAIRCUT_BPS");
const EXECUTION_HEALTH_MAX_AGE_MS = nonNegativeInteger("EXECUTION_HEALTH_MAX_AGE_MS", 420_000);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXPECTED_RELEASE_COMMIT = process.env.EXPECTED_RELEASE_COMMIT
  || (existsSync(join(REPO_ROOT, "release.json"))
    ? JSON.parse(readFileSync(join(REPO_ROOT, "release.json"), "utf8")).commit
    : null);

const chain = {
  id: 14,
  name: "Flare",
  nativeCurrency: { name: "Flare", symbol: "FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const operatorAccount = PRIVATE_KEY ? privateKeyToAccount(PRIVATE_KEY) : null;
const operatorAddress = resolveOperatorAddress({
  configuredAddress: process.env.OPERATOR_ADDRESS,
  signerAddress: operatorAccount?.address,
});
const account = EXECUTE
  ? operatorAccount || (() => { throw new Error("PRIVATE_KEY or PRIVATE_KEY_FILE is required with EXECUTE=true"); })()
  : null;
const walletClient = account ? createWalletClient({ account, chain, transport: http(RPC_URL) }) : null;
const runSerializedExecution = createSerialExecutor();
const executionConfiguration = validateExecutionConfiguration({
  execute: EXECUTE,
  maxGasFlrWei: MAX_GAS_FLR_WEI,
  minKeeperFeeUnits: MIN_KEEPER_FEE_UNITS,
  loanTokenUnitsPerFlr: LOAN_TOKEN_UNITS_PER_FLR,
  minProfitFlrWei: MIN_PROFIT_FLR_WEI,
  quoter: SPARKDEX_QUOTER,
  factory: SPARKDEX_FACTORY,
  quoteDeployer: SPARKDEX_QUOTE_DEPLOYER,
  adapter: ADAPTER,
  activePool: ACTIVE_POOL,
  collateralToken: COLLATERAL_TOKEN,
  loanToken: LOAN_TOKEN,
  quoteHaircutBps: QUOTE_HAIRCUT_BPS,
});

const policyResult = MANAGER_VERSION === "v3"
  ? "uint128 triggerHealth, uint128 targetHealth, uint64 maxCollateralPerAction, uint32 maxSlippageBps, uint32 keeperFeeBps, uint32 cooldown, uint64 lastAction, bool enabled, address keeper"
  : "uint128 triggerHealth, uint128 targetHealth, uint64 maxCollateralPerAction, uint32 maxSlippageBps, uint32 keeperFeeBps, uint32 cooldown, uint64 lastAction, bool enabled";
const abi = parseAbi([
  "event PolicySet(address indexed borrower, bytes32 indexed id, uint128 triggerHealth, uint128 targetHealth, uint64 maxCollateralPerAction, uint32 maxSlippageBps)",
  "event PolicyDisabled(address indexed borrower, bytes32 indexed id)",
  `function policyOf(address borrower, bytes32 id) view returns (${policyResult})`,
  "function previewProtect(address borrower, bytes32 id) view returns (bool actionable, uint256 health, uint256 repayAssets, uint256 collateralNeeded)",
  "function protect(address borrower, bytes32 id)",
  "function swapAdapter() view returns (address)",
]);
const morphoAbi = parseAbi([
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
]);
const algebraQuoterAbi = parseAbi([
  "function factory() view returns (address)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,address deployer,uint256 amountIn,uint160 limitSqrtPrice) params) returns (uint256 amountOut,uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate,uint16 fee)",
]);
const algebraFactoryAbi = parseAbi([
  "function poolByPair(address token0,address token1) view returns (address)",
  "function customPoolByPair(address deployer,address token0,address token1) view returns (address)",
]);
const adapterAbi = parseAbi([
  "function poolFor(bytes32 key) view returns (address)",
]);
const POLICY_SET_TOPIC = toEventSelector("PolicySet(address,bytes32,uint128,uint128,uint64,uint32)");
const POLICY_DISABLED_TOPIC = toEventSelector("PolicyDisabled(address,bytes32)");

export function loadPrivateKey({
  privateKey = process.env.PRIVATE_KEY,
  privateKeyFile = process.env.PRIVATE_KEY_FILE
    || (process.env.CREDENTIALS_DIRECTORY ? join(process.env.CREDENTIALS_DIRECTORY, "keeper_private_key") : undefined),
} = {}) {
  const inlineKey = privateKey?.trim();
  const filePath = privateKeyFile?.trim();
  if (inlineKey && filePath) throw new Error("set only one of PRIVATE_KEY or PRIVATE_KEY_FILE");
  if (inlineKey) return inlineKey;
  if (!filePath) return undefined;
  const fileKey = readFileSync(filePath, "utf8").trim();
  return fileKey || undefined;
}

export function acquireExecutionLock({
  enabled = EXECUTE,
  lockFile = EXECUTION_LOCK_FILE,
  processId = process.pid,
  isProcessAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  },
} = {}) {
  if (!enabled) return () => {};
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(lockFile, "wx", 0o600);
      writeFileSync(descriptor, `${processId}\n`);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { closeSync(descriptor); } catch {}
        try {
          if (readFileSync(lockFile, "utf8").trim() === String(processId)) unlinkSync(lockFile);
        } catch {}
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
        try { unlinkSync(lockFile); } catch {}
      }
      if (error.code !== "EEXIST") throw error;

      let existingPid;
      try { existingPid = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10); } catch { existingPid = NaN; }
      if (Number.isInteger(existingPid) && existingPid > 0 && isProcessAlive(existingPid)) {
        throw new Error(`keeper execution lock is held by process ${existingPid}`);
      }
      try { unlinkSync(lockFile); } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error(`keeper execution lock could not be acquired: ${lockFile}`);
}

export function resolveOperatorAddress({ configuredAddress, signerAddress } = {}) {
  const configured = configuredAddress?.trim() ? getAddress(configuredAddress.trim()) : null;
  const signer = signerAddress?.trim() ? getAddress(signerAddress.trim()) : null;
  if (configured && signer && configured !== signer) {
    throw new Error(`OPERATOR_ADDRESS does not match the configured private key: ${signer}`);
  }
  return signer || configured;
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function boundedPositiveInteger(name, fallback, maximum) {
  const value = positiveInteger(name, fallback);
  if (value > maximum) throw new Error(`${name} cannot exceed ${maximum}`);
  return value;
}

function optionalBigInt(name) {
  if (!process.env[name]) return null;
  try {
    const value = BigInt(process.env[name]);
    if (value < 0n) throw new Error("must not be negative");
    return value;
  } catch (error) {
    throw new Error(`${name} must be a non-negative integer: ${error.message}`);
  }
}

function optionalAddress(name) {
  const value = process.env[name]?.trim();
  return value ? getAddress(value) : null;
}

function optionalNonNegativeInteger(name) {
  if (process.env[name] === undefined || process.env[name] === "") return null;
  return nonNegativeInteger(name, 0);
}

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

export function validateExecutionConfiguration({
  execute,
  maxGasFlrWei,
  minKeeperFeeUnits,
  loanTokenUnitsPerFlr,
  minProfitFlrWei,
  quoter,
  factory,
  quoteDeployer,
  adapter,
  activePool,
  collateralToken,
  loanToken,
  quoteHaircutBps,
}) {
  if (!execute) return null;
  const values = {
    MAX_GAS_FLR_WEI: maxGasFlrWei,
    MIN_KEEPER_FEE_UNITS: minKeeperFeeUnits,
    LOAN_TOKEN_UNITS_PER_FLR: loanTokenUnitsPerFlr,
    MIN_PROFIT_FLR_WEI: minProfitFlrWei,
    SPARKDEX_QUOTER: quoter,
    SPARKDEX_FACTORY: factory,
    SPARKDEX_QUOTE_DEPLOYER: quoteDeployer,
    ADAPTER: adapter,
    ACTIVE_POOL: activePool,
    COLLATERAL_TOKEN: collateralToken,
    LOAN_TOKEN: loanToken,
    QUOTE_HAIRCUT_BPS: quoteHaircutBps,
  };
  const missing = Object.entries(values).filter(([, value]) => value === null || value === undefined).map(([name]) => name);
  if (missing.length) throw new Error(`execution configuration is incomplete: ${missing.join(", ")}`);
  if (maxGasFlrWei <= 0n) throw new Error("MAX_GAS_FLR_WEI must be greater than zero");
  if (minKeeperFeeUnits <= 0n) throw new Error("MIN_KEEPER_FEE_UNITS must be greater than zero");
  if (loanTokenUnitsPerFlr <= 0n) throw new Error("LOAN_TOKEN_UNITS_PER_FLR must be greater than zero");
  if (quoteHaircutBps > 1_000) throw new Error("QUOTE_HAIRCUT_BPS cannot exceed 1000");
  for (const [name, address] of Object.entries({ SPARKDEX_QUOTER: quoter, SPARKDEX_FACTORY: factory, ADAPTER: adapter, ACTIVE_POOL: activePool, COLLATERAL_TOKEN: collateralToken, LOAN_TOKEN: loanToken })) {
    if (sameAddress(address, zeroAddress)) throw new Error(`${name} cannot be the zero address`);
  }
  if (sameAddress(collateralToken, loanToken)) throw new Error("COLLATERAL_TOKEN and LOAN_TOKEN must differ");
  return {
    maxGasFlrWei,
    minKeeperFeeUnits,
    loanTokenUnitsPerFlr,
    minProfitFlrWei,
    quoter,
    factory,
    quoteDeployer,
    adapter,
    activePool,
    collateralToken,
    loanToken,
    quoteHaircutBps,
  };
}

export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function withRetry(operation, { label, attempts = RETRY_ATTEMPTS, baseDelayMs = RETRY_BASE_DELAY_MS, onRetry = () => {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * baseDelayMs);
      onRetry({ label, attempt, delay, error });
      await sleep(delay);
    }
  }
  throw lastError;
}

export function createSerialExecutor() {
  let tail = Promise.resolve();
  return async function runSerial(operation) {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

export async function prepareSignAndBroadcastTransaction({
  prepareTransaction,
  signTransaction,
  sendRawTransaction,
  attempts = RETRY_ATTEMPTS,
  baseDelayMs = RETRY_BASE_DELAY_MS,
  onRetry = () => {},
}) {
  const preparedRequest = await prepareTransaction();
  const serializedTransaction = await signTransaction(preparedRequest);
  const expectedHash = keccak256(serializedTransaction);
  const hash = await withRetry(
    () => sendRawTransaction({ serializedTransaction }),
    { label: "rpc.sendRawProtect", attempts, baseDelayMs, onRetry },
  );
  if (hash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`raw transaction hash mismatch: expected ${expectedHash}, received ${hash}`);
  }
  return { hash: expectedHash, serializedTransaction };
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function consume() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return results;
}

export function calculateEconomics({ repayAssets, keeperFeeBps, quotedAmountOut, quoteHaircutBps, gasEstimate, gasPrice, maxGasFlrWei, minKeeperFeeUnits, loanTokenUnitsPerFlr, minProfitFlrWei }) {
  if (quotedAmountOut === null || quotedAmountOut === undefined) return { ok: false, reason: "quote_unavailable" };
  if (!Number.isSafeInteger(quoteHaircutBps) || quoteHaircutBps < 0 || quoteHaircutBps > 1_000) {
    return { ok: false, reason: "quote_haircut_invalid" };
  }
  const conservativeAmountOut = (quotedAmountOut * BigInt(10_000 - quoteHaircutBps)) / 10_000n;
  const quotedSurplus = conservativeAmountOut > repayAssets ? conservativeAmountOut - repayAssets : 0n;
  const maximumKeeperFee = (repayAssets * BigInt(keeperFeeBps)) / 10_000n;
  const expectedKeeperFee = quotedSurplus < maximumKeeperFee ? quotedSurplus : maximumKeeperFee;
  const gasCostFlrWei = gasEstimate * gasPrice;
  const quoteFields = { quotedAmountOut, conservativeAmountOut, quotedSurplus, maximumKeeperFee, expectedKeeperFee, gasCostFlrWei };
  if (conservativeAmountOut < repayAssets) return { ok: false, reason: "quote_below_repayment", ...quoteFields };
  if (maxGasFlrWei !== null && gasCostFlrWei > maxGasFlrWei) return { ok: false, reason: "gas_limit_exceeded", ...quoteFields };
  if (minKeeperFeeUnits !== null && expectedKeeperFee < minKeeperFeeUnits) return { ok: false, reason: "keeper_fee_below_minimum", ...quoteFields };
  if (loanTokenUnitsPerFlr !== null && minProfitFlrWei !== null) {
    const revenueFlrWei = (expectedKeeperFee * 10n ** 18n) / loanTokenUnitsPerFlr;
    const profitFlrWei = revenueFlrWei - gasCostFlrWei;
    if (profitFlrWei < minProfitFlrWei) return { ok: false, reason: "profit_below_minimum", ...quoteFields, revenueFlrWei, profitFlrWei };
    return { ok: true, ...quoteFields, revenueFlrWei, profitFlrWei };
  }
  return { ok: true, ...quoteFields, pricingConfigured: false };
}

export async function quoteSwapOutput({
  rpcClient,
  quoter,
  factory,
  quoteDeployer,
  expectedPool,
  tokenIn,
  tokenOut,
  amountIn,
}) {
  if (amountIn <= 0n) throw new Error("swap quote amount must be greater than zero");
  const poolRequest = sameAddress(quoteDeployer, zeroAddress)
    ? { address: factory, abi: algebraFactoryAbi, functionName: "poolByPair", args: [tokenIn, tokenOut] }
    : { address: factory, abi: algebraFactoryAbi, functionName: "customPoolByPair", args: [quoteDeployer, tokenIn, tokenOut] };
  const [quoterCode, factoryCode, quoterFactory, resolvedPool] = await Promise.all([
    rpcClient.getCode({ address: quoter }),
    rpcClient.getCode({ address: factory }),
    rpcClient.readContract({ address: quoter, abi: algebraQuoterAbi, functionName: "factory" }),
    rpcClient.readContract(poolRequest),
  ]);
  if (!quoterCode || quoterCode === "0x") throw new Error("SparkDEX quoter has no deployed code");
  if (!factoryCode || factoryCode === "0x") throw new Error("SparkDEX factory has no deployed code");
  if (!sameAddress(quoterFactory, factory)) throw new Error(`SparkDEX quoter factory mismatch: ${quoterFactory}`);
  if (!sameAddress(resolvedPool, expectedPool)) throw new Error(`SparkDEX quote pool mismatch: ${resolvedPool}`);
  const { result } = await rpcClient.simulateContract({
    address: quoter,
    abi: algebraQuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, deployer: quoteDeployer, amountIn, limitSqrtPrice: 0n }],
  });
  const [amountOut, quotedAmountIn, sqrtPriceAfter, initializedTicksCrossed, quoteGasEstimate, fee] = result;
  if (quotedAmountIn !== amountIn) throw new Error(`SparkDEX quote used ${quotedAmountIn} of ${amountIn} input units`);
  if (amountOut <= 0n) throw new Error("SparkDEX quote returned no output");
  return { amountOut, amountIn: quotedAmountIn, sqrtPriceAfter, initializedTicksCrossed, quoteGasEstimate, fee, pool: resolvedPool };
}

export async function verifyExecutionRoute({ rpcClient, manager, expectedAdapter, expectedPool, tokenIn, tokenOut }) {
  const poolKey = keccak256(encodePacked(["address", "address"], [tokenIn, tokenOut]));
  const [adapter, adapterCode, activePool] = await Promise.all([
    rpcClient.readContract({ address: manager, abi, functionName: "swapAdapter" }),
    rpcClient.getCode({ address: expectedAdapter }),
    rpcClient.readContract({ address: expectedAdapter, abi: adapterAbi, functionName: "poolFor", args: [poolKey] }),
  ]);
  if (!sameAddress(adapter, expectedAdapter)) throw new Error(`Ballast swap adapter mismatch: ${adapter}`);
  if (!adapterCode || adapterCode === "0x") throw new Error("Ballast swap adapter has no deployed code");
  if (!sameAddress(activePool, expectedPool)) throw new Error(`Ballast active pool mismatch: ${activePool}`);
  return { adapter, pool: activePool };
}

function log(level, event, fields = {}) {
  const line = { timestamp: new Date().toISOString(), level, event, service: "ballast-keeper", ...fields };
  const output = JSON.stringify(line);
  (level === "error" ? console.error : console.log)(output);
}

function topicAddress(topic) {
  if (typeof topic !== "string" || !/^0x[0-9a-f]{64}$/i.test(topic)) return null;
  return getAddress(`0x${topic.slice(-40)}`);
}

function topicId(topic) {
  return typeof topic === "string" && /^0x[0-9a-f]{64}$/i.test(topic) ? topic.toLowerCase() : null;
}

function compareLogs(left, right) {
  const leftBlock = BigInt(left.blockNumber ?? 0);
  const rightBlock = BigInt(right.blockNumber ?? 0);
  if (leftBlock !== rightBlock) return leftBlock < rightBlock ? -1 : 1;
  const leftIndex = BigInt(left.logIndex ?? 0);
  const rightIndex = BigInt(right.logIndex ?? 0);
  if (leftIndex === rightIndex) return 0;
  return leftIndex < rightIndex ? -1 : 1;
}

export function applyPolicyLogs(policyMap, logs) {
  for (const logEntry of [...logs].sort(compareLogs)) {
    const topics = logEntry.topics || [];
    const borrower = topicAddress(topics[1]);
    const id = topicId(topics[2]);
    if (!borrower || !id) continue;
    const key = `${borrower.toLowerCase()}:${id}`;
    const eventTopic = typeof topics[0] === "string" ? topics[0].toLowerCase() : "";
    if (eventTopic === POLICY_DISABLED_TOPIC.toLowerCase()) policyMap.delete(key);
    if (eventTopic === POLICY_SET_TOPIC.toLowerCase()) policyMap.set(key, { borrower, id });
  }
  return policyMap;
}

function statePolicyMap(policies) {
  const map = new Map();
  for (const { borrower, id } of policies) {
    map.set(`${borrower.toLowerCase()}:${id.toLowerCase()}`, { borrower, id: id.toLowerCase() });
  }
  return map;
}

function stateMatches(state, expected) {
  return state?.version === 1
    && state.chainId === expected.chainId
    && state.manager === expected.manager.toLowerCase()
    && state.fromBlock === expected.fromBlock.toString();
}

export function loadDiscoveryState(filePath, expected) {
  if (!existsSync(filePath)) return null;
  const state = JSON.parse(readFileSync(filePath, "utf8"));
  if (!stateMatches(state, expected)) return null;
  const nextBlock = BigInt(state.nextBlock);
  if (nextBlock < expected.fromBlock || !Array.isArray(state.policies)) throw new Error("keeper state is invalid");
  const policies = state.policies.map(({ borrower, id }) => ({ borrower: getAddress(borrower), id: topicId(id) }));
  if (policies.some(({ id }) => !id)) throw new Error("keeper state contains an invalid policy id");
  return { nextBlock, policies };
}

export function saveDiscoveryState(filePath, { chainId, manager, fromBlock, nextBlock, policies }) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({
    version: 1,
    chainId,
    manager: manager.toLowerCase(),
    fromBlock: fromBlock.toString(),
    nextBlock: nextBlock.toString(),
    policies,
  })}\n`, { mode: 0o600 });
  renameSync(temporaryPath, filePath);
}

export function enforcePositionLimit(policies, maxPositions = MAX_POSITIONS) {
  if (maxPositions > 0 && policies.length > maxPositions) {
    throw new Error(`discovered ${policies.length} policies, exceeding MAX_POSITIONS=${maxPositions}; refusing partial coverage`);
  }
  return policies;
}

export function selectSyncTarget(latestBlock, indexedBlock, confirmationBlocks = CONFIRMATION_BLOCKS) {
  const confirmations = BigInt(confirmationBlocks);
  const confirmedBlock = latestBlock > confirmations ? latestBlock - confirmations : 0n;
  return indexedBlock < confirmedBlock ? indexedBlock : confirmedBlock;
}

export function buildRpcLogRanges(fromBlock, toBlock, pageBlocks = RPC_LOG_PAGE_BLOCKS) {
  const size = BigInt(pageBlocks);
  if (fromBlock < 0n || toBlock < fromBlock || size < 1n || size > 30n) throw new Error("invalid RPC log range");
  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += size) {
    ranges.push({ fromBlock: start, toBlock: start + size - 1n > toBlock ? toBlock : start + size - 1n });
  }
  return ranges;
}

async function fetchBlockscoutJson(url, label) {
  return withRetry(async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${label} failed: ${response.status} ${response.statusText}`);
    return response.json();
  }, {
    label,
    onRetry: ({ label: retryLabel, attempt, delay, error }) => log("warn", "retry_scheduled", { label: retryLabel, attempt, delayMs: delay, error: error.message }),
  });
}

export function validateBlockscoutTip(stats, indexingStatus) {
  if (indexingStatus?.finished_indexing_blocks !== true) throw new Error("Blockscout block indexing is incomplete");
  try {
    const totalBlocks = BigInt(stats.total_blocks);
    if (totalBlocks < 0n) throw new Error("negative block height");
    return totalBlocks;
  } catch (error) {
    throw new Error(`Blockscout returned an invalid indexed block: ${error.message}`);
  }
}

async function blockscoutTip() {
  const [stats, indexingStatus] = await Promise.all([
    fetchBlockscoutJson(`${BLOCKSCOUT_URL}/api/v2/stats`, "blockscout.stats"),
    fetchBlockscoutJson(`${BLOCKSCOUT_URL}/api/v2/main-page/indexing-status`, "blockscout.indexingStatus"),
  ]);
  return validateBlockscoutTip(stats, indexingStatus);
}

async function blockscoutLogPage(cursor) {
  const url = new URL(`/api/v2/addresses/${BALLAST}/logs`, `${BLOCKSCOUT_URL}/`);
  for (const [name, value] of Object.entries(cursor || {})) url.searchParams.set(name, String(value));
  return fetchBlockscoutJson(url, "blockscout.addressLogs");
}

export async function collectPolicyLogs({ fromBlock, toBlock, fetchPage = blockscoutLogPage }) {
  if (fromBlock < 0n || toBlock < fromBlock) throw new Error("invalid policy log range");
  const logs = [];
  const seenCursors = new Set();
  let cursor = null;
  let pageCount = 0;
  while (true) {
    const payload = await fetchPage(cursor);
    pageCount += 1;
    if (!Array.isArray(payload.items)) throw new Error("Blockscout returned an invalid address log page");
    let previousPosition = null;
    let reachedBeforeStart = false;
    for (const item of payload.items) {
      const blockNumber = BigInt(item.block_number);
      const logIndex = BigInt(item.index ?? 0);
      if (previousPosition && (blockNumber > previousPosition.blockNumber
        || (blockNumber === previousPosition.blockNumber && logIndex > previousPosition.logIndex))) {
        throw new Error("Blockscout address logs are not newest-first");
      }
      previousPosition = { blockNumber, logIndex };
      if (blockNumber < fromBlock) {
        reachedBeforeStart = true;
        continue;
      }
      if (blockNumber > toBlock) continue;
      const eventTopic = typeof item.topics?.[0] === "string" ? item.topics[0].toLowerCase() : "";
      if (eventTopic === POLICY_SET_TOPIC.toLowerCase() || eventTopic === POLICY_DISABLED_TOPIC.toLowerCase()) {
        logs.push({ blockNumber, logIndex, topics: item.topics });
      }
    }
    if (reachedBeforeStart || !payload.next_page_params) return { logs, pageCount };
    const cursorKey = JSON.stringify(payload.next_page_params);
    if (seenCursors.has(cursorKey)) throw new Error("Blockscout returned a repeated log cursor");
    seenCursors.add(cursorKey);
    cursor = payload.next_page_params;
  }
}

export async function collectRpcPolicyLogs({ fromBlock, toBlock, request = (args) => publicClient.request(args) }) {
  const ranges = buildRpcLogRanges(fromBlock, toBlock);
  const pages = await mapWithConcurrency(ranges, LOG_QUERY_CONCURRENCY, async (range) => withRetry(() => request({
    method: "eth_getLogs",
    params: [{
      address: BALLAST,
      topics: [[POLICY_SET_TOPIC, POLICY_DISABLED_TOPIC]],
      fromBlock: `0x${range.fromBlock.toString(16)}`,
      toBlock: `0x${range.toBlock.toString(16)}`,
    }],
  }), {
    label: "rpc.getLogs",
    onRetry: ({ label, attempt, delay, error }) => log("warn", "retry_scheduled", { label, attempt, delayMs: delay, error: error.message }),
  }));
  const failed = pages.find((page) => page?.error);
  if (failed) throw failed.error;
  return { logs: pages.flat(), pageCount: ranges.length };
}

export async function discoverPolicies() {
  const expected = { chainId: chain.id, manager: BALLAST, fromBlock: FROM_BLOCK };
  const state = loadDiscoveryState(STATE_FILE, expected);
  const latest = await withRetry(() => publicClient.getBlockNumber(), { label: "rpc.getBlockNumber" });
  const confirmed = latest > BigInt(CONFIRMATION_BLOCKS) ? latest - BigInt(CONFIRMATION_BLOCKS) : 0n;
  const startBlock = state?.nextBlock || FROM_BLOCK;
  const latestByPolicy = statePolicyMap(state?.policies || []);
  if (confirmed < startBlock) {
    const policies = enforcePositionLimit([...latestByPolicy.values()]);
    log("info", "policy_index_waiting", { chainTip: latest.toString(), confirmedTip: confirmed.toString(), nextBlock: startBlock.toString(), policyCount: policies.length });
    return policies;
  }
  let blockscoutPages = 0;
  let rpcPages = 0;
  let eventCount = 0;
  let rpcStart = startBlock;
  let indexed = null;
  if (!state) {
    indexed = await blockscoutTip();
    const blockscoutTarget = selectSyncTarget(latest, indexed);
    if (startBlock <= blockscoutTarget) {
      const historical = await collectPolicyLogs({ fromBlock: startBlock, toBlock: blockscoutTarget });
      applyPolicyLogs(latestByPolicy, historical.logs);
      blockscoutPages = historical.pageCount;
      eventCount += historical.logs.length;
      rpcStart = blockscoutTarget + 1n;
    }
  }
  if (rpcStart <= confirmed) {
    const recent = await collectRpcPolicyLogs({ fromBlock: rpcStart, toBlock: confirmed });
    applyPolicyLogs(latestByPolicy, recent.logs);
    rpcPages = recent.pageCount;
    eventCount += recent.logs.length;
  }
  const policies = enforcePositionLimit([...latestByPolicy.values()]);
  saveDiscoveryState(STATE_FILE, {
    chainId: chain.id,
    manager: BALLAST,
    fromBlock: FROM_BLOCK,
    nextBlock: confirmed + 1n,
    policies,
  });
  log("info", "policy_index_updated", { fromBlock: startBlock.toString(), toBlock: confirmed.toString(), chainTip: latest.toString(), indexedTip: indexed?.toString() || null, blockscoutPages, rpcPages, eventCount, policyCount: policies.length, stateFile: STATE_FILE });
  return policies;
}

export function shouldSkipForDifferentKeeper({ managerVersion, policyKeeper, operator }) {
  if (managerVersion !== "v3") return false;
  if (!operator) return false;
  if (!policyKeeper) return true;
  return policyKeeper.toLowerCase() !== operator.toLowerCase();
}

export function assertSuccessfulReceipt(receipt, hash) {
  if (receipt.status !== "success") throw new Error(`protection transaction reverted: ${hash}`);
  return receipt;
}

export function validateExecutionHealth({
  state,
  expectedReleaseCommit = EXPECTED_RELEASE_COMMIT,
  nowMs = Date.now(),
  maxAgeMs = EXECUTION_HEALTH_MAX_AGE_MS,
}) {
  if (!expectedReleaseCommit) throw new Error("production health gate has no expected release commit");
  if (state?.version !== 3 || !["ok", "failed"].includes(state.status) || state.executionStatus !== "ok") {
    throw new Error("production health gate is not passing");
  }
  const checkedAtMs = Date.parse(state.checkedAt);
  if (!Number.isFinite(checkedAtMs)) throw new Error("production health gate timestamp is invalid");
  const ageMs = nowMs - checkedAtMs;
  if (ageMs < 0 || ageMs > maxAgeMs) throw new Error(`production health gate is stale: ${Math.round(ageMs / 1000)}s old`);
  if (state.releaseCommit !== expectedReleaseCommit) {
    throw new Error(`production health gate release mismatch: ${state.releaseCommit || "missing"}`);
  }
  return { ageMs: Math.round(ageMs), releaseCommit: state.releaseCommit };
}

function requireExecutionHealth() {
  if (!existsSync(HEALTH_STATE_FILE)) throw new Error(`production health gate is missing: ${HEALTH_STATE_FILE}`);
  return validateExecutionHealth({ state: JSON.parse(readFileSync(HEALTH_STATE_FILE, "utf8")) });
}

export function handleCycleFailure(error, runOnce = RUN_ONCE) {
  if (runOnce) throw error;
}

const formatHealth = (value) => formatUnits(value, 18);

async function readMarketTokens(id) {
  const [loanToken, collateralToken] = await withRetry(
    () => publicClient.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [id] }),
    { label: "rpc.idToMarketParams" },
  );
  return { loanToken, collateralToken };
}

async function inspectPolicy(row) {
  const [policy, preview] = await Promise.all([
    withRetry(() => publicClient.readContract({ address: BALLAST, abi, functionName: "policyOf", args: [row.borrower, row.id] }), { label: "rpc.policyOf" }),
    withRetry(() => publicClient.readContract({ address: BALLAST, abi, functionName: "previewProtect", args: [row.borrower, row.id] }), { label: "rpc.previewProtect" }),
  ]);
  const [actionable, health, repayAssets, collateralNeeded] = preview;
  const [trigger, target, cap, slippage, keeperFeeBps, cooldown, lastAction, enabled, keeper = null] = policy;
  return { ...row, actionable, health, repayAssets, collateralNeeded, trigger, target, cap, slippage, keeperFeeBps, cooldown, lastAction, enabled, keeper };
}

async function processPolicy(row) {
  try {
    const item = await inspectPolicy(row);
    log("info", "policy_inspected", { borrower: item.borrower, id: item.id, enabled: item.enabled, actionable: item.actionable, health: formatHealth(item.health), trigger: formatHealth(item.trigger), repayAssets: item.repayAssets.toString(), collateralNeeded: item.collateralNeeded.toString() });
    if (!item.enabled || !item.actionable) return { status: "skipped", reason: item.enabled ? "not_actionable" : "disabled" };
    if (shouldSkipForDifferentKeeper({ managerVersion: MANAGER_VERSION, policyKeeper: item.keeper, operator: operatorAddress })) {
      log("info", "policy_skipped", { borrower: item.borrower, id: item.id, reason: "different_keeper", configuredKeeper: item.keeper, operator: operatorAddress });
      return { status: "skipped", reason: "different_keeper" };
    }
    if (!EXECUTE) return { status: "dry_run", reason: "execution_disabled" };
    return await runSerializedExecution(async () => {
      const healthGate = requireExecutionHealth();
      log("info", "execution_health_gate_passed", healthGate);

      const currentItem = await inspectPolicy(row);
      if (!currentItem.enabled || !currentItem.actionable) return { status: "skipped", reason: "state_changed" };
      if (shouldSkipForDifferentKeeper({ managerVersion: MANAGER_VERSION, policyKeeper: currentItem.keeper, operator: operatorAddress })) {
        return { status: "skipped", reason: "different_keeper" };
      }
      const marketTokens = await readMarketTokens(currentItem.id);
      if (!sameAddress(marketTokens.collateralToken, executionConfiguration.collateralToken)
        || !sameAddress(marketTokens.loanToken, executionConfiguration.loanToken)) {
        throw new Error(`policy market tokens do not match the configured SparkDEX route: ${marketTokens.collateralToken}/${marketTokens.loanToken}`);
      }
      await withRetry(() => publicClient.simulateContract({ account, address: BALLAST, abi, functionName: "protect", args: [currentItem.borrower, currentItem.id] }), { label: "rpc.simulateProtect" });
      const gasEstimate = await withRetry(() => publicClient.estimateContractGas({ account, address: BALLAST, abi, functionName: "protect", args: [currentItem.borrower, currentItem.id] }), { label: "rpc.estimateProtect" });
      const gasPrice = await withRetry(() => publicClient.getGasPrice(), { label: "rpc.getGasPrice" });
      const quote = await withRetry(() => quoteSwapOutput({
        rpcClient: publicClient,
        quoter: executionConfiguration.quoter,
        factory: executionConfiguration.factory,
        quoteDeployer: executionConfiguration.quoteDeployer,
        expectedPool: executionConfiguration.activePool,
        tokenIn: marketTokens.collateralToken,
        tokenOut: marketTokens.loanToken,
        amountIn: currentItem.collateralNeeded,
      }), { label: "rpc.quoteSparkDex" });
      const economics = calculateEconomics({
        repayAssets: currentItem.repayAssets,
        keeperFeeBps: currentItem.keeperFeeBps,
        quotedAmountOut: quote.amountOut,
        quoteHaircutBps: executionConfiguration.quoteHaircutBps,
        gasEstimate,
        gasPrice,
        maxGasFlrWei: executionConfiguration.maxGasFlrWei,
        minKeeperFeeUnits: executionConfiguration.minKeeperFeeUnits,
        loanTokenUnitsPerFlr: executionConfiguration.loanTokenUnitsPerFlr,
        minProfitFlrWei: executionConfiguration.minProfitFlrWei,
      });
      if (!economics.ok) {
        log("warn", "policy_rejected_economics", {
          borrower: currentItem.borrower,
          id: currentItem.id,
          reason: economics.reason,
          quotedAmountOut: economics.quotedAmountOut?.toString() || null,
          conservativeAmountOut: economics.conservativeAmountOut?.toString() || null,
          quotedSurplus: economics.quotedSurplus?.toString() || null,
          expectedKeeperFee: economics.expectedKeeperFee?.toString() || null,
          gasCostFlrWei: economics.gasCostFlrWei?.toString() || null,
        });
        return { status: "skipped", reason: economics.reason };
      }

      const executionRoute = await withRetry(() => verifyExecutionRoute({
        rpcClient: publicClient,
        manager: BALLAST,
        expectedAdapter: executionConfiguration.adapter,
        expectedPool: executionConfiguration.activePool,
        tokenIn: marketTokens.collateralToken,
        tokenOut: marketTokens.loanToken,
      }), { label: "rpc.verifyExecutionRoute" });

      const data = encodeFunctionData({ abi, functionName: "protect", args: [currentItem.borrower, currentItem.id] });
      const { hash } = await prepareSignAndBroadcastTransaction({
        prepareTransaction: () => withRetry(
          () => walletClient.prepareTransactionRequest({ account, to: BALLAST, data, gas: gasEstimate }),
          { label: "rpc.prepareProtect" },
        ),
        signTransaction: (request) => account.signTransaction(request, { serializer: chain.serializers?.transaction }),
        sendRawTransaction: (request) => walletClient.sendRawTransaction(request),
        onRetry: ({ label, attempt, delay, error }) => log("warn", "retry_scheduled", { label, attempt, delayMs: delay, error: error.message }),
      });
      const receipt = await withRetry(() => publicClient.waitForTransactionReceipt({ hash }), { label: "rpc.waitForReceipt" });
      assertSuccessfulReceipt(receipt, hash);
      log("info", "protection_confirmed", { borrower: currentItem.borrower, id: currentItem.id, hash, status: receipt.status, blockNumber: receipt.blockNumber.toString(), gasEstimate: gasEstimate.toString(), gasPrice: gasPrice.toString(), adapter: executionRoute.adapter, pool: executionRoute.pool, quotedAmountOut: economics.quotedAmountOut.toString(), conservativeAmountOut: economics.conservativeAmountOut.toString(), expectedKeeperFee: economics.expectedKeeperFee.toString() });
      return { status: "confirmed", hash };
    });
  } catch (error) {
    log("error", "policy_failed", { borrower: row.borrower, id: row.id, error: error.shortMessage || error.message });
    return { status: "failed", error };
  }
}

export async function runCycle() {
  const policies = await withRetry(discoverPolicies, { label: "discoverPolicies" });
  log("info", "cycle_started", { chainId: chain.id, ballast: BALLAST, managerVersion: MANAGER_VERSION, mode: EXECUTE ? "execute" : "dry_run", policyCount: policies.length });
  if (!policies.length) {
    log("info", "cycle_empty", { reason: "no_policy_events" });
    return { policies: 0, actionable: 0, confirmed: 0, failed: 0 };
  }
  const results = await mapWithConcurrency(policies, MAX_CONCURRENCY, processPolicy);
  const summary = { policies: policies.length, actionable: results.filter((result) => ["dry_run", "confirmed"].includes(result?.status)).length, confirmed: results.filter((result) => result?.status === "confirmed").length, failed: results.filter((result) => result?.status === "failed").length };
  log("info", "cycle_finished", summary);
  return summary;
}

export async function main() {
  const releaseExecutionLock = acquireExecutionLock();
  try {
    log("info", "keeper_started", { chainId: chain.id, ballast: BALLAST, managerVersion: MANAGER_VERSION, mode: EXECUTE ? "execute" : "dry_run", operator: operatorAddress || null, operatorSource: operatorAccount ? "private_key" : operatorAddress ? "address" : null, runOnce: RUN_ONCE, pollIntervalMs: POLL_INTERVAL_MS, maxConcurrency: MAX_CONCURRENCY, maxPositions: MAX_POSITIONS, stateFile: STATE_FILE, healthStateFile: HEALTH_STATE_FILE, expectedReleaseCommit: EXPECTED_RELEASE_COMMIT, blockscoutUrl: BLOCKSCOUT_URL, confirmationBlocks: CONFIRMATION_BLOCKS, rpcLogPageBlocks: RPC_LOG_PAGE_BLOCKS, logQueryConcurrency: LOG_QUERY_CONCURRENCY });
    if (MANAGER_VERSION === "v3" && !operatorAddress) {
      log("warn", "keeper_identity_unverified", { reason: "no_operator_address_in_dry_run" });
    }
    do {
      try {
        await runCycle();
      } catch (error) {
        log("error", "cycle_failed", { error: error.shortMessage || error.message });
        handleCycleFailure(error);
      }
      if (!RUN_ONCE) await sleep(POLL_INTERVAL_MS);
    } while (!RUN_ONCE);
  } finally {
    releaseExecutionLock();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
