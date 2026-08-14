import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
} from "viem";

export const MONITOR_DIR = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(MONITOR_DIR, "data");
export const SNAPSHOT_PATH = join(DATA_DIR, "snapshot.json");
export const RPC_URL = process.env.RPC_URL || "https://flare-api.flare.network/ext/C/rpc";
export const EXPLORER_URL = process.env.EXPLORER_URL || "https://flare-explorer.flare.network";
export const MORPHO = getAddress("0xF4346F5132e810f80a28487a79c7559d9797E8B0");
export const FXRP = getAddress("0xAd552A648C74D49E10027AB8a618A3ad4901c5bE");
export const FTSO_V2 = getAddress("0x7BDE3Df0624114eDB3A67dFe6753e62f4e7c1d20");
export const BLOCKSCOUT_LEGACY_API = `${EXPLORER_URL.replace(/\/$/, "")}/api`;
export const SCAN_START_BLOCK = 40_000_000n;
export const EXPLORER_RESULT_CAP = 1_000;

export const flare = {
  id: 14,
  name: "Flare",
  nativeCurrency: { name: "Flare", symbol: "FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
};

export const client = createPublicClient({
  chain: flare,
  transport: http(RPC_URL, { retryCount: 2, timeout: 30_000 }),
});

export const ftsoAbi = parseAbi([
  "function getFeedById(bytes21 feedId) view returns (uint256 value, int8 decimals, uint64 timestamp)",
]);

export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function withRetry(operation, {
  label = "operation",
  attempts = 4,
  baseDelayMs = 500,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`${label} failed (attempt ${attempt}/${attempts}); retrying in ${delay}ms: ${error.message}`);
      await sleep(delay);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastError?.message || "unknown error"}`, { cause: lastError });
}

export function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2)}\n`);
  renameSync(temporaryPath, path);
}

export function loadSnapshot(path = SNAPSHOT_PATH) {
  if (!existsSync(path)) throw new Error(`snapshot is missing: ${path}; run npm run snapshot:refresh`);
  return validateSnapshot(JSON.parse(readFileSync(path, "utf8")));
}

export function validateSnapshot(snapshot) {
  if (snapshot?.version !== 1 || snapshot.chainId !== 14) throw new Error("snapshot identity is invalid");
  if (!Number.isSafeInteger(snapshot.blockNumber) || snapshot.blockNumber < Number(SCAN_START_BLOCK)) {
    throw new Error("snapshot block number is invalid");
  }
  if (!/^0x[0-9a-f]{64}$/i.test(snapshot.blockHash || "")) throw new Error("snapshot block hash is invalid");
  if (!Number.isSafeInteger(snapshot.blockTimestamp) || snapshot.blockTimestamp <= 0) throw new Error("snapshot timestamp is invalid");
  if (snapshot.generated !== new Date(snapshot.blockTimestamp * 1_000).toISOString().slice(0, 10)) {
    throw new Error("snapshot generated date does not match its block timestamp");
  }
  for (const symbol of ["FXRP", "USD₮0", "WFLR", "stXRP", "PT-stXRP(FXRP)-2026/06/04"]) {
    const price = snapshot.prices?.[symbol]?.usd;
    if (!Number.isFinite(price) || price <= 0) throw new Error(`snapshot price is invalid: ${symbol}`);
  }
  for (const [name, feed] of Object.entries(snapshot.feeds || {})) {
    if (!/^0x[0-9a-f]{42}$/i.test(feed.id || "")) throw new Error(`snapshot feed id is invalid: ${name}`);
    if (!Number.isSafeInteger(feed.timestamp) || feed.timestamp > snapshot.blockTimestamp) {
      throw new Error(`snapshot feed timestamp is invalid: ${name}`);
    }
  }
  return snapshot;
}

export async function verifyPinnedBlock(snapshot = loadSnapshot(), rpcClient = client) {
  const [chainId, block] = await Promise.all([
    withRetry(() => rpcClient.getChainId(), { label: "rpc.getChainId" }),
    withRetry(() => rpcClient.getBlock({ blockNumber: BigInt(snapshot.blockNumber) }), { label: "rpc.getPinnedBlock" }),
  ]);
  if (chainId !== snapshot.chainId) throw new Error(`snapshot chain mismatch: ${chainId}`);
  if (block.hash?.toLowerCase() !== snapshot.blockHash.toLowerCase()) {
    throw new Error(`snapshot block hash mismatch: ${block.hash}`);
  }
  if (Number(block.timestamp) !== snapshot.blockTimestamp) throw new Error("snapshot block timestamp mismatch");
  return block;
}

