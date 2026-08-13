#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  getAddress,
  toEventSelector,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = process.env.RPC_URL || "https://flare-api.flare.network/ext/C/rpc";
const BLOCKSCOUT_URL = (process.env.BLOCKSCOUT_URL
  || process.env.EXPLORER_URL?.replace(/\/api\/?$/, "")
  || "https://flare-explorer.flare.network").replace(/\/$/, "");
const BALLAST = getAddress(process.env.BALLAST || "0x746066ACe5dc89a3692137b8cdE3c31328629d09");
const MANAGER_VERSION = process.env.MANAGER_VERSION || "v3";
const DEFAULT_DEPLOYMENT_BLOCK = 67019411n;
const FROM_BLOCK = BigInt(process.env.FROM_BLOCK || DEFAULT_DEPLOYMENT_BLOCK);
const STATE_FILE = process.env.STATE_FILE || join(process.env.HOME || process.cwd(), ".config", "ballast", "keeper-state.json");
const CONFIRMATION_BLOCKS = nonNegativeInteger("CONFIRMATION_BLOCKS", 12);
const RPC_LOG_PAGE_BLOCKS = boundedPositiveInteger("RPC_LOG_PAGE_BLOCKS", 30, 30);
const LOG_QUERY_CONCURRENCY = positiveInteger("LOG_QUERY_CONCURRENCY", 4);
const EXECUTE = process.env.EXECUTE === "true";
const RUN_ONCE = process.env.RUN_ONCE === "true";
const PRIVATE_KEY = loadPrivateKey();
const MAX_POSITIONS = nonNegativeInteger("MAX_POSITIONS", 0);
const MAX_CONCURRENCY = positiveInteger("MAX_CONCURRENCY", 4);
const POLL_INTERVAL_MS = positiveInteger("POLL_INTERVAL_MS", 30_000);
const RETRY_ATTEMPTS = positiveInteger("RETRY_ATTEMPTS", 4);
const RETRY_BASE_DELAY_MS = positiveInteger("RETRY_BASE_DELAY_MS", 500);
const MAX_GAS_FLR_WEI = optionalBigInt("MAX_GAS_FLR_WEI");
const MIN_KEEPER_FEE_UNITS = optionalBigInt("MIN_KEEPER_FEE_UNITS");
const LOAN_TOKEN_UNITS_PER_FLR = optionalBigInt("LOAN_TOKEN_UNITS_PER_FLR");
const MIN_PROFIT_FLR_WEI = optionalBigInt("MIN_PROFIT_FLR_WEI");

