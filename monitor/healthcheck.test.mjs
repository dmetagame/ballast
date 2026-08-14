import test from "node:test";
import assert from "node:assert/strict";
import { publicHealthState, runChecks, validateKeeperIdentity, validateKeeperState, validateProductionState } from "./healthcheck.mjs";

const MANAGER = "0x746066ACe5dc89a3692137b8cdE3c31328629d09";

test("keeper health state accepts a fresh matching checkpoint", () => {
  assert.deepEqual(validateKeeperState({
    state: { version: 1, chainId: 14, manager: MANAGER.toLowerCase(), fromBlock: "67019411", nextBlock: "123", policies: [{ borrower: "0x1", id: "0x2" }] },
    manager: MANAGER,
    modifiedMs: 9_000,
    nowMs: 10_000,
    maxAgeMs: 5_000,
  }), { nextBlock: "123", policyCount: 1, ageMs: 1_000 });
});

test("keeper health state rejects stale or mismatched checkpoints", () => {
  const state = { version: 1, chainId: 14, manager: MANAGER.toLowerCase(), fromBlock: "67019411", nextBlock: "123", policies: [] };
  assert.throws(() => validateKeeperState({ state, manager: MANAGER, modifiedMs: 0, nowMs: 10_000, maxAgeMs: 5_000 }), /stale/);
  assert.throws(() => validateKeeperState({ state: { ...state, chainId: 114 }, manager: MANAGER, modifiedMs: 9_000, nowMs: 10_000, maxAgeMs: 5_000 }), /identity/);
});

test("keeper health requires the configured production operator", () => {
  const keeper = "0xA20a59090f609329405F5DcA785Af9357F6965E7";
  assert.equal(validateKeeperIdentity({ operatorAddress: keeper }), keeper);
  assert.throws(() => validateKeeperIdentity({ operatorAddress: null }), /missing/);
  assert.throws(() => validateKeeperIdentity({ operatorAddress: MANAGER }), /mismatch/);
});

test("production state requires the finalized manager, adapter, pool, and owners", () => {
  const state = {
    chainId: 14,
    blockNumber: 123n,
    paused: false,
    managerCode: "0x01",
    adapterCode: "0x01",
    quoterCode: "0x01",
    factoryCode: "0x01",
    managerAdapter: "0xA3B9822228b6d0DE77089B0C67Ec0A73A9A9C202",
    managerOwner: "0x302a6505c225bBB145569F35B89611d0677195a9",
    managerGuardian: "0xFf97ED39EAe2a4f5fa79097EdDbFD4c27876f8ce",
    pendingManagerOwner: "0x0000000000000000000000000000000000000000",
    pendingSwapAdapter: "0x0000000000000000000000000000000000000000",
    adapterManager: MANAGER,
    adapterOwner: "0x302a6505c225bBB145569F35B89611d0677195a9",
    pendingAdapterOwner: "0x0000000000000000000000000000000000000000",
    activePool: "0x927485d88a66253c63Af9163dca5f21c25A57393",
    pendingPool: "0x0000000000000000000000000000000000000000",
    quoterFactory: "0x805488DaA81c1b9e7C5cE3f1DCeA28F21448EC6A",
    quotePool: "0x927485d88a66253c63Af9163dca5f21c25A57393",
    quoterQuote: [1_003_000n, 1_000_000n, 2n, 0, 3n, 500],
  };
  assert.deepEqual(validateProductionState(state), {
    chainId: 14,
    blockNumber: "123",
    paused: false,
    adapter: state.managerAdapter,
    pool: state.activePool,
    quoter: "0x6AD6A4f233F1E33613e996CCc17409B93fF8bf5f",
    factory: state.quoterFactory,
    quoteAmountOut: "1003000",
  });
  assert.throws(() => validateProductionState({ ...state, activePool: MANAGER }), /active pool mismatch/);
  assert.throws(() => validateProductionState({ ...state, quotePool: MANAGER }), /quote pool mismatch/);
  assert.throws(() => validateProductionState({ ...state, quoterFactory: MANAGER }), /quoter factory mismatch/);
  assert.throws(() => validateProductionState({ ...state, quoterQuote: [0n, 1_000_000n, 2n, 0, 3n, 500] }), /returned no output/);
  assert.throws(() => validateProductionState({ ...state, quoterQuote: [1n, 999_999n, 2n, 0, 3n, 500] }), /used 999999 input units/);
  assert.throws(() => validateProductionState({ ...state, pendingSwapAdapter: state.managerAdapter }), /pending swap adapter mismatch/);
});

test("healthcheck aggregates failures without skipping remaining checks", async () => {
  const calls = [];
  const result = await runChecks({
    checkState: async () => { calls.push("state"); throw new Error("stale"); },
    checkService: async () => { calls.push("service"); return { active: true }; },
    checkChainFn: async () => { calls.push("chain"); throw new Error("paused"); },
    checkFccFn: async () => { calls.push("fcc"); return { teeStatus: 2 }; },
    checkStaticFn: async () => { calls.push("static"); return [{ status: 200 }]; },
  });
  assert.deepEqual(calls, ["state", "service", "chain", "fcc", "static"]);
  assert.equal(result.ok, false);
  assert.equal(result.executionOk, false);
  assert.deepEqual(result.errors, ["state: stale", "chain: paused"]);
  assert.deepEqual(result.executionErrors, ["state: stale", "chain: paused"]);
});

test("noncritical FCC and static failures do not disable mainnet execution", async () => {
  const result = await runChecks({
    checkState: async () => ({ nextBlock: "123" }),
    checkService: async () => ({ active: true }),
    checkChainFn: async () => ({ chainId: 14 }),
    checkFccFn: async () => { throw new Error("offline"); },
    checkStaticFn: async () => { throw new Error("unavailable"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.executionOk, true);
  assert.deepEqual(result.errors, ["fcc: offline", "static: unavailable"]);
  assert.deepEqual(result.executionErrors, []);
});

test("public health state exposes only status, freshness, and release provenance", () => {
  assert.deepEqual(publicHealthState({ status: "ok", checkedAt: "2026-08-14T06:00:00Z", releaseCommit: "1".repeat(40) }), {
    version: 1,
    service: "ballast",
    status: "ok",
    checkedAt: "2026-08-14T06:00:00Z",
    releaseCommit: "1".repeat(40),
  });
});
