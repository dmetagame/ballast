# Ballast V3 production deployment

Ballast V3 is a fresh deployment. It does not upgrade or mutate the published V1 contracts, and no borrower policies currently need migration.

## Roles

Use separate production identities:

- `deployer`: temporary account that broadcasts deployment and finalization.
- `owner`: delayed administrative owner for the manager and adapter, preferably a multisig.
- `guardian`: separate address that may pause protection but cannot change policies or adapters.
- `keeper`: dedicated low-balance operator key used by enrolled borrowers.

Do not use one EOA for all four roles.

## Phase 1 — deploy and start timelocks

```bash
GUARDIAN=0x... \
OWNER=0x... \
ADMIN_DELAY=172800 \
forge script script/DeployV3.s.sol \
  --rpc-url flare \
  --broadcast \
  --account <deployer-keystore> \
  --verify
```

This deploys `BallastManagerV3` and `SparkDexAdapterV2`, pins the manager permanently into the adapter, proposes the FXRP/USD₮0 SparkDEX pool, and proposes delayed ownership handoffs.

The deployment is intentionally not usable until the configured delay has elapsed and the pool proposal is accepted.

## Phase 2 — finalize after the delay

Run with the current adapter owner to activate the pool. If the pending production owner is the signer, the same script also accepts manager and adapter ownership.

```bash
BALLAST_V3=0x... \
ADAPTER_V2=0x... \
forge script script/FinalizeV3.s.sol \
  --rpc-url flare \
  --broadcast \
  --account <authorized-keystore>
```

If deployer and final owner differ, run finalization once with the deployer for pool activation and once with the final owner for both ownership acceptances.

## App configuration

```text
VITE_BALLAST_MANAGER=0x...
VITE_ENABLE_ENROLLMENT_WRITES=true
VITE_MANAGER_VERSION=v3
```

Build and deploy from `app/` only after the pool is active and ownership state is confirmed.

## Keeper configuration

```text
BALLAST=0x...
MANAGER_VERSION=v3
FROM_BLOCK=<deployment block>
EXECUTE=true
RUN_ONCE=false
PRIVATE_KEY=<dedicated keeper key>
MAX_GAS_FLR_WEI=<hard ceiling>
MIN_KEEPER_FEE_UNITS=<USD₮0 base units>
LOAN_TOKEN_UNITS_PER_FLR=<USD₮0 base units per FLR>
MIN_PROFIT_FLR_WEI=<minimum net profit>
```

Run the keeper under a process supervisor with log collection and restart policy. Confirm the keeper address shown in the enrollment app matches the operator account.

## Pre-enrollment checks

1. Verified source is visible for both contracts.
2. `poolFor(FXRP, USD₮0)` returns the intended SparkDEX pool.
3. Manager `swapAdapter()` returns the V2 adapter.
4. Adapter `manager()` returns the V3 manager.
5. Manager and adapter owners are the intended production owner.
6. Guardian is a distinct address and pause/unpause has been rehearsed on a fork.
7. Keeper dry run reports no errors.
8. A controlled small position completes authorization, policy enrollment, preview, and protection.

## Current delivery state — August 9, 2026

Completed and verified:

- GitHub `main` contains the productionization changes.
- Enrollment app is publicly available at `https://ballast-enrollment.vercel.app`.
- App is intentionally read-only because the legacy manager is still the configured address.
- V3 deployment simulation succeeds and estimates approximately `9.61 FLR` for phase one at the current RPC gas estimate.
- V3 unit tests, V3 fork tests, existing live Flare suites, app build, keeper tests, and FCC tests pass.

Still required before enabling production writes:

1. Fund the deployer with at least the simulated gas amount plus operating reserve.
2. Provide a production multisig or owner address.
3. Provide a separate guardian address.
4. Provide a separate keeper address and fund it with FLR for gas.
5. Broadcast `DeployV3.s.sol`.
6. Wait the configured admin delay.
7. Run `FinalizeV3.s.sol` with the correct owner/deployer signers.
8. Verify both contracts on Flare Explorer.
9. Rebuild/redeploy the app with `VITE_MANAGER_VERSION=v3`, the new manager address, and writes enabled.
10. Run keeper dry-run, enroll a controlled test position, and verify one real protection receipt before broad enrollment.
