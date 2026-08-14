#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, encodePacked, getAddress, http, keccak256, parseAbi, zeroAddress } from "viem";

const RPC_URL = process.env.RPC_URL || "https://flare-api.flare.network/ext/C/rpc";
const COSTON2_RPC = process.env.COSTON2_RPC || "https://coston2-api.flare.network/ext/C/rpc";
const BALLAST = getAddress(process.env.BALLAST || "0x746066ACe5dc89a3692137b8cdE3c31328629d09");
const ADAPTER = getAddress(process.env.ADAPTER || "0xA3B9822228b6d0DE77089B0C67Ec0A73A9A9C202");
const OWNER = getAddress(process.env.OWNER || "0x302a6505c225bBB145569F35B89611d0677195a9");
const GUARDIAN = getAddress(process.env.GUARDIAN || "0xFf97ED39EAe2a4f5fa79097EdDbFD4c27876f8ce");
const EXPECTED_KEEPER = getAddress(process.env.EXPECTED_KEEPER || "0xA20a59090f609329405F5DcA785Af9357F6965E7");
const OPERATOR_ADDRESS = process.env.OPERATOR_ADDRESS?.trim()
  ? getAddress(process.env.OPERATOR_ADDRESS.trim())
  : null;
const ACTIVE_POOL = getAddress(process.env.ACTIVE_POOL || "0x927485d88a66253c63Af9163dca5f21c25A57393");
const COLLATERAL_TOKEN = getAddress(process.env.COLLATERAL_TOKEN || "0xAd552A648C74D49E10027AB8a618A3ad4901c5bE");
const LOAN_TOKEN = getAddress(process.env.LOAN_TOKEN || "0xe7cd86e13AC4309349F30B3435a9d337750fC82D");
const SPARKDEX_QUOTER = getAddress(process.env.SPARKDEX_QUOTER || "0x6AD6A4f233F1E33613e996CCc17409B93fF8bf5f");
const SPARKDEX_FACTORY = getAddress(process.env.SPARKDEX_FACTORY || "0x805488DaA81c1b9e7C5cE3f1DCeA28F21448EC6A");
const SPARKDEX_QUOTE_DEPLOYER = getAddress(process.env.SPARKDEX_QUOTE_DEPLOYER || zeroAddress);
const HEALTHCHECK_QUOTE_AMOUNT = BigInt(process.env.HEALTHCHECK_QUOTE_AMOUNT || "1000000");
if (HEALTHCHECK_QUOTE_AMOUNT <= 0n) throw new Error("HEALTHCHECK_QUOTE_AMOUNT must be greater than zero");
const POOL_KEY = keccak256(encodePacked(["address", "address"], [COLLATERAL_TOKEN, LOAN_TOKEN]));
const FROM_BLOCK = String(process.env.FROM_BLOCK || "67019411");
const STATE_FILE = process.env.STATE_FILE || join(process.env.HOME || process.cwd(), ".config", "ballast", "keeper-state.json");
const HEALTH_STATE_FILE = process.env.HEALTH_STATE_FILE || join(process.env.HOME || process.cwd(), ".config", "ballast", "health-state.json");
const PUBLIC_HEALTH_FILE = process.env.PUBLIC_HEALTH_FILE?.trim();
const MAX_STATE_AGE_MS = nonNegativeInteger("HEALTHCHECK_MAX_STATE_AGE_MS", 180_000);
const KEEPER_UNIT = process.env.KEEPER_UNIT || "ballast-keeper.service";
const CHECK_KEEPER_SERVICE = process.env.HEALTHCHECK_KEEPER_SERVICE !== "false";
const CHECK_FCC = process.env.HEALTHCHECK_FCC !== "false";
const CHECK_STATIC = process.env.HEALTHCHECK_STATIC !== "false";
const FCC_INFO_URL = process.env.FCC_INFO_URL || "https://ballast.rouma.online/info";
const EXT_PROXY_URL = process.env.EXT_PROXY_URL || "https://ballast.rouma.online";
const FLARE_TEE_MANAGER = getAddress(process.env.FLARE_TEE_MANAGER || "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE");
const TEE_ID = getAddress(process.env.TEE_ID || "0xd56b33B50F76E126616d9545E3469De45415d152");
const EXTENSION_ID = BigInt(process.env.EXTENSION_ID || "0x10246");
const STATIC_URLS = [
  process.env.PRODUCT_URL || "https://ballast.rouma.online/product/",
  process.env.DASHBOARD_URL || "https://ballast.rouma.online/risk/",
  process.env.ENROLLMENT_URL || "https://ballast.rouma.online/enroll/",
];
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL?.trim();
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXPECTED_RELEASE_COMMIT = process.env.EXPECTED_RELEASE_COMMIT
  || (existsSync(join(REPO_ROOT, "release.json"))
    ? readJson(join(REPO_ROOT, "release.json")).commit
    : execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
if (!/^[0-9a-f]{40}$/i.test(EXPECTED_RELEASE_COMMIT || "")) {
  throw new Error("EXPECTED_RELEASE_COMMIT must be a full Git commit hash");
}

const flareClient = createPublicClient({ transport: http(RPC_URL, { retryCount: 2, timeout: 20_000 }) });
const coston2Client = createPublicClient({ transport: http(COSTON2_RPC, { retryCount: 2, timeout: 20_000 }) });
const managerAbi = parseAbi([
  "function paused() view returns (bool)",
  "function swapAdapter() view returns (address)",
  "function owner() view returns (address)",
  "function guardian() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function pendingSwapAdapter() view returns (address)",
]);
const adapterAbi = parseAbi([
  "function manager() view returns (address)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function poolFor(bytes32 key) view returns (address)",
  "function pendingPool(bytes32 key) view returns (address)",
]);
const quoterAbi = parseAbi([
  "function factory() view returns (address)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,address deployer,uint256 amountIn,uint160 limitSqrtPrice) params) returns (uint256 amountOut,uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate,uint16 fee)",
]);
const algebraFactoryAbi = parseAbi(["function poolByPair(address token0,address token1) view returns (address)"]);
const teeAbi = parseAbi([
  "function getExtensionId(address teeId) view returns (uint256)",
  "function getTeeMachine(address teeId) view returns ((address machineId, address owner, string url))",
  "function getTeeMachineStatus(address teeId) view returns (uint8)",
]);

function nonNegativeInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      lastError = error;
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

export function validateKeeperState({ state, manager = BALLAST, modifiedMs, nowMs = Date.now(), maxAgeMs = MAX_STATE_AGE_MS }) {
  if (state.version !== 1 || state.chainId !== 14 || state.manager !== manager.toLowerCase()) {
    throw new Error("keeper state identity does not match Flare V3");
  }
  if (!Array.isArray(state.policies) || !/^\d+$/.test(String(state.nextBlock))) {
    throw new Error("keeper state shape is invalid");
  }
  if (String(state.fromBlock) !== FROM_BLOCK) throw new Error("keeper state deployment block does not match Flare V3");
  const ageMs = nowMs - modifiedMs;
  if (ageMs < 0 || ageMs > maxAgeMs) throw new Error(`keeper state is stale: ${Math.round(ageMs / 1000)}s old`);
  return { nextBlock: state.nextBlock, policyCount: state.policies.length, ageMs: Math.round(ageMs) };
}

function checkKeeperState() {
  if (!existsSync(STATE_FILE)) throw new Error(`keeper state is missing: ${STATE_FILE}`);
  const state = readJson(STATE_FILE);
  return validateKeeperState({ state, modifiedMs: statSync(STATE_FILE).mtimeMs });
}

export function validateKeeperIdentity({ operatorAddress, expectedKeeper = EXPECTED_KEEPER }) {
  if (!operatorAddress) throw new Error("OPERATOR_ADDRESS is missing from the keeper environment");
  const operator = getAddress(operatorAddress);
  if (!sameAddress(operator, expectedKeeper)) throw new Error(`keeper operator mismatch: ${operator}`);
  return operator;
}

function checkKeeperService() {
  if (!CHECK_KEEPER_SERVICE) return { skipped: true };
  const operator = validateKeeperIdentity({ operatorAddress: OPERATOR_ADDRESS });
  try {
    execFileSync("systemctl", ["--user", "is-active", "--quiet", KEEPER_UNIT], { stdio: "ignore" });
    return { active: true, operator };
  } catch {
    throw new Error(`keeper service is not active: ${KEEPER_UNIT}`);
  }
}

function sameAddress(actual, expected) {
  return actual.toLowerCase() === expected.toLowerCase();
}

export function validateProductionState({
  chainId,
  blockNumber,
  paused,
  managerCode,
  adapterCode,
  quoterCode,
  factoryCode,
  managerAdapter,
  managerOwner,
  managerGuardian,
  pendingManagerOwner,
  pendingSwapAdapter,
  adapterManager,
  adapterOwner,
  pendingAdapterOwner,
  activePool,
  pendingPool,
  quoterFactory,
  quotePool,
  quoterQuote,
}) {
  if (chainId !== 14) throw new Error(`unexpected chain id: ${chainId}`);
  if (!managerCode || managerCode === "0x") throw new Error("Ballast manager has no deployed code");
  if (!adapterCode || adapterCode === "0x") throw new Error("Ballast adapter has no deployed code");
  if (!quoterCode || quoterCode === "0x") throw new Error("SparkDEX quoter has no deployed code");
  if (!factoryCode || factoryCode === "0x") throw new Error("SparkDEX factory has no deployed code");
  if (paused) throw new Error("Ballast manager is paused");
  const addresses = [
    ["manager adapter", managerAdapter, ADAPTER],
    ["manager owner", managerOwner, OWNER],
    ["manager guardian", managerGuardian, GUARDIAN],
    ["adapter manager", adapterManager, BALLAST],
    ["adapter owner", adapterOwner, OWNER],
    ["active pool", activePool, ACTIVE_POOL],
    ["quoter factory", quoterFactory, SPARKDEX_FACTORY],
    ["quote pool", quotePool, ACTIVE_POOL],
    ["pending manager owner", pendingManagerOwner, zeroAddress],
    ["pending swap adapter", pendingSwapAdapter, zeroAddress],
    ["pending adapter owner", pendingAdapterOwner, zeroAddress],
    ["pending pool", pendingPool, zeroAddress],
  ];
  for (const [label, actual, expected] of addresses) {
    if (!sameAddress(actual, expected)) throw new Error(`${label} mismatch: ${actual}`);
  }
  if (!Array.isArray(quoterQuote) || quoterQuote.length !== 6) throw new Error("SparkDEX quote response is invalid");
  if (quoterQuote[0] <= 0n) throw new Error("SparkDEX health quote returned no output");
  if (quoterQuote[1] !== HEALTHCHECK_QUOTE_AMOUNT) throw new Error(`SparkDEX health quote used ${quoterQuote[1]} input units`);
  return { chainId, blockNumber: blockNumber.toString(), paused, adapter: managerAdapter, pool: activePool, quoter: SPARKDEX_QUOTER, factory: SPARKDEX_FACTORY, quoteAmountOut: quoterQuote[0].toString() };
}

async function checkChain() {
  const [
    chainId,
    blockNumber,
    paused,
    managerCode,
    adapterCode,
    quoterCode,
    factoryCode,
    managerAdapter,
    managerOwner,
    managerGuardian,
    pendingManagerOwner,
    pendingSwapAdapter,
    adapterManager,
    adapterOwner,
    pendingAdapterOwner,
    activePool,
    pendingPool,
    quoterFactory,
    quotePool,
    quoterQuote,
  ] = await Promise.all([
    flareClient.getChainId(),
    flareClient.getBlockNumber(),
    flareClient.readContract({ address: BALLAST, abi: managerAbi, functionName: "paused" }),
    flareClient.getCode({ address: BALLAST }),
    flareClient.getCode({ address: ADAPTER }),
    flareClient.getCode({ address: SPARKDEX_QUOTER }),
    flareClient.getCode({ address: SPARKDEX_FACTORY }),
    flareClient.readContract({ address: BALLAST, abi: managerAbi, functionName: "swapAdapter" }),
    flareClient.readContract({ address: BALLAST, abi: managerAbi, functionName: "owner" }),
    flareClient.readContract({ address: BALLAST, abi: managerAbi, functionName: "guardian" }),
    flareClient.readContract({ address: BALLAST, abi: managerAbi, functionName: "pendingOwner" }),
    flareClient.readContract({ address: BALLAST, abi: managerAbi, functionName: "pendingSwapAdapter" }),
    flareClient.readContract({ address: ADAPTER, abi: adapterAbi, functionName: "manager" }),
    flareClient.readContract({ address: ADAPTER, abi: adapterAbi, functionName: "owner" }),
    flareClient.readContract({ address: ADAPTER, abi: adapterAbi, functionName: "pendingOwner" }),
    flareClient.readContract({ address: ADAPTER, abi: adapterAbi, functionName: "poolFor", args: [POOL_KEY] }),
    flareClient.readContract({ address: ADAPTER, abi: adapterAbi, functionName: "pendingPool", args: [POOL_KEY] }),
    flareClient.readContract({ address: SPARKDEX_QUOTER, abi: quoterAbi, functionName: "factory" }),
    flareClient.readContract({ address: SPARKDEX_FACTORY, abi: algebraFactoryAbi, functionName: "poolByPair", args: [COLLATERAL_TOKEN, LOAN_TOKEN] }),
    flareClient.simulateContract({
      address: SPARKDEX_QUOTER,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: COLLATERAL_TOKEN, tokenOut: LOAN_TOKEN, deployer: SPARKDEX_QUOTE_DEPLOYER, amountIn: HEALTHCHECK_QUOTE_AMOUNT, limitSqrtPrice: 0n }],
    }).then(({ result }) => result),
  ]);
  return validateProductionState({
    chainId,
    blockNumber,
    paused,
    managerCode,
    adapterCode,
    quoterCode,
    factoryCode,
    managerAdapter,
    managerOwner,
    managerGuardian,
    pendingManagerOwner,
    pendingSwapAdapter,
    adapterManager,
    adapterOwner,
    pendingAdapterOwner,
    activePool,
    pendingPool,
    quoterFactory,
    quotePool,
    quoterQuote,
  });
}

