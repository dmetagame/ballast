# Ballast

**Automated deleveraging for XRP-collateralised borrow positions on Flare.**

If XRP falls far enough, leveraged FXRP positions get liquidated and the borrower pays a
penalty. Ballast watches the position and, before the liquidation line is crossed, repays
part of the debt out of the collateral — spending a swap fee to avoid a liquidation penalty.

Built for the [Flare Summer Signal](https://dorahacks.io/hackathon/flaresummersignal/detail)
hackathon, Bounty 1 (Interoperable Asset Products).

---

## Why this exists, in numbers

Every figure below was measured on Flare mainnet by scanning contract events and reading
protocol state directly. The scanners live in [`monitor/`](monitor) and their raw output in
[`monitor/data/`](monitor/data).

| | |
|---|---|
| FXRP supply / holders | 149.9M / 13,412 |
| XRP-collateralised borrow positions | **739** across 676 addresses |
| Total debt | **$27.1M** against $57.0M collateral |
| Positions at health 1.0–1.25 | 148 ($4.15M debt) |

What a routine XRP move does to those positions:

| XRP drop | Positions liquidated | Debt | Penalties paid by borrowers |
|---|---|---|---|
| −10% | 33 | $1.06M | ~$55K |
| −20% | **121** | **$3.13M** | **~$183K** |
| −30% | 192 | $4.90M | ~$302K |

That ~$183K is the value Ballast exists to keep in borrowers' pockets.

Venues covered: **Morpho Blue** (`FXRP → USD₮0`, 77% LLTV, $18.0M debt — the largest single
market) and the **Enosys isolated markets** (a Compound-v2 fork).

## Why Flare specifically

Liquidation protection is a race against the oracle. FTSO block-latency feeds publish
XRP/USD on-chain about **every 2 seconds**, so there is room to act inside a price move.
On a chain with 30–60 second oracle latency the liquidators win first and the product does
not work. This is not a portable design.

## How it works

Ballast is **non-custodial**. The borrower keeps their position and their funds. They:

1. call `morpho.setAuthorization(ballast, true)`
2. call `ballast.setPolicy(...)` with their own hard limits

A protective action is a single atomic flash-loan deleverage:

```
flashLoan(loanToken, repayAmount)
  ├─ repay part of the borrower's debt on Morpho
  ├─ withdraw the matching slice of their collateral
  ├─ sell it on SparkDEX (slippage bound enforced by the adapter)
  └─ return the flash loan; surplus refunded to the borrower
```

Ballast never holds collateral outside one transaction, and **every action is bounded by the
borrower's own policy**: trigger health, target health, max collateral per action, max
slippage, keeper fee ceiling, cooldown. A keeper decides *when*; the policy decides *what is
permitted*. That separation is what makes it safe to hand the timing decision to someone
else — and, next, to a TEE.

Swaps go **directly against the pool**, not through a router. That removes a dependency on an
unverified router contract, saves a hop of fees, and works unchanged on both Algebra Integral
(SparkDEX V3.1) and Uniswap-V3-style pools, which share a `swap` signature and differ only in
the callback name.

### Sizing

To land on a target health factor `H` given collateral value `C`, debt `D`, loan-to-value
`L` and round-trip swap cost `s`:

```
R = D · (H − H_current) / (H − L/(1−s))
```

Derivation and rounding rules are in [`src/libraries/HealthMath.sol`](src/libraries/HealthMath.sol).
Health uses Morpho's own share accounting and virtual-share constants, so the number Ballast
acts on is exactly the number Morpho liquidates on.

---

## Liquidity is the binding constraint

This is the honest limit of the design, and it was measured rather than assumed.

Total FXRP↔USD₮0 depth on Flare is about **1.12M FXRP against 1.10M USD₮0**, concentrated in
two pools:

| Venue | FXRP | USD₮0 |
|---|---|---|
| SparkDEX Algebra `0x9274…7393` | 910,919 | 915,647 |
| SparkDEX UniV3 fee=500 `0x88D4…F1F7` | 209,583 | 187,134 |
| three other pools | ~147 | ~155 |

Measured slippage selling FXRP into the Algebra pool (fork pinned at block 66,470,000):

| FXRP sold | Algebra | UniV3 fee=500 |
|---|---|---|
| 1,000 | −65 bps | −37 bps |
| 10,000 | −76 bps | −217 bps |
| 25,000 | −96 bps | |
| 45,360 | −122 bps | −1,491 bps |
| 100,000 | −191 bps | |
| 250,000 | −399 bps | |
| 500,000 | **−1,807 bps** | |

Three consequences the design has to respect:

1. **A 1% slippage bound only works below ~40k FXRP.** Above that it reverts.
2. **Deleveraging beats liquidation only up to roughly 300k FXRP in one sale.** Morpho's
   liquidation incentive at 77% LLTV is ~7.4%, so a 250k sale (−399 bps) is still worth doing
   and a 500k sale (−1,807 bps) is worse than simply being liquidated.
3. **Liquidity is worst exactly when protection is needed.** Simulating a −10% drawdown
   faithfully — moving the *pool* as well as the oracle — takes ~250k FXRP of selling and
   leaves the book imbalanced. The same deleverage that costs ~1.2% on a calm pool costs
   **~4.8%** on the stressed one. It still beats a 7.4% liquidation, but a bound calibrated in
   calm markets will refuse to fire.

The mitigation already in the contract is `maxCollateralPerAction` plus `cooldown`: cap each
sale into the cheap part of the curve and repair the position in steps.

---

## Deployed on Flare mainnet

Live at chain 14, source verified on Blockscout.

| Contract | Address |
|---|---|
| `BallastManager` | [`0x379e5B8Cf31fC5D46aEc2fc17F17708951015571`](https://flare-explorer.flare.network/address/0x379e5B8Cf31fC5D46aEc2fc17F17708951015571) |
| `SparkDexAdapter` | [`0x62a7Efa10134E3F9fB7Af1fD7400Db0ea913E8b1`](https://flare-explorer.flare.network/address/0x62a7Efa10134E3F9fB7Af1fD7400Db0ea913E8b1) |
| `BallastManagerV3` | [`0x746066ACe5dc89a3692137b8cdE3c31328629d09`](https://flare-explorer.flare.network/address/0x746066ACe5dc89a3692137b8cdE3c31328629d09) |
| `SparkDexAdapterV2` | [`0xA3B9822228b6d0DE77089B0C67Ec0A73A9A9C202`](https://flare-explorer.flare.network/address/0xA3B9822228b6d0DE77089B0C67Ec0A73A9A9C202) |

The V3 contracts were deployed in block `67019411` on August 9, 2026 and are source verified.
The pool and ownership timelocks were finalized after Unix time `1786464298`: the production
owner now controls both contracts, the intended SparkDEX pool is active, and the manager is
unpaused.

Wired to the live market it was measured against: Morpho Blue
`0xF4346F5132e810f80a28487a79c7559d9797E8B0`, selling FXRP
`0xAd552A648C74D49E10027AB8a618A3ad4901c5bE` into USD₮0
`0xe7cd86e13AC4309349F30B3435a9d337750fC82D` through the SparkDEX Algebra pool
`0x927485d88a66253c63Af9163dca5f21c25A57393`.

**Owner powers, stated plainly.** Both contracts have the production `owner`
`0x302a6505c225bBB145569F35B89611d0677195a9`.
The owner can propose a different swap adapter and register pools on the adapter, but V3 applies
its configured administrative delay before either change is accepted. Borrower funds are never
held by Ballast and a protective action is bounded by
the borrower's own `maxCollateralPerAction` and `maxSlippageBps`, but a malicious adapter
could keep collateral routed through it during a `protect()` call. Anyone enrolling should
treat the owner as trusted, or wait for ownership to be renounced or moved behind a timelock.

## Status

Fork-tested against **live Flare mainnet state, real borrower positions, and real SparkDEX
liquidity**. Not audited.

The finalized production addresses also pass `./scripts/verify-production-fork.sh` at pinned
block `67260848`: the deployed V3 manager and adapter execute against a real borrower position
on a local Flare fork, improve health, and leave both manager token balances at zero.

```
$ forge test -vv                                    # 14 passed, 0 failed

Deleverage.fork.t.sol — manager logic, oracle-priced test venue
  [PASS] testRealPositionsAreReadable
    health small : 1.101993   (real position, ~$44k debt)
    health mid   : 1.167254   (real position, ~$83k debt)
    health whale : 1.208153   (real position, ~$699k debt)
  [PASS] testDeleverageRestoresHealthAfterPriceDrop   1.0509 -> 1.350000
  [PASS] testWhaleDeleverageAtDeeperDrop              0.9669 -> 1.300000  (was already liquidatable)
  [PASS] testProtectRevertsWhenPositionIsHealthy
  [PASS] testProtectRevertsWithoutMorphoAuthorization
  [PASS] testCollateralCapBoundsTheKeeper

Integration.fork.t.sol — no mocks: real Morpho position, real SparkDEX pool
  [PASS] testEndToEndDeleverageThroughSparkDex
    [drawdown] FXRP dumped into pool to move price: 249,689
    health after -10% drop : 1.050913
    repay (USD₮0)          : 47,063
    collateral sold (FXRP) : 51,411
    health after protect   : 1.350000
    keeper fee (USD₮0)     : 117
    surplus to borrower    : 186
  [PASS] testTightBoundRefusesInStressedPool      position left untouched
  [PASS] testChunkedDeleverageKeepsSalesSmall     1.0509 -> 1.220000 in one capped step

Liquidity.fork.t.sol — measured depth
  [PASS] testSlippageCurveOnAlgebraPool
  [PASS] testSlippageCurveOnUniV3Pool
  [PASS] testOnePercentBoundHoldsOnlyBelowAboutFortyThousand
  [PASS] testDeleverageBeatsLiquidationOnlyUpToAboutThreeHundredThousand
  [PASS] testSlippageBoundReverts
```

The borrower addresses in the tests are genuine mainnet accounts found by event scan. They
have not enrolled; the tests grant authorization via `vm.prank` to prove the mechanism works
against real collateral and real market state.

## Layout

```
src/
  BallastManager.sol            policy registry + flash-loan deleverage
  adapters/SparkDexAdapter.sol  direct pool swaps (Algebra + UniV3 callbacks)
  libraries/HealthMath.sol      Morpho-exact health and deleverage sizing
  libraries/SafeTransfer.sol    USDT-family safe ERC20 helpers
  interfaces/                   Morpho Blue, oracle, swap adapter
test/
  Deleverage.fork.t.sol         manager logic vs. live positions
  Integration.fork.t.sol        full path, no mocks
  Liquidity.fork.t.sol          measured slippage curves
  mocks/MockSwapAdapter.sol     oracle-priced test venue
  mocks/PoolPusher.sol          walks a pool's price to simulate a drawdown
dashboard/
  template.html                 the page; data is injected at build time
  build.mjs                     merges monitor/data into a self-contained index.html
script/
  Deploy.s.sol                  deploys adapter + manager against a Morpho deployment
  Demo.s.sol                    opens a position, enrols it, has a keeper rescue it
demo.sh                         one-command forked-mainnet demo
monitor/
  scan-morpho-*.mjs             Morpho market + position risk scanners
  scan-enosys-*.mjs             Enosys isolated market scanners
  data/                         measured mainnet output
```

## The risk dashboard

`dashboard/index.html` is a self-contained page over the measured mainnet dataset: 739
XRP-collateralised positions, filterable by venue, with the health distribution, the
drawdown-sensitivity curve, and the positions closest to liquidation. No runtime fetches, so
it works from a `file://` URL or any static host.

```bash
node monitor/redact.mjs         # truncate borrower addresses in the data snapshot
node dashboard/build.mjs        # regenerate the page from monitor/data/*.json
```

Borrower addresses in the committed snapshot and on the page are truncated. The scanners
need full addresses at runtime and will write them locally; `monitor/redact.mjs` truncates
them before anything is published, and errors rather than collapsing two distinct addresses
onto one label, so counts of unique addresses stay exact. These positions are public
on-chain state that anyone can recompute — the point is not to also hand out a ranked,
directly actionable list of who is closest to being liquidated.

## Try it

The product landing page is publicly deployed at
`https://ballast-landing-sepia.vercel.app`. It links to the measured risk dashboard at
`https://ballast-alpha.vercel.app` and the V3 enrollment app below. The landing page
lives in `landing/`; regenerate its committed figures with `node landing/data.mjs` before
publishing updated market claims.

One command, no testnet, no keys, no faucet:

```bash
./demo.sh
```

## Run the keeper

The keeper discovers `PolicySet` events, reads each borrower's current policy,
calls `previewProtect`, and reports only positions that are actionable. It is dry-run by default:

```bash
cd monitor
npm run keeper:dry-run
```

After reviewing the output, an operator can opt into execution with a funded Flare account. The
keeper simulates each transaction before submitting it and never overrides a borrower's policy:

```bash
RPC_URL=https://flare-api.flare.network/ext/C/rpc \
PRIVATE_KEY_FILE=/run/secrets/ballast-keeper-key \
EXECUTE=true \
npm run keeper:execute
```

Useful controls are `BALLAST`, `FROM_BLOCK`, `EXPLORER_URL`, and `MAX_POSITIONS`. The default
manager and start block are the finalized V3 deployment. Keep the private key outside shell
history and use a dedicated keeper account. Supplying the protected key during dry-run lets the
keeper prove that each V3 policy names this operator; a failed simulation is skipped rather than
broadcast.

For hardened production operation, set `MANAGER_VERSION=v3` and point `BALLAST` at
`0x746066ACe5dc89a3692137b8cdE3c31328629d09`. V3 requires each borrower to name the keeper that may act on their
policy; the keeper refuses to execute a V3 policy configured for another operator.

The hosted operator is `0xA20a59090f609329405F5DcA785Af9357F6965E7`. Its AWS service is active
with `EXECUTE=false`; it is not yet a protection SLA and will remain dry-run until a controlled
mainnet `Protected` receipt succeeds.

The borrower enrollment app lives in `app/` and is publicly deployed at
`https://ballast-enrollment.vercel.app`. It targets the finalized V3 manager with enrollment
writes enabled:

```bash
cd app
VITE_BALLAST_MANAGER=0x746066ACe5dc89a3692137b8cdE3c31328629d09 \
VITE_BALLAST_KEEPER=0xA20a59090f609329405F5DcA785Af9357F6965E7 \
VITE_ENABLE_ENROLLMENT_WRITES=true \
VITE_MANAGER_VERSION=v3 \
npm run build
npm run verify:production
```

The public enrollment surface is a controlled beta: policy writes are available, but the hosted
keeper does not broadcast protection yet. Users must not treat enrollment alone as active
liquidation protection.

It forks Flare mainnet into a local anvil node, funds a demo borrower with real FXRP by
impersonating a real holder, deploys Ballast, opens a leveraged position, and has a keeper
rescue it. Morpho, FXRP, USD₮0, the oracle and the SparkDEX pool are all the live mainnet
contracts.

```
==> starting anvil forked from Flare mainnet @ block 66470000
==> funding demo borrower with 100k FXRP from a real holder
==> deploying Ballast
    BallastManager  : 0x1613beB3B2C4f22Ee086B2b38C1476A3cE7f78E8
    SparkDexAdapter : 0x9E545E3C0baAB3E08CdfD552C960A1050f373042

  === position opened ===
    collateral (FXRP)  : 100000
    borrowed (USD0)    : 66654
    health             : 1.250000
    below trigger?     : true

  === keeper preview ===
    would repay (USD0) : 36143
    would sell (FXRP)  : 34084

  === after protect ===
    health             : 1.250000 -> 1.800000
    collateral left    : 65915 FXRP
    keeper fee (USD0)  : 90
    surplus to borrower: 249
    ballast holds FXRP : 0          <- nothing retained
    ballast holds USD0 : 0
```

The demo needs no price manipulation: the borrower opens at a health their policy already
considers unsafe, which exercises exactly the code path a drawdown would take.

## Running

```bash
forge build
forge test -vv                        # forks Flare mainnet at a pinned block

cd monitor && npm install
NODE_OPTIONS=--dns-result-order=ipv4first npm run scan:morpho
```

To deploy against a real network:

```bash
forge script script/Deploy.s.sol --rpc-url flare --broadcast --account $KEYSTORE --verify
```

That is exactly how the mainnet deployment above was made. The whole sequence cost 3.17 FLR.
Override `MORPHO`, `COLLATERAL_TOKEN`, `LOAN_TOKEN` and `SWAP_POOL` in the environment to
target a different market.

Two things that will waste your time otherwise:

- **`evm_version` must be `cancun` or `shanghai`.** Flare mainnet contracts use opcodes
  unavailable under `paris`; a fork test otherwise fails with `EvmError: NotActivated` on the
  first oracle call.
- **`deal` does not work on FXRP.** FAsset tokens keep checkpointed internal accounting, so
  writing the raw balance slot leaves inconsistent state and the next transfer panics with an
  arithmetic underflow. Fund tests by `vm.prank`-ing a real holder instead.

## Production status and remaining operational work

- **Coston2 uses a test market.** The FCC integration has a Coston2 Morpho deployment backed by
  the live FTSOv2 XRP/USD feed, but its collateral, loan token and oracle-quoted swap venue are
  scaffolding. Mainnet execution and liquidity claims remain grounded in the fork tests.
- **The production owner is an EOA.** The published V1 deployment remains unchanged for
  compatibility; production enrollment targets finalized V3. Manager and adapter admin changes
  are delayed, protection can be guardian-paused, and both ownership handoffs are complete.
- **The keeper is hosted but intentionally dry-run.** The AWS service runs continuously with
  restart supervision and execution-economics bounds, but no borrower has enrolled on V3 and no
  live `Protected` receipt exists. It is not an uptime or protection guarantee.
- **Single-venue routing.** The adapter swaps against one registered pool per pair. Splitting
  across the Algebra and UniV3 pools would add roughly 20% more depth.
- **The drawdown simulation is a worst case.** `PoolPusher` moves the price by dumping into a
  single pool with no arbitrage response, so the ~4.8% stressed cost is pessimistic; real
  markets would see the pool re-balanced against other venues. The calm-pool ~1.2% is
  correspondingly optimistic. Reality sits between them.
- **Surplus is returned as loan token,** not re-supplied as collateral. Value is preserved but
  the borrower ends up holding USD₮0 rather than a larger position.
- **FCC infrastructure is fresh; private-flow evidence is not.** Extension `0x10246` and TEE
  `0xd56b33B50F76E126616d9545E3469De45415d152` are PRODUCTION on the redeployed Coston2 manager
  at `https://ballast.rouma.online`. A new private salt, encrypted enrollment, evaluation, and
  relayed verdict receipt are still required before claiming an end-to-end confidential flow.

The complete deployment runbook, role separation, finalization sequence, and pre-enrollment
checks are in `docs/PRODUCTION_DEPLOYMENT.md`.

The always-on FCC and keeper migration procedure is in `docs/VPS_DEPLOYMENT.md`.

## Licence

MIT
