const WAD = 10n ** 18n;
const LIQUIDATION_CURSOR = 3n * 10n ** 17n;
const MAX_LIQUIDATION_INCENTIVE_FACTOR = 115n * 10n ** 16n;

function assertFiniteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
}

export function xrpDropToLiquidation({
  stableCollateralUsd,
  xrpCollateralUsd,
  stableDebtUsd,
  xrpDebtUsd,
}) {
  for (const [label, value] of Object.entries({ stableCollateralUsd, xrpCollateralUsd, stableDebtUsd, xrpDebtUsd })) {
    assertFiniteNonNegative(value, label);
  }
  const stableMargin = stableCollateralUsd - stableDebtUsd;
  const netXrpCollateral = xrpCollateralUsd - xrpDebtUsd;
  if (netXrpCollateral <= 0 || stableMargin >= 0) return null;
  const liquidationMultiplier = -stableMargin / netXrpCollateral;
  return (1 - liquidationMultiplier) * 100;
}

export function morphoLiquidationPenaltyRate(lltv) {
  const lltvWad = BigInt(lltv);
  if (lltvWad < 0n || lltvWad >= WAD) throw new Error("Morpho LLTV must be between zero and one WAD");
  const cursorAdjustment = LIQUIDATION_CURSOR * (WAD - lltvWad) / WAD;
  const denominator = WAD - cursorAdjustment;
  const uncappedFactor = WAD * WAD / denominator;
  const factor = uncappedFactor < MAX_LIQUIDATION_INCENTIVE_FACTOR
    ? uncappedFactor
    : MAX_LIQUIDATION_INCENTIVE_FACTOR;
  return Number(factor - WAD) / 1e18;
}