export function snapshotPrice(snapshot, symbol) {
  const price = snapshot.prices?.[symbol]?.usd;
  if (!Number.isFinite(price) || price <= 0) throw new Error(`missing pinned USD price for ${symbol}`);
  return price;
}

export function tokenRatioFromOracle(price, collateralDecimals, loanDecimals) {
  const scaleDecimals = 36 + loanDecimals - collateralDecimals;
  if (!Number.isSafeInteger(scaleDecimals) || scaleDecimals < 0) throw new Error("unsupported Morpho oracle decimal scale");
  const raw = BigInt(price);
  const scale = 10n ** BigInt(scaleDecimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  return Number(whole) + Number(fraction) / Number(scale);
}

export function assertCompleteMulticall(results, label) {
  if (!Array.isArray(results)) throw new Error(`${label} did not return an array`);
  const failedIndex = results.findIndex((result) => result?.status !== "success");
  if (failedIndex !== -1) {
    const reason = results[failedIndex]?.error?.shortMessage || results[failedIndex]?.error?.message || "unknown failure";
    throw new Error(`${label} returned an incomplete result at index ${failedIndex}: ${reason}`);
  }
  return results.map((result) => result.result);
}

export function validateExplorerPayload(payload, { fromBlock, toBlock, label }) {
  if (Array.isArray(payload?.result)) return payload.result;
  const message = `${payload?.message || ""} ${payload?.result || ""}`.trim();
  if (payload?.status === "0" && /no logs|no records|no transactions/i.test(message)) return [];
  throw new Error(`${label} returned an invalid response for ${fromBlock}-${toBlock}: ${message || "empty response"}`);
}

async function fetchExplorerWindow({ address, topic0, fromBlock, toBlock, fetchImpl = fetch }) {
  const url = new URL(BLOCKSCOUT_LEGACY_API);
  url.searchParams.set("module", "logs");
  url.searchParams.set("action", "getLogs");
  url.searchParams.set("fromBlock", fromBlock.toString());
  url.searchParams.set("toBlock", toBlock.toString());
  url.searchParams.set("address", address);
  url.searchParams.set("topic0", topic0);
  const label = `explorer.getLogs(${address.slice(0, 10)},${topic0.slice(0, 10)})`;
  return withRetry(async () => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return validateExplorerPayload(await response.json(), { fromBlock, toBlock, label });
  }, { label });
}

export async function scanExplorerLogs({
  address,
  topic0,
  fromBlock = SCAN_START_BLOCK,
  toBlock,
  fetchWindow = fetchExplorerWindow,
  depth = 0,
}) {
  const start = BigInt(fromBlock);
  const end = BigInt(toBlock);
  if (start < 0n || end < start) throw new Error("invalid explorer log range");
  const logs = await fetchWindow({ address, topic0, fromBlock: start, toBlock: end });
  if (!Array.isArray(logs)) throw new Error("explorer log window is not an array");
  if (logs.length < EXPLORER_RESULT_CAP) return logs;
  if (start === end) throw new Error(`explorer result cap reached within block ${start}; refusing a partial snapshot`);
  const middle = (start + end) / 2n;
  if (depth < 3) process.stdout.write(`\r  splitting ${start}-${end} at explorer cap                    `);
  const first = await scanExplorerLogs({ address, topic0, fromBlock: start, toBlock: middle, fetchWindow, depth: depth + 1 });
  const second = await scanExplorerLogs({ address, topic0, fromBlock: middle + 1n, toBlock: end, fetchWindow, depth: depth + 1 });
  return [...first, ...second];
}

export async function readPinnedContract(request, {
  snapshot = loadSnapshot(),
  rpcClient = client,
  label = `${request.functionName || "contract read"}`,
} = {}) {
  return withRetry(
    () => rpcClient.readContract({ ...request, blockNumber: BigInt(snapshot.blockNumber) }),
    { label: `rpc.${label}` },
  );
}

export async function pinnedMulticall(contracts, {
  snapshot = loadSnapshot(),
  rpcClient = client,
  label = "multicall",
} = {}) {
  const results = await withRetry(
    () => rpcClient.multicall({ contracts, allowFailure: true, blockNumber: BigInt(snapshot.blockNumber) }),
    { label: `rpc.${label}` },
  );
  return assertCompleteMulticall(results, label);
}
