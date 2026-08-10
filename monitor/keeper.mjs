#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
const EXPLORER_URL = process.env.EXPLORER_URL || "https://flare-explorer.flare.network/api";
const BALLAST = getAddress(process.env.BALLAST || "0x379e5B8Cf31fC5D46aEc2fc17F17708951015571");
const MANAGER_VERSION = process.env.MANAGER_VERSION || "v1";
const DEFAULT_DEPLOYMENT_BLOCK = 66714351n;
const FROM_BLOCK = BigInt(process.env.FROM_BLOCK || DEFAULT_DEPLOYMENT_BLOCK);
const EXECUTE = process.env.EXECUTE === "true";
const RUN_ONCE = process.env.RUN_ONCE === "true";
const PRIVATE_KEY = loadPrivateKey();
const MAX_POSITIONS = positiveInteger("MAX_POSITIONS", 100);
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
const account = EXECUTE
  ? privateKeyToAccount(PRIVATE_KEY || (() => { throw new Error("PRIVATE_KEY or PRIVATE_KEY_FILE is required with EXECUTE=true"); })())
  : null;
const walletClient = account ? createWalletClient({ account, chain, transport: http(RPC_URL) }) : null;

const policyResult = MANAGER_VERSION === "v3"
  ? "uint128 triggerHealth, uint128 targetHealth, uint64 maxCollateralPerAction, uint32 maxSlippageBps, uint32 keeperFeeBps, uint32 cooldown, uint64 lastAction, bool enabled, address keeper"
  : "uint128 triggerHealth, uint128 targetHealth, uint64 maxCollateralPerAction, uint32 maxSlippageBps, uint32 keeperFeeBps, uint32 cooldown, uint64 lastAction, bool enabled";
const abi = parseAbi([
  "event PolicySet(address indexed borrower, bytes32 indexed id, uint128 triggerHealth, uint128 targetHealth, uint64 maxCollateralPerAction, uint32 maxSlippageBps)",
  `function policyOf(address borrower, bytes32 id) view returns (${policyResult})`,
  "function previewProtect(address borrower, bytes32 id) view returns (bool actionable, uint256 health, uint256 repayAssets, uint256 collateralNeeded)",
  "function protect(address borrower, bytes32 id)",
]);
const POLICY_SET_TOPIC = toEventSelector("PolicySet(address,bytes32,uint128,uint128,uint64,uint32)");

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

async function discoverPolicies() {
  const latest = await withRetry(() => publicClient.getBlockNumber(), { label: "rpc.getBlockNumber" });
  const query = new URLSearchParams({ module: "logs", action: "getLogs", fromBlock: FROM_BLOCK.toString(), toBlock: latest.toString(), address: BALLAST, topic0: POLICY_SET_TOPIC });
  const response = await withRetry(() => fetch(`${EXPLORER_URL}?${query}`), {
    label: "explorer.getLogs",
    onRetry: ({ label, attempt, delay, error }) => log("warn", "retry_scheduled", { label, attempt, delayMs: delay, error: error.message }),
  });
  if (!response.ok) throw new Error(`explorer request failed: ${response.status} ${response.statusText}`);
  const payload = await response.json();
  if (!Array.isArray(payload.result) && !/no logs/i.test(payload.message || "")) throw new Error(`explorer returned ${payload.message || "an invalid response"}`);
  const latestByPolicy = new Map();
  for (const logEntry of Array.isArray(payload.result) ? payload.result : []) {
    const borrower = logEntry.topics?.[1] ? getAddress(`0x${logEntry.topics[1].slice(-40)}`) : null;
    const id = logEntry.topics?.[2];
    if (borrower && id) latestByPolicy.set(`${borrower.toLowerCase()}:${id.toLowerCase()}`, { borrower, id });
  }
  return [...latestByPolicy.values()].slice(-MAX_POSITIONS);
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
    if (MANAGER_VERSION === "v3" && EXECUTE && item.keeper?.toLowerCase() !== account.address.toLowerCase()) {
      log("info", "policy_skipped", { borrower: item.borrower, id: item.id, reason: "different_keeper", configuredKeeper: item.keeper, operator: account.address });
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
  log("info", "keeper_started", { chainId: chain.id, ballast: BALLAST, managerVersion: MANAGER_VERSION, mode: EXECUTE ? "execute" : "dry_run", runOnce: RUN_ONCE, pollIntervalMs: POLL_INTERVAL_MS, maxConcurrency: MAX_CONCURRENCY });
  do {
    try {
      await runCycle();
    } catch (error) {
      log("error", "cycle_failed", { error: error.shortMessage || error.message });
    }
    if (!RUN_ONCE) await sleep(POLL_INTERVAL_MS);
  } while (!RUN_ONCE);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
