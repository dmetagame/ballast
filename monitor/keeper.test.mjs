import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toEventSelector, zeroAddress } from "viem";
import {
  applyPolicyLogs,
  acquireExecutionLock,
  assertSuccessfulReceipt,
  buildRpcLogRanges,
  calculateEconomics,
  collectPolicyLogs,
  collectRpcPolicyLogs,
  createSerialExecutor,
  enforcePositionLimit,
  handleCycleFailure,
  loadDiscoveryState,
  loadPrivateKey,
  mapWithConcurrency,
  prepareSignAndBroadcastTransaction,
  quoteSwapOutput,
  resolveOperatorAddress,
  saveDiscoveryState,
  selectSyncTarget,
  shouldSkipForDifferentKeeper,
  validateBlockscoutTip,
  validateExecutionConfiguration,
  validateExecutionHealth,
  verifyExecutionRoute,
} from "./keeper.mjs";

const OPERATOR = "0xEE3eA6f858aE84dD6959f241DfC257a2f8fA3f53";
const OTHER_KEEPER = "0x302a6505c225bBB145569F35B89611d0677195a9";
const MANAGER = "0x746066ACe5dc89a3692137b8cdE3c31328629d09";
const ADAPTER = "0xA3B9822228b6d0DE77089B0C67Ec0A73A9A9C202";
const MARKET_ID = "0x2f31ab3fc12d6d10d1de9e5c74053126f03ac1f80a2e6d69d36a411fef7d942f";
const QUOTER = "0x6AD6A4f233F1E33613e996CCc17409B93fF8bf5f";
const FACTORY = "0x805488DaA81c1b9e7C5cE3f1DCeA28F21448EC6A";
const POOL = "0x927485d88a66253c63Af9163dca5f21c25A57393";
const FXRP = "0xAd552A648C74D49E10027AB8a618A3ad4901c5bE";
const USDT0 = "0xe7cd86e13AC4309349F30B3435a9d337750fC82D";
const POLICY_SET_TOPIC = toEventSelector("PolicySet(address,bytes32,uint128,uint128,uint64,uint32)");
const POLICY_DISABLED_TOPIC = toEventSelector("PolicyDisabled(address,bytes32)");
const addressTopic = (address) => `0x${address.slice(2).padStart(64, "0")}`;

test("v3 keeper refuses a policy naming a different operator", () => {
  assert.equal(
    shouldSkipForDifferentKeeper({ managerVersion: "v3", policyKeeper: OTHER_KEEPER, operator: OPERATOR }),
    true,
  );
});

test("v3 keeper acts on its own policy regardless of address casing", () => {
  assert.equal(
    shouldSkipForDifferentKeeper({
      managerVersion: "v3",
      policyKeeper: OPERATOR.toLowerCase(),
      operator: OPERATOR.toUpperCase().replace("0X", "0x"),
    }),
    false,
  );
});

// A V1-shaped policy read through the V3 ABI yields no keeper. Refusing is the safe reading:
// an unnamed keeper is not this operator.
test("v3 keeper refuses a policy with no keeper field", () => {
  for (const policyKeeper of [null, undefined, ""]) {
    assert.equal(
      shouldSkipForDifferentKeeper({ managerVersion: "v3", policyKeeper, operator: OPERATOR }),
      true,
    );
  }
});

test("dry run without an operator address cannot assess the keeper identity", () => {
  assert.equal(
    shouldSkipForDifferentKeeper({ managerVersion: "v3", policyKeeper: OTHER_KEEPER, operator: undefined }),
    false,
  );
});

test("dry run with an operator address refuses a policy naming a different operator", () => {
  assert.equal(
    shouldSkipForDifferentKeeper({ managerVersion: "v3", policyKeeper: OTHER_KEEPER, operator: OPERATOR }),
    true,
  );
});

test("dry run resolves the operator from a public address", () => {
  assert.equal(resolveOperatorAddress({ configuredAddress: OPERATOR.toLowerCase() }), OPERATOR);
});