async function checkFcc() {
  if (!CHECK_FCC) return { skipped: true };
  const [extensionId, machine, status, response] = await Promise.all([
    coston2Client.readContract({ address: FLARE_TEE_MANAGER, abi: teeAbi, functionName: "getExtensionId", args: [TEE_ID] }),
    coston2Client.readContract({ address: FLARE_TEE_MANAGER, abi: teeAbi, functionName: "getTeeMachine", args: [TEE_ID] }),
    coston2Client.readContract({ address: FLARE_TEE_MANAGER, abi: teeAbi, functionName: "getTeeMachineStatus", args: [TEE_ID] }),
    fetchWithRetry(FCC_INFO_URL),
  ]);
  if (extensionId !== EXTENSION_ID) throw new Error(`FCC extension mismatch: ${extensionId} != ${EXTENSION_ID}`);
  if (status !== 2) throw new Error(`FCC TEE is not PRODUCTION: status=${status}`);
  if (machine.url !== EXT_PROXY_URL) throw new Error(`FCC TEE URL mismatch: ${machine.url}`);
  if (!response.ok) throw new Error(`FCC info endpoint failed: ${response.status}`);
  const info = await response.json();
  const publicExtension = BigInt(info.machineData?.extensionId || "0");
  if (publicExtension !== EXTENSION_ID) throw new Error("FCC public extension does not match onchain state");
  return { extensionId: extensionId.toString(), teeStatus: status, url: machine.url };
}

