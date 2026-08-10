import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateEconomics, loadPrivateKey, mapWithConcurrency, shouldSkipForDifferentKeeper } from "./keeper.mjs";

const OPERATOR = "0xEE3eA6f858aE84dD6959f241DfC257a2f8fA3f53";
const OTHER_KEEPER = "0x302a6505c225bBB145569F35B89611d0677195a9";

test("v3 keeper refuses a policy naming a different operator", () => {
  assert.equal(
    shouldSkipForDifferentKeeper({ managerVersion: "v3", execute: true, policyKeeper: OTHER_KEEPER, operator: OPERATOR }),
    true,
  );
});

test("v3 keeper acts on its own policy regardless of address casing", () => {
  assert.equal(
    shouldSkipForDifferentKeeper({
      managerVersion: "v3",
      execute: true,
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
      shouldSkipForDifferentKeeper({ managerVersion: "v3", execute: true, policyKeeper, operator: OPERATOR }),
      true,
    );
  }
});

// Documents current behaviour rather than endorsing it: the check sits above the dry-run
// return in processPolicy, so a dry run never reaches it and its transcript shows no refusal.
test("dry run does not exercise the keeper refusal", () => {
  assert.equal(
    shouldSkipForDifferentKeeper({ managerVersion: "v3", execute: false, policyKeeper: OTHER_KEEPER, operator: OPERATOR }),
    false,
  );
});

test("v1 policies carry no keeper and are never refused on that basis", () => {
  assert.equal(
    shouldSkipForDifferentKeeper({ managerVersion: "v1", execute: true, policyKeeper: OTHER_KEEPER, operator: OPERATOR }),
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

test("calculateEconomics rejects gas above the configured ceiling", () => {
  const result = calculateEconomics({ repayAssets: 1_000_000n, keeperFeeBps: 100, gasEstimate: 100_000n, gasPrice: 2n, maxGasFlrWei: 100_000n, minKeeperFeeUnits: null, loanTokenUnitsPerFlr: null, minProfitFlrWei: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "gas_limit_exceeded");
});

test("calculateEconomics rejects fees below the configured minimum", () => {
  const result = calculateEconomics({ repayAssets: 1_000_000n, keeperFeeBps: 10, gasEstimate: 1n, gasPrice: 1n, maxGasFlrWei: null, minKeeperFeeUnits: 2_000n, loanTokenUnitsPerFlr: null, minProfitFlrWei: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "keeper_fee_below_minimum");
});

test("calculateEconomics checks priced profit after gas", () => {
  const result = calculateEconomics({ repayAssets: 10_000_000n, keeperFeeBps: 100, gasEstimate: 10n, gasPrice: 1n, maxGasFlrWei: null, minKeeperFeeUnits: null, loanTokenUnitsPerFlr: 1_000_000n, minProfitFlrWei: 999_999_999_999_999_991n });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "profit_below_minimum");
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
