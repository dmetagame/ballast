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
VITE_BALLAST_MANAGER=0x746066ACe5dc89a3692137b8cdE3c31328629d09
VITE_BALLAST_KEEPER=0xA20a59090f609329405F5DcA785Af9357F6965E7
VITE_ENABLE_ENROLLMENT_WRITES=true
VITE_MANAGER_VERSION=v3
```

Build and deploy from `app/` only after the pool is active and ownership state is confirmed.
Run `npm run verify:production` after the build; it fails if the bundle contains the legacy
manager, wrong keeper, wrong ABI version, or disabled writes.

Use `scripts/activate-production.sh` for production releases. It also updates the public alias
and runs `npm run verify:deployment` against the live artifact before returning success.

## Keeper configuration

```text
BALLAST=0x746066ACe5dc89a3692137b8cdE3c31328629d09
MANAGER_VERSION=v3
FROM_BLOCK=67019411
STATE_FILE=<persistent writable checkpoint path>
BLOCKSCOUT_URL=https://flare-explorer.flare.network
CONFIRMATION_BLOCKS=12
RPC_LOG_PAGE_BLOCKS=30
LOG_QUERY_CONCURRENCY=4
MAX_POSITIONS=0
EXECUTE=false
RUN_ONCE=false
PRIVATE_KEY_FILE=<protected credential path when running outside systemd>
MAX_GAS_FLR_WEI=<hard ceiling>
MIN_KEEPER_FEE_UNITS=<USD₮0 base units>
LOAN_TOKEN_UNITS_PER_FLR=<USD₮0 base units per FLR>
MIN_PROFIT_FLR_WEI=<minimum net profit>
```

Run the keeper under a process supervisor with log collection and restart policy. Confirm the keeper address shown in the enrollment app matches the operator account.

The checkpoint file records only public borrower/market identifiers and the next confirmed block.
Keep it on persistent storage writable by the service. `MAX_POSITIONS=0` scans every discovered
policy; any positive cap is a circuit breaker and causes the cycle to fail rather than process a
partial set.

The repository includes a hardened user-level systemd unit:

```bash
./scripts/install-keeper-service.sh
$EDITOR ~/.config/ballast/keeper.env
systemctl --user enable --now ballast-keeper
journalctl --user -u ballast-keeper -f
```

The installer creates the environment file with mode `0600` and does not start the service until
the operator explicitly enables it.

The systemd unit loads the keeper key from `~/.config/ballast/keeper.private-key` through
`LoadCredential`; the key is not placed in `keeper.env` or exported directly by the service.
Write the dedicated keeper key to that file with mode `0600` only after dry-run validation, and
never configure both `PRIVATE_KEY` and `PRIVATE_KEY_FILE`.

## Pre-enrollment checks

1. Verified source is visible for both contracts.
2. `poolFor(FXRP, USD₮0)` returns the intended SparkDEX pool.
3. Manager `swapAdapter()` returns the V2 adapter.
4. Adapter `manager()` returns the V3 manager.
5. Manager and adapter owners are the intended production owner.
6. Guardian is a distinct address and pause/unpause has been rehearsed on a fork.
7. Keeper dry run reports no errors.
8. A controlled small position completes authorization, policy enrollment, preview, and protection.

## Current delivery state — August 12, 2026

Completed and verified:

- GitHub `main` contains the productionization changes.
- Enrollment app is publicly available at `https://ballast-enrollment.vercel.app`.
- V3 is finalized on Flare mainnet. `BallastManagerV3` is
  `0x746066ACe5dc89a3692137b8cdE3c31328629d09` and `SparkDexAdapterV2` is
  `0xA3B9822228b6d0DE77089B0C67Ec0A73A9A9C202`.
- The deployment was mined in block `67019411` (`0x3fea293`), and both contracts are
  source verified on Flare Explorer.
- The active FXRP/USD₮0 pool is `0x927485d88a66253c63Af9163dca5f21c25A57393`.
- The production owner `0x302a6505c225bBB145569F35B89611d0677195a9` owns both contracts;
  pending ownership and pool proposals are cleared.
- `scripts/verify-production.sh` confirms the manager/adapter binding, owner, guardian, pool,
  unpaused state, and empty pending admin actions.
- `scripts/verify-production-fork.sh` passes against pinned block `67260848`, executing the
  deployed V3 manager and adapter against a real position.
- The AWS keeper service is active without restarts, targets V3 from block `67019411`, applies
  gas/fee/profit bounds, and remains `EXECUTE=false`.
- The dedicated keeper is `0xA20a59090f609329405F5DcA785Af9357F6965E7`.
- V3 unit tests, the production fork, app production-build verification, landing verification,
  keeper tests, FCC tests, and dependency audits pass.

Still required before broad enrollment:

1. Fund and enroll a consenting controlled borrower with a small FXRP/USD₮0 Morpho position.
2. Confirm Morpho authorization, V3 policy, keeper preview, and one real `Protected` receipt.
3. Verify improved health, borrower surplus, and zero manager balances from that receipt.
4. Enable keeper execution only after the controlled flow succeeds.

Phase-one transaction hashes remain in the ignored Foundry broadcast artifact at
`broadcast/DeployV3.s.sol/14/run-latest.json` on the deployment host.

| Action | Transaction |
|---|---|
| Deploy `SparkDexAdapterV2` | `0xd9b010cceb32a0298ecd7a943ab49fa134cd4571d990550b2298038ec4cbf39b` |
| Propose FXRP/USD₮0 pool | `0x5d81a73d00313d4182ab89215bffeddb3029a4dc4bc155caf86c0cb34136c4a6` |
| Deploy `BallastManagerV3` | `0x8637d727e2790cbbee03ae1a103dd89fbc83eab47ee9bc4d7611f38b86d3c0ce` |
| Bind adapter manager | `0x213b91c327b55fa3c2bbcd2ffb333f9e56245aaf3147962d8c25a26083964c17` |
| Propose manager ownership | `0xd4aa220b9ba1262ef02e1bfc46cbd5850ad83438603a3fd0677c2a44394a0369` |
| Propose adapter ownership | `0x5da52dacbe7bea3c3049407ad8cb0349a14e1b265d5d660096c48df8adfadf1a` |