async function checkStatic() {
  if (!CHECK_STATIC) return { skipped: true };
  const results = await Promise.all(STATIC_URLS.map(async (url) => {
    const [response, releaseResponse] = await Promise.all([
      fetchWithRetry(url, { method: "HEAD" }),
      fetchWithRetry(`${url.replace(/\/$/, "")}/release.json`),
    ]);
    if (!response.ok) throw new Error(`static endpoint failed: ${url} (${response.status})`);
    if (!releaseResponse.ok) throw new Error(`release provenance failed: ${url} (${releaseResponse.status})`);
    const release = await releaseResponse.json();
    if (release.commit !== EXPECTED_RELEASE_COMMIT) {
      throw new Error(`release commit mismatch: ${url} (${release.commit} != ${EXPECTED_RELEASE_COMMIT})`);
    }
    return { url, status: response.status, commit: release.commit };
  }));
  return results;
}

function loadPreviousStatus() {
  if (!existsSync(HEALTH_STATE_FILE)) return null;
  try {
    return readJson(HEALTH_STATE_FILE).status || null;
  } catch {
    return null;
  }
}

export function publicHealthState({ status, checkedAt, releaseCommit = EXPECTED_RELEASE_COMMIT }) {
  return {
    version: 1,
    service: "ballast",
    status,
    checkedAt,
    releaseCommit,
  };
}

