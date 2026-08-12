# Ballast — Flare Summer Signal submission pack

## Track

**Bounty 1: Interoperable Asset Products.** Ballast protects leveraged FXRP positions on Flare by atomically deleveraging a borrow before liquidation.

The optional Bounty 2 work is documented separately as an FCC prototype. The primary submission should lead with the deployed, fork-tested Bounty 1 product rather than overclaiming a cross-chain FCC flow that is not live end-to-end.

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

- Finalized and verified Flare mainnet deployment: `BallastManagerV3` and `SparkDexAdapterV2`.
- Policy-controlled authorization: borrower chooses trigger, target, action cap, slippage, fee, and cooldown.
- Atomic Morpho flash-loan deleveraging with zero retained collateral.
- Direct SparkDEX pool integration with an enforced minimum output.
- Morpho-exact health and repayment sizing.
- Fork tests against real Morpho positions and real SparkDEX liquidity.
- Static risk dashboard from measured Flare mainnet state.
- Hosted enrollment UI with Morpho authorization, V3 policy setup, and borrower exit controls.
- Always-on AWS keeper service that discovers policies, verifies the named V3 operator, calls
  `previewProtect`, simulates before execution, and remains dry-run pending a controlled receipt.
- Fresh FCC extension and simulated TEE in PRODUCTION on the redeployed Coston2 manager.

## Hosted surfaces

- Product narrative: `https://ballast-landing-sepia.vercel.app`
- Measured risk dashboard: `https://ballast-alpha.vercel.app`
- Controlled enrollment beta: `https://ballast-enrollment.vercel.app`
- FCC proxy: `https://ballast.rouma.online`

The enrollment UI accepts policy transactions, but the hosted keeper remains dry-run. Do not
describe an enrolled policy as active automated protection until the live receipt milestone is met.

## Work completed during Summer Signal

During Summer Signal we scanned Flare lending markets, measured the FXRP liquidation surface
and DEX depth, implemented the policy registry and atomic Morpho/SparkDEX deleveraging path,
deployed and verified V1 and hardened V3 contracts on Flare mainnet, built fork and liquidity
tests, shipped the dashboard, landing and enrollment surfaces, deployed a dry-run keeper to AWS,
and registered the confidential trigger extension and TEE on Coston2.

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
- Finalized production-state check: `./scripts/verify-production.sh`.
- Deployed-address fork check: `./scripts/verify-production-fork.sh`.
- Solidity test suite: `forge test --match-path 'test/*'` with fork tests requiring network access.
- FCC unit and cross-language tests: `cd fce && go test ./...`.
- Keeper dry run: `cd monitor && node keeper.mjs`.
- Keeper execution is explicit: `EXECUTE=true PRIVATE_KEY_FILE=... node keeper.mjs`.

## Judge-facing metrics

The committed measurement snapshot reports 739 XRP-collateralised borrow positions, approximately $27.1M debt against $57.0M collateral, and 148 positions in the 1.0–1.25 health range. The forked end-to-end test moves a position from health 1.0509 to 1.3500 while selling 51,411 FXRP and repaying 47,063 USD₮0.

## Honest limitations

- The mainnet contract owner is an EOA; adapter and pool changes are delayed but remain trusted administration.
- The system is not audited.
- Liquidity is finite; action caps and cooldowns are deliberate safety controls.
- The hosted keeper is intentionally dry-run and is not a guaranteed service-level promise.
- No consenting borrower has completed a real mainnet enrollment and protection receipt yet.
- FCC currently demonstrates confidential verdict verification on Coston2; it does not claim that a Coston2 verdict directly deleverages a mainnet position.

## Roadmap

1. Complete a controlled mainnet enrollment and publish the first `Protected` receipt.
2. Enable keeper execution with external alerts only after that receipt succeeds.
3. Route across multiple FXRP/loan pools to improve stressed liquidity.
4. Move EOA ownership to a multisig or governance contract.
5. Complete a private FCC enrollment, evaluation, and relayed verdict receipt.
