# Ballast — Flare Summer Signal submission pack

## Track

**Bounty 1: Interoperable Asset Products.** Ballast protects leveraged FXRP positions on Flare by atomically deleveraging a borrow before liquidation.

The optional Bounty 2 work is documented separately as an FCC prototype. The primary submission should lead with the live, fork-tested Bounty 1 product rather than overclaiming a cross-chain FCC deployment that is not yet live end-to-end.

## One-line product

Ballast is a non-custodial, policy-bounded keeper that sells a small amount of FXRP to repay a borrower's USD₮0 debt before Morpho liquidation, preserving more value than a liquidation penalty.

## Problem and user

Leveraged FXRP borrowers can lose approximately 7.4% of position value when a Morpho position is liquidated. The user is an XRP holder who wants leverage without continuously watching Flare oracle updates or surrendering custody to an automated vault.

## Why Flare is essential

- FXRP brings XRP liquidity into EVM applications.
- Morpho Blue provides the borrow position Ballast protects.
- FTSO-priced health factors determine when the position becomes unsafe.
- SparkDEX provides the FXRP-to-USD₮0 sale used to repay the flash loan.
- Flare's short oracle update cadence makes timely intervention plausible.

## What is implemented

- Live Flare mainnet deployment: `BallastManager` and `SparkDexAdapter`.
- Policy-controlled authorization: borrower chooses trigger, target, action cap, slippage, fee, and cooldown.
- Atomic Morpho flash-loan deleveraging with zero retained collateral.
- Direct SparkDEX pool integration with an enforced minimum output.
- Morpho-exact health and repayment sizing.
- Fork tests against real Morpho positions and real SparkDEX liquidity.
- Static risk dashboard from measured Flare mainnet state.
- Dry-run-first keeper service that discovers policies and calls `previewProtect` before optional execution.

## Demonstration script

1. Open the dashboard and show the measured FXRP risk surface.
2. Run `./demo.sh` to fork Flare mainnet locally.
3. Show the borrower position at the trigger line.
4. Show the keeper preview: repayment, collateral sale, and policy bounds.
5. Execute protection and show health increasing, collateral decreasing, surplus refunded, and Ballast ending with zero token balances.
6. Open the verified mainnet contract addresses and show the `PolicySet` and `Protected` event surfaces.

## Evidence

- Mainnet contracts and explorer links are recorded in `README.md`.
- Reproducible demo: `./demo.sh`.
- Solidity test suite: `forge test --match-path 'test/*'` with fork tests requiring network access.
- FCC unit and cross-language tests: `cd fce && go test ./...`.
- Keeper dry run: `cd monitor && node keeper.mjs`.
- Keeper execution is explicit: `EXECUTE=true PRIVATE_KEY=... node keeper.mjs`.

## Judge-facing metrics

The committed measurement snapshot reports 739 XRP-collateralised borrow positions, approximately $27.1M debt against $57.0M collateral, and 148 positions in the 1.0–1.25 health range. The forked end-to-end test moves a position from health 1.0509 to 1.3500 while selling 51,411 FXRP and repaying 47,063 USD₮0.

## Honest limitations

- The mainnet contract owner is an EOA and can change the adapter.
- The system is not audited.
- Liquidity is finite; action caps and cooldowns are deliberate safety controls.
- The keeper is permissionless infrastructure, not a guaranteed service-level promise.
- FCC currently demonstrates confidential verdict verification on Coston2; it does not claim that a Coston2 verdict directly deleverages a mainnet position.

## Roadmap

1. Run the keeper continuously with alerts and transaction simulation.
2. Route across multiple FXRP/loan pools to improve stressed liquidity.
3. Move owner powers behind a timelock or governance contract.
4. Complete fresh FCC enrollment with private policy salt and stable proxy infrastructure.
5. Explore a unified confidential trigger for the live protection path.
