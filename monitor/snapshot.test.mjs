import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPLORER_RESULT_CAP,
  assertCompleteMulticall,
  loadSnapshot,
  scanExplorerLogs,
  tokenRatioFromOracle,
  validateExplorerPayload,
  validateSnapshot,
} from "./snapshot.mjs";

test("committed snapshot has a valid pinned identity and prices", () => {
  const snapshot = loadSnapshot();
  assert.equal(snapshot.chainId, 14);
  assert.match(snapshot.blockHash, /^0x[0-9a-f]{64}$/i);
  assert.ok(snapshot.prices.FXRP.usd > 0);
});

test("snapshot validation rejects inconsistent provenance", () => {
  const snapshot = structuredClone(loadSnapshot());
  snapshot.generated = "2026-01-01";
  assert.throws(() => validateSnapshot(snapshot), /generated date/);
});

test("explorer payload validation distinguishes no logs from malformed responses", () => {
  assert.deepEqual(validateExplorerPayload({ status: "0", message: "No logs found", result: "No logs found" }, {
    fromBlock: 1n,
    toBlock: 2n,
    label: "test",
  }), []);
  assert.throws(() => validateExplorerPayload({ status: "0", message: "rate limited" }, {
    fromBlock: 1n,
    toBlock: 2n,
    label: "test",
  }), /invalid response/);
});

test("explorer scans split capped windows and refuse capped single blocks", async () => {
  const calls = [];
  const logs = await scanExplorerLogs({
    address: "0x0000000000000000000000000000000000000001",
    topic0: `0x${"11".repeat(32)}`,
    fromBlock: 1n,
    toBlock: 2n,
    fetchWindow: async ({ fromBlock, toBlock }) => {
      calls.push([fromBlock, toBlock]);
      if (fromBlock === 1n && toBlock === 2n) return Array(EXPLORER_RESULT_CAP).fill({});
      return [{ blockNumber: fromBlock.toString() }];
    },
  });
  assert.deepEqual(calls, [[1n, 2n], [1n, 1n], [2n, 2n]]);
  assert.equal(logs.length, 2);

  await assert.rejects(scanExplorerLogs({
    address: "0x0000000000000000000000000000000000000001",
    topic0: `0x${"11".repeat(32)}`,
    fromBlock: 3n,
    toBlock: 3n,
    fetchWindow: async () => Array(EXPLORER_RESULT_CAP).fill({}),
  }), /refusing a partial snapshot/);
});

test("multicall validation fails closed and oracle scaling respects token decimals", () => {
  assert.deepEqual(assertCompleteMulticall([{ status: "success", result: 7n }], "test"), [7n]);
  assert.throws(() => assertCompleteMulticall([{ status: "failure", error: new Error("boom") }], "test"), /incomplete result/);
  assert.equal(tokenRatioFromOracle(1000000000000000000000000000000000000n, 6, 6), 1);
  assert.equal(tokenRatioFromOracle(167500000000000000000000000000000000000000000000000n, 6, 18), 167.5);
});
