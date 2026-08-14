import test from "node:test";
import assert from "node:assert/strict";
import { morphoLiquidationPenaltyRate, xrpDropToLiquidation } from "./risk-math.mjs";

test("XRP drawdown uses net XRP exposure and ignores neutral positions", () => {
  assert.equal(xrpDropToLiquidation({
    stableCollateralUsd: 0,
    xrpCollateralUsd: 200,
    stableDebtUsd: 100,
    xrpDebtUsd: 50,
  }), 100 / 3);
  assert.equal(xrpDropToLiquidation({
    stableCollateralUsd: 0,
    xrpCollateralUsd: 200,
    stableDebtUsd: 0,
    xrpDebtUsd: 50,
  }), null);
  assert.equal(xrpDropToLiquidation({
    stableCollateralUsd: 120,
    xrpCollateralUsd: 50,
    stableDebtUsd: 100,
    xrpDebtUsd: 0,
  }), null);
});

test("Morpho liquidation penalty follows each market LLTV", () => {
  assert.ok(Math.abs(morphoLiquidationPenaltyRate(77n * 10n ** 16n) - 0.07411385606874359) < 1e-12);
  assert.ok(Math.abs(morphoLiquidationPenaltyRate(625n * 10n ** 15n) - 0.12676056338028169) < 1e-12);
});