test("execution refuses an operator address that does not match the signer", () => {
  assert.throws(
    () => resolveOperatorAddress({ configuredAddress: OTHER_KEEPER, signerAddress: OPERATOR }),
    /does not match the configured private key/,
  );
});

test("v1 policies carry no keeper and are never refused on that basis", () => {
  assert.equal(
    shouldSkipForDifferentKeeper({ managerVersion: "v1", policyKeeper: OTHER_KEEPER, operator: OPERATOR }),
    false,
  );
});

test("loadPrivateKey reads a protected credential file", () => {
  const directory = mkdtempSync(join(tmpdir(), "ballast-keeper-"));
  const keyFile = join(directory, "keeper_private_key");
  writeFileSync(keyFile, "0x1234\n", { mode: 0o600 });
  assert.equal(loadPrivateKey({ privateKey: "", privateKeyFile: keyFile }), "0x1234");
});

test("loadPrivateKey discovers the systemd credentials directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "ballast-credentials-"));
  writeFileSync(join(directory, "keeper_private_key"), "0xabcd\n", { mode: 0o600 });
  const previousDirectory = process.env.CREDENTIALS_DIRECTORY;
  process.env.CREDENTIALS_DIRECTORY = directory;
  try {
    assert.equal(loadPrivateKey({ privateKey: "" }), "0xabcd");
  } finally {
    if (previousDirectory === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = previousDirectory;
  }
});

test("loadPrivateKey rejects ambiguous key configuration", () => {
  assert.throws(
    () => loadPrivateKey({ privateKey: "0x1234", privateKeyFile: "/tmp/key" }),
    /set only one/,
  );
});

test("execution lock rejects a second active process and releases cleanly", () => {
  const directory = mkdtempSync(join(tmpdir(), "ballast-execution-lock-"));
  const lockFile = join(directory, "execution.lock");
  const release = acquireExecutionLock({ enabled: true, lockFile, processId: 1234, isProcessAlive: () => true });
  assert.equal(readFileSync(lockFile, "utf8").trim(), "1234");
  assert.throws(
    () => acquireExecutionLock({ enabled: true, lockFile, processId: 5678, isProcessAlive: () => true }),
    /held by process 1234/,
  );
  release();
  const releaseAgain = acquireExecutionLock({ enabled: true, lockFile, processId: 5678, isProcessAlive: () => true });
  releaseAgain();
});

test("execution lock reclaims a stale process file", () => {
  const directory = mkdtempSync(join(tmpdir(), "ballast-stale-execution-lock-"));
  const lockFile = join(directory, "execution.lock");
  writeFileSync(lockFile, "1234\n", { mode: 0o600 });
  const release = acquireExecutionLock({ enabled: true, lockFile, processId: 5678, isProcessAlive: () => false });
  assert.equal(readFileSync(lockFile, "utf8").trim(), "5678");
  release();
});

test("calculateEconomics rejects gas above the configured ceiling", () => {
  const result = calculateEconomics({ repayAssets: 1_000_000n, keeperFeeBps: 100, quotedAmountOut: 1_100_000n, quoteHaircutBps: 0, gasEstimate: 100_000n, gasPrice: 2n, maxGasFlrWei: 100_000n, minKeeperFeeUnits: null, loanTokenUnitsPerFlr: null, minProfitFlrWei: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "gas_limit_exceeded");
});

test("calculateEconomics rejects fees below the configured minimum", () => {
  const result = calculateEconomics({ repayAssets: 1_000_000n, keeperFeeBps: 10, quotedAmountOut: 1_100_000n, quoteHaircutBps: 0, gasEstimate: 1n, gasPrice: 1n, maxGasFlrWei: null, minKeeperFeeUnits: 2_000n, loanTokenUnitsPerFlr: null, minProfitFlrWei: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "keeper_fee_below_minimum");
});

test("calculateEconomics checks priced profit after gas", () => {
  const result = calculateEconomics({ repayAssets: 10_000_000n, keeperFeeBps: 100, quotedAmountOut: 11_000_000n, quoteHaircutBps: 0, gasEstimate: 10n, gasPrice: 1n, maxGasFlrWei: null, minKeeperFeeUnits: null, loanTokenUnitsPerFlr: 1_000_000n, minProfitFlrWei: 999_999_999_999_999_991n });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "profit_below_minimum");
});

test("calculateEconomics prices profit from realizable surplus rather than the policy ceiling", () => {
  const result = calculateEconomics({ repayAssets: 10_000_000n, keeperFeeBps: 500, quotedAmountOut: 10_010_000n, quoteHaircutBps: 0, gasEstimate: 1n, gasPrice: 1n, maxGasFlrWei: null, minKeeperFeeUnits: null, loanTokenUnitsPerFlr: 1_000_000n, minProfitFlrWei: 10_000_000_000_000_000n });
  assert.equal(result.maximumKeeperFee, 500_000n);
  assert.equal(result.expectedKeeperFee, 10_000n);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "profit_below_minimum");
});