function writeJsonAtomic(path, value, mode, directoryMode = 0o700) {
  mkdirSync(dirname(path), { recursive: true, mode: directoryMode });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { mode });
  renameSync(temporaryPath, path);
}

function saveHealthState(status, errors) {
  const checkedAt = new Date().toISOString();
  mkdirSync(dirname(HEALTH_STATE_FILE), { recursive: true, mode: 0o700 });
  writeJsonAtomic(HEALTH_STATE_FILE, {
    version: 2,
    status,
    checkedAt,
    releaseCommit: EXPECTED_RELEASE_COMMIT,
    errors,
  }, 0o600);
  if (PUBLIC_HEALTH_FILE) {
    writeJsonAtomic(PUBLIC_HEALTH_FILE, publicHealthState({ status, checkedAt }), 0o644, 0o755);
  }
}

async function sendAlert(status, errors, previousStatus) {
  if (!ALERT_WEBHOOK_URL) return;
  const details = errors.length ? errors.join("; ") : "all checks recovered";
  const message = `Ballast health ${previousStatus || "unknown"} -> ${status}: ${details}`;
  const response = await fetchWithRetry(ALERT_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: message, content: message, status }),
  });
  if (!response.ok) throw new Error(`health alert webhook failed: ${response.status}`);
}