const chain = {
  id: 14,
  name: "Flare",
  nativeCurrency: { name: "Flare", symbol: "FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const operatorAccount = PRIVATE_KEY ? privateKeyToAccount(PRIVATE_KEY) : null;
const account = EXECUTE
  ? operatorAccount || (() => { throw new Error("PRIVATE_KEY or PRIVATE_KEY_FILE is required with EXECUTE=true"); })()
  : null;
const walletClient = account ? createWalletClient({ account, chain, transport: http(RPC_URL) }) : null;

const policyResult = MANAGER_VERSION === "v3"
  ? "uint128 triggerHealth, uint128 targetHealth, uint64 maxCollateralPerAction, uint32 maxSlippageBps, uint32 keeperFeeBps, uint32 cooldown, uint64 lastAction, bool enabled, address keeper"
  : "uint128 triggerHealth, uint128 targetHealth, uint64 maxCollateralPerAction, uint32 maxSlippageBps, uint32 keeperFeeBps, uint32 cooldown, uint64 lastAction, bool enabled";
const abi = parseAbi([
  "event PolicySet(address indexed borrower, bytes32 indexed id, uint128 triggerHealth, uint128 targetHealth, uint64 maxCollateralPerAction, uint32 maxSlippageBps)",
  "event PolicyDisabled(address indexed borrower, bytes32 indexed id)",
  `function policyOf(address borrower, bytes32 id) view returns (${policyResult})`,
  "function previewProtect(address borrower, bytes32 id) view returns (bool actionable, uint256 health, uint256 repayAssets, uint256 collateralNeeded)",
  "function protect(address borrower, bytes32 id)",
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

export function calculateEconomics({ repayAssets, keeperFeeBps, gasEstimate, gasPrice, maxGasFlrWei, minKeeperFeeUnits, loanTokenUnitsPerFlr, minProfitFlrWei }) {
  const expectedKeeperFee = (repayAssets * BigInt(keeperFeeBps)) / 10_000n;
  const gasCostFlrWei = gasEstimate * gasPrice;
  if (maxGasFlrWei !== null && gasCostFlrWei > maxGasFlrWei) return { ok: false, reason: "gas_limit_exceeded", expectedKeeperFee, gasCostFlrWei };
  if (minKeeperFeeUnits !== null && expectedKeeperFee < minKeeperFeeUnits) return { ok: false, reason: "keeper_fee_below_minimum", expectedKeeperFee, gasCostFlrWei };
  if (loanTokenUnitsPerFlr !== null && minProfitFlrWei !== null) {
    const revenueFlrWei = (expectedKeeperFee * 10n ** 18n) / loanTokenUnitsPerFlr;
    const profitFlrWei = revenueFlrWei - gasCostFlrWei;
    if (profitFlrWei < minProfitFlrWei) return { ok: false, reason: "profit_below_minimum", expectedKeeperFee, gasCostFlrWei, revenueFlrWei, profitFlrWei };
    return { ok: true, expectedKeeperFee, gasCostFlrWei, revenueFlrWei, profitFlrWei };
  }
  return { ok: true, expectedKeeperFee, gasCostFlrWei, pricingConfigured: false };
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

export function handleCycleFailure(error, runOnce = RUN_ONCE) {
  if (runOnce) throw error;
}

const formatHealth = (value) => formatUnits(value, 18);

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
    if (shouldSkipForDifferentKeeper({ managerVersion: MANAGER_VERSION, policyKeeper: item.keeper, operator: operatorAccount?.address })) {
      log("info", "policy_skipped", { borrower: item.borrower, id: item.id, reason: "different_keeper", configuredKeeper: item.keeper, operator: operatorAccount.address });
      return { status: "skipped", reason: "different_keeper" };
    }
    if (!EXECUTE) return { status: "dry_run", reason: "execution_disabled" };

    const simulation = await withRetry(() => publicClient.simulateContract({ account, address: BALLAST, abi, functionName: "protect", args: [item.borrower, item.id] }), { label: "rpc.simulateProtect" });
    const gasEstimate = await withRetry(() => publicClient.estimateContractGas({ account, address: BALLAST, abi, functionName: "protect", args: [item.borrower, item.id] }), { label: "rpc.estimateProtect" });
    const gasPrice = await withRetry(() => publicClient.getGasPrice(), { label: "rpc.getGasPrice" });
    const economics = calculateEconomics({ repayAssets: item.repayAssets, keeperFeeBps: item.keeperFeeBps, gasEstimate, gasPrice, maxGasFlrWei: MAX_GAS_FLR_WEI, minKeeperFeeUnits: MIN_KEEPER_FEE_UNITS, loanTokenUnitsPerFlr: LOAN_TOKEN_UNITS_PER_FLR, minProfitFlrWei: MIN_PROFIT_FLR_WEI });
    if (!economics.ok) {
      log("warn", "policy_rejected_economics", { borrower: item.borrower, id: item.id, reason: economics.reason, expectedKeeperFee: economics.expectedKeeperFee.toString(), gasCostFlrWei: economics.gasCostFlrWei.toString() });
      return { status: "skipped", reason: economics.reason };
    }
    const hash = await withRetry(() => walletClient.writeContract(simulation.request), { label: "rpc.writeProtect" });
    const receipt = await withRetry(() => publicClient.waitForTransactionReceipt({ hash }), { label: "rpc.waitForReceipt" });
    assertSuccessfulReceipt(receipt, hash);
    log("info", "protection_confirmed", { borrower: item.borrower, id: item.id, hash, status: receipt.status, blockNumber: receipt.blockNumber.toString(), gasEstimate: gasEstimate.toString(), gasPrice: gasPrice.toString(), expectedKeeperFee: economics.expectedKeeperFee.toString() });
    return { status: "confirmed", hash };
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
  log("info", "keeper_started", { chainId: chain.id, ballast: BALLAST, managerVersion: MANAGER_VERSION, mode: EXECUTE ? "execute" : "dry_run", operator: operatorAccount?.address || null, runOnce: RUN_ONCE, pollIntervalMs: POLL_INTERVAL_MS, maxConcurrency: MAX_CONCURRENCY, maxPositions: MAX_POSITIONS, stateFile: STATE_FILE, blockscoutUrl: BLOCKSCOUT_URL, confirmationBlocks: CONFIRMATION_BLOCKS, rpcLogPageBlocks: RPC_LOG_PAGE_BLOCKS, logQueryConcurrency: LOG_QUERY_CONCURRENCY });
  if (MANAGER_VERSION === "v3" && !operatorAccount) {
    log("warn", "keeper_identity_unverified", { reason: "no_private_key_in_dry_run" });
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
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