test("calculateEconomics rejects a missing quote", () => {
  const result = calculateEconomics({ repayAssets: 1_000_000n, keeperFeeBps: 100, quotedAmountOut: null, quoteHaircutBps: 0, gasEstimate: 1n, gasPrice: 1n, maxGasFlrWei: null, minKeeperFeeUnits: null, loanTokenUnitsPerFlr: null, minProfitFlrWei: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "quote_unavailable");
});

test("calculateEconomics caps keeper revenue by conservative quoted surplus", () => {
  const result = calculateEconomics({ repayAssets: 1_000_000n, keeperFeeBps: 100, quotedAmountOut: 1_006_000n, quoteHaircutBps: 10, gasEstimate: 1n, gasPrice: 1n, maxGasFlrWei: null, minKeeperFeeUnits: null, loanTokenUnitsPerFlr: null, minProfitFlrWei: null });
  assert.equal(result.ok, true);
  assert.equal(result.conservativeAmountOut, 1_004_994n);
  assert.equal(result.quotedSurplus, 4_994n);
  assert.equal(result.maximumKeeperFee, 10_000n);
  assert.equal(result.expectedKeeperFee, 4_994n);
});

test("calculateEconomics rejects a quote that cannot conservatively repay", () => {
  const result = calculateEconomics({ repayAssets: 1_000_000n, keeperFeeBps: 100, quotedAmountOut: 1_001_000n, quoteHaircutBps: 20, gasEstimate: 1n, gasPrice: 1n, maxGasFlrWei: null, minKeeperFeeUnits: null, loanTokenUnitsPerFlr: null, minProfitFlrWei: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "quote_below_repayment");
  assert.equal(result.expectedKeeperFee, 0n);
});

test("execution requires complete quote and profitability configuration", () => {
  const base = {
    execute: true,
    maxGasFlrWei: 1n,
    minKeeperFeeUnits: 1n,
    loanTokenUnitsPerFlr: 1n,
    minProfitFlrWei: 0n,
    quoter: QUOTER,
    factory: FACTORY,
    quoteDeployer: zeroAddress,
    adapter: ADAPTER,
    activePool: POOL,
    collateralToken: FXRP,
    loanToken: USDT0,
    quoteHaircutBps: 10,
  };
  assert.equal(validateExecutionConfiguration({ ...base, execute: false }), null);
  assert.throws(() => validateExecutionConfiguration({ ...base, quoter: null }), /SPARKDEX_QUOTER/);
  assert.throws(() => validateExecutionConfiguration({ ...base, adapter: null }), /ADAPTER/);
  assert.throws(() => validateExecutionConfiguration({ ...base, quoteHaircutBps: 1_001 }), /cannot exceed 1000/);
  assert.equal(validateExecutionConfiguration(base).quoter, QUOTER);
});

test("SparkDEX quote verifies quoter identity and the exact active pool", async () => {
  const rpcClient = {
    getCode: async () => "0x01",
    readContract: async ({ functionName }) => functionName === "factory" ? FACTORY : POOL,
    simulateContract: async () => ({ result: [1_010_000n, 1_000_000n, 2n, 3, 4n, 5] }),
  };
  const quote = await quoteSwapOutput({ rpcClient, quoter: QUOTER, factory: FACTORY, quoteDeployer: zeroAddress, expectedPool: POOL, tokenIn: FXRP, tokenOut: USDT0, amountIn: 1_000_000n });
  assert.equal(quote.amountOut, 1_010_000n);
  assert.equal(quote.amountIn, 1_000_000n);
  assert.equal(quote.pool, POOL);
});

test("SparkDEX quote fails closed on a different resolved pool", async () => {
  const rpcClient = {
    getCode: async () => "0x01",
    readContract: async ({ functionName }) => functionName === "factory" ? FACTORY : MANAGER,
    simulateContract: async () => { throw new Error("must not quote"); },
  };
  await assert.rejects(
    quoteSwapOutput({ rpcClient, quoter: QUOTER, factory: FACTORY, quoteDeployer: zeroAddress, expectedPool: POOL, tokenIn: FXRP, tokenOut: USDT0, amountIn: 1_000_000n }),
    /quote pool mismatch/,
  );
});

test("execution route verifies the manager adapter and its active pool", async () => {
  const rpcClient = {
    getCode: async () => "0x01",
    readContract: async ({ functionName }) => functionName === "swapAdapter" ? ADAPTER : POOL,
  };
  assert.deepEqual(
    await verifyExecutionRoute({ rpcClient, manager: MANAGER, expectedAdapter: ADAPTER, expectedPool: POOL, tokenIn: FXRP, tokenOut: USDT0 }),
    { adapter: ADAPTER, pool: POOL },
  );
});

test("execution route fails closed when the manager adapter changes", async () => {
  const rpcClient = {
    getCode: async () => "0x01",
    readContract: async ({ functionName }) => functionName === "swapAdapter" ? OTHER_KEEPER : POOL,
  };
  await assert.rejects(
    verifyExecutionRoute({ rpcClient, manager: MANAGER, expectedAdapter: ADAPTER, expectedPool: POOL, tokenIn: FXRP, tokenOut: USDT0 }),
    /swap adapter mismatch/,
  );
});

test("execution route fails closed when the adapter pool changes", async () => {
  const rpcClient = {
    getCode: async () => "0x01",
    readContract: async ({ functionName }) => functionName === "swapAdapter" ? ADAPTER : OTHER_KEEPER,
  };
  await assert.rejects(
    verifyExecutionRoute({ rpcClient, manager: MANAGER, expectedAdapter: ADAPTER, expectedPool: POOL, tokenIn: FXRP, tokenOut: USDT0 }),
    /active pool mismatch/,
  );
});

test("keeper rejects a reverted protection receipt", () => {
  assert.throws(
    () => assertSuccessfulReceipt({ status: "reverted" }, "0xdeadbeef"),
    /protection transaction reverted: 0xdeadbeef/,
  );
});

test("keeper accepts a successful protection receipt", () => {
  const receipt = { status: "success" };
  assert.equal(assertSuccessfulReceipt(receipt, "0x1234"), receipt);
});

test("keeper prepares and signs once while retrying identical raw transaction bytes", async () => {
  const serializedTransaction = "0x02deadbeef";
  const expectedHash = keccak256(serializedTransaction);
  const broadcasts = [];
  let prepareCalls = 0;
  let signCalls = 0;
  const result = await prepareSignAndBroadcastTransaction({
    prepareTransaction: async () => {
      prepareCalls += 1;
      return { nonce: 7 };
    },
    signTransaction: async (request) => {
      signCalls += 1;
      assert.deepEqual(request, { nonce: 7 });
      return serializedTransaction;
    },
    sendRawTransaction: async ({ serializedTransaction: payload }) => {
      broadcasts.push(payload);
      if (broadcasts.length === 1) throw new Error("ambiguous RPC timeout");
      return expectedHash;
    },
    attempts: 2,
    baseDelayMs: 1,
  });
  assert.equal(prepareCalls, 1);
  assert.equal(signCalls, 1);
  assert.deepEqual(broadcasts, [serializedTransaction, serializedTransaction]);
  assert.equal(result.hash, expectedHash);
});

test("keeper rejects an RPC hash that does not match the signed transaction", async () => {
  await assert.rejects(
    prepareSignAndBroadcastTransaction({
      prepareTransaction: async () => ({ nonce: 1 }),
      signTransaction: async () => "0x02cafe",
      sendRawTransaction: async () => `0x${"11".repeat(32)}`,
      attempts: 1,
    }),
    /raw transaction hash mismatch/,
  );
});

test("keeper serializes execution broadcasts", async () => {
  const runSerial = createSerialExecutor();
  const order = [];
  let active = 0;
  let peak = 0;
  const execute = (name, delay) => runSerial(async () => {
    active += 1;
    peak = Math.max(peak, active);
    order.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    order.push(`${name}:end`);
    active -= 1;
    return name;
  });
  assert.deepEqual(await Promise.all([execute("first", 5), execute("second", 0)]), ["first", "second"]);
  assert.equal(peak, 1);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("execution health gate accepts only a fresh matching release", () => {
  const state = {
    version: 3,
    status: "ok",
    executionStatus: "ok",
    checkedAt: "2026-08-13T22:00:00.000Z",
    releaseCommit: "abc123",
    errors: [],
  };
  assert.deepEqual(validateExecutionHealth({
    state,
    expectedReleaseCommit: "abc123",
    nowMs: Date.parse("2026-08-13T22:05:00.000Z"),
    maxAgeMs: 420_000,
  }), { ageMs: 300_000, releaseCommit: "abc123" });
  assert.deepEqual(validateExecutionHealth({
    state: { ...state, status: "failed", errors: ["fcc: offline"] },
    expectedReleaseCommit: "abc123",
    nowMs: Date.parse("2026-08-13T22:05:00.000Z"),
    maxAgeMs: 420_000,
  }), { ageMs: 300_000, releaseCommit: "abc123" });
  assert.throws(() => validateExecutionHealth({
    state: { ...state, executionStatus: "failed" },
    expectedReleaseCommit: "abc123",
  }), /not passing/);
  assert.throws(() => validateExecutionHealth({
    state,
    expectedReleaseCommit: "different",
    nowMs: Date.parse("2026-08-13T22:05:00.000Z"),
  }), /release mismatch/);
  assert.throws(() => validateExecutionHealth({
    state,
    expectedReleaseCommit: null,
    nowMs: Date.parse("2026-08-13T22:05:00.000Z"),
  }), /no expected release commit/);
  assert.throws(() => validateExecutionHealth({
    state,
    expectedReleaseCommit: "abc123",
    nowMs: Date.parse("2026-08-13T22:10:00.001Z"),
    maxAgeMs: 600_000,
  }), /stale/);
});

test("one-shot keeper failures exit non-zero while watch mode continues", () => {
  const error = new Error("cycle failed");
  assert.throws(() => handleCycleFailure(error, true), error);
  assert.doesNotThrow(() => handleCycleFailure(error, false));
});

test("keeper sync target never outruns confirmations or Blockscout", () => {
  assert.equal(selectSyncTarget(1_000n, 995n, 12), 988n);
  assert.equal(selectSyncTarget(1_000n, 980n, 12), 980n);
});

test("Blockscout bootstrap requires a complete indexed chain", () => {
  assert.equal(validateBlockscoutTip({ total_blocks: "123" }, { finished_indexing_blocks: true }), 123n);
  assert.throws(
    () => validateBlockscoutTip({ total_blocks: "123" }, { finished_indexing_blocks: false }),
    /indexing is incomplete/,
  );
});

test("RPC log pagination respects Flare's 30-block maximum", () => {
  assert.deepEqual(buildRpcLogRanges(10n, 75n, 30), [
    { fromBlock: 10n, toBlock: 39n },
    { fromBlock: 40n, toBlock: 69n },
    { fromBlock: 70n, toBlock: 75n },
  ]);
  assert.throws(() => buildRpcLogRanges(10n, 75n, 31), /invalid RPC log range/);
});

test("RPC log collection merges every page", async () => {
  const requests = [];
  const result = await collectRpcPolicyLogs({
    fromBlock: 10n,
    toBlock: 70n,
    request: async ({ params }) => {
      requests.push(params[0]);
      return [{ blockNumber: params[0].fromBlock, logIndex: "0x0", topics: [POLICY_SET_TOPIC, addressTopic(OPERATOR), MARKET_ID] }];
    },
  });
  assert.equal(requests.length, 3);
  assert.equal(result.pageCount, 3);
  assert.equal(result.logs.length, 3);
});

test("Blockscout cursor collection stops after crossing the checkpoint", async () => {
  const pages = [
    {
      items: [
        { block_number: 105, index: 2, topics: ["0x1234"] },
        { block_number: 104, index: 1, topics: [POLICY_DISABLED_TOPIC, addressTopic(OPERATOR), MARKET_ID] },
      ],
      next_page_params: { block_number: 104, index: 1, items_count: 50 },
    },
    {
      items: [
        { block_number: 103, index: 1, topics: [POLICY_SET_TOPIC, addressTopic(OPERATOR), MARKET_ID] },
        { block_number: 99, index: 1, topics: [POLICY_SET_TOPIC, addressTopic(OTHER_KEEPER), MARKET_ID] },
      ],
      next_page_params: { block_number: 99, index: 1, items_count: 50 },
    },
  ];
  let calls = 0;
  const result = await collectPolicyLogs({
    fromBlock: 100n,
    toBlock: 104n,
    fetchPage: async () => pages[calls++],
  });
  assert.equal(calls, 2);
  assert.equal(result.pageCount, 2);
  const policies = applyPolicyLogs(new Map(), result.logs);
  assert.equal(policies.size, 0);
});

test("policy index applies set and disable events in chain order", () => {
  const policies = applyPolicyLogs(new Map(), [
    { blockNumber: "0x3", logIndex: "0x0", topics: [POLICY_DISABLED_TOPIC, addressTopic(OPERATOR), MARKET_ID] },
    { blockNumber: "0x2", logIndex: "0x0", topics: [POLICY_SET_TOPIC, addressTopic(OPERATOR), MARKET_ID] },
    { blockNumber: "0x4", logIndex: "0x0", topics: [POLICY_SET_TOPIC, addressTopic(OPERATOR), MARKET_ID] },
  ]);
  assert.deepEqual([...policies.values()], [{ borrower: OPERATOR, id: MARKET_ID }]);
});

test("policy checkpoint survives a process restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "ballast-state-"));
  const stateFile = join(directory, "keeper-state.json");
  const state = {
    chainId: 14,
    manager: MANAGER,
    fromBlock: 67_019_411n,
    nextBlock: 67_100_001n,
    policies: [{ borrower: OPERATOR, id: MARKET_ID }],
  };
  saveDiscoveryState(stateFile, state);
  assert.deepEqual(loadDiscoveryState(stateFile, state), {
    nextBlock: state.nextBlock,
    policies: state.policies,
  });
});

test("policy checkpoint is ignored for a different manager", () => {
  const directory = mkdtempSync(join(tmpdir(), "ballast-state-mismatch-"));
  const stateFile = join(directory, "keeper-state.json");
  const state = { chainId: 14, manager: MANAGER, fromBlock: 1n, nextBlock: 2n, policies: [] };
  saveDiscoveryState(stateFile, state);
  assert.equal(loadDiscoveryState(stateFile, { ...state, manager: OTHER_KEEPER }), null);
});

test("position limits fail closed instead of dropping policies", () => {
  assert.throws(() => enforcePositionLimit([1, 2, 3], 2), /refusing partial coverage/);
  assert.deepEqual(enforcePositionLimit([1, 2, 3], 0), [1, 2, 3]);
});

test("mapWithConcurrency never exceeds the worker limit", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
});