export async function runChecks({
  checkState = checkKeeperState,
  checkService = checkKeeperService,
  checkChainFn = checkChain,
  checkFccFn = checkFcc,
  checkStaticFn = checkStatic,
} = {}) {
  const checks = {};
  const entries = [["state", checkState], ["service", checkService], ["chain", checkChainFn], ["fcc", checkFccFn], ["static", checkStaticFn]];
  const outcomes = await Promise.all(entries.map(async ([name, check]) => {
    try { return { name, result: await check() }; } catch (error) { return { name, error }; }
  }));
  const errors = [];
  for (const outcome of outcomes) {
    if (outcome.error) errors.push(`${outcome.name}: ${outcome.error.message}`);
    else checks[outcome.name] = outcome.result;
  }
  return { ok: errors.length === 0, checks, errors };
}

export async function main() {
  const result = await runChecks();
  const status = result.ok ? "ok" : "failed";
  const previousStatus = loadPreviousStatus();
  if (status !== previousStatus && (status === "failed" || previousStatus === "failed")) {
    try {
      await sendAlert(status, result.errors, previousStatus);
    } catch (error) {
      result.errors.push(`alert: ${error.message}`);
    }
  }
  saveHealthState(status, result.errors);
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: "ballast-healthcheck", status, ...result }));
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
