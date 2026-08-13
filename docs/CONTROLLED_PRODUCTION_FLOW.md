# Controlled mainnet protection receipt

This flow uses a dedicated encrypted borrower keystore, the finalized V3 manager, the named
production keeper, and deliberately tiny capital. Never use a public Anvil account or paste a
private key into a command, chat, environment file, or repository.

## Safety gates

1. `./scripts/verify-production.sh` passes.
2. `./scripts/verify-production-fork.sh` passes.
3. `./scripts/verify-controlled-production-fork.sh` passes.
4. The hosted keeper remains `EXECUTE=false`.
5. The borrower is a dedicated encrypted keystore outside the repository.
6. The setup input and both swap minimums are reviewed before broadcast.

The local controlled borrower is expected at `~/.foundry/keystores/controlled-borrower`, with its
password at `~/.config/ballast/controlled-borrower.password`, both mode `0600`.

Derive conservative swap minimums from a no-broadcast Flare simulation immediately before the
live run:

```bash
MINIMUM_BPS=9900 forge script \
  script/ControlledProductionFlow.s.sol:QuoteControlledProductionFlow \
  --rpc-url flare -vv
```

Review the quoted acquisition output and use `MIN_FXRP_OUT` only while current pool conditions
remain comparable. The printed round-trip WFLR value is a full-size reference only; protection
reduces the FXRP later sold during cleanup, so that value must never be reused as `MIN_WFLR_OUT`.
The live helper's runtime bytecode is pinned by the setup and cleanup scripts.

## Deploy the acquisition helper

```bash
forge script script/ControlledProductionFlow.s.sol:DeployControlledFxrpSwapper \
  --rpc-url flare --broadcast --slow \
  --account botfun-agent \
  --password-file ~/.foundry/keystores/botfun-agent.password
```

Record the printed helper address as `SWAPPER`. Its bytecode hardcodes the live WFLR/FXRP pool and
tokens, and its constructor rejects an unexpected token ordering.

## Fund and set up

Fund the borrower with only the reviewed FLR amount needed for the one-FLR acquisition and gas.
Then run setup with a nonzero minimum FXRP output:

```bash
BORROWER=0x... \
SWAPPER=0x... \
MIN_FXRP_OUT=... \
forge script script/ControlledProductionFlow.s.sol:ControlledProductionSetup \
  --rpc-url flare --broadcast --slow \
  --account controlled-borrower \
  --password-file ~/.config/ballast/controlled-borrower.password
```

Setup refuses an existing position, existing authorization, existing policy, a public Anvil
borrower, the wrong keeper, an unrecognized helper, or a zero minimum output. It buys a tiny FXRP
amount directly from SparkDEX, opens a Morpho position near health `1.25`, authorizes V3, and sets
an immediately actionable `1.50 → 1.80` controlled policy.

## Inspect and protect

Confirm the AWS keeper discovers the policy while remaining dry-run. Execute one protection
manually with the protected production keeper keystore:

```bash
BORROWER=0x... \
forge script script/ControlledProductionFlow.s.sol:ControlledProductionProtect \
  --rpc-url flare --broadcast --slow \
  --account mainnet-keeper \
  --password-file ~/.config/ballast/mainnet-keeper.password
```

Extract the protection transaction hash from the Foundry broadcast artifact and verify it:

```bash
cd monitor
BORROWER=0x... PROTECTION_TX=0x... npm run verify:controlled
```

The verifier requires a Flare transaction sent by the production keeper directly to the production
manager's `protect(address,bytes32)` function, exactly one successful `Protected` event, improved
health, nonzero repay, collateral sale and keeper fee, and zero FXRP/USD₮0 balances on the manager
in the receipt block.

## Cleanup

First simulate the exact cleanup against current borrower and pool state with a permissive minimum.
This does not broadcast, and prints the actual remaining FXRP input plus a size-corrected minimum:

```bash
BORROWER=0x... \
SWAPPER=0x... \
MIN_WFLR_OUT=1 \
MINIMUM_BPS=9900 \
forge script script/ControlledProductionFlow.s.sol:ControlledProductionCleanup \
  --rpc-url flare \
  --account controlled-borrower \
  --password-file ~/.config/ballast/controlled-borrower.password
```

Review the simulated output, then immediately rerun with the printed `MIN_WFLR_OUT` and
`--broadcast --slow` while pool conditions remain comparable:

```bash
BORROWER=0x... \
SWAPPER=0x... \
MIN_WFLR_OUT=... \
forge script script/ControlledProductionFlow.s.sol:ControlledProductionCleanup \
  --rpc-url flare --broadcast --slow \
  --account controlled-borrower \
  --password-file ~/.config/ballast/controlled-borrower.password
```

Cleanup disables the policy first, repays every remaining borrow share, withdraws all collateral,
revokes V3 authorization, sells remaining FXRP back to WFLR, and unwraps it to FLR. Verify the
same receipt again with cleanup state required:

```bash
cd monitor
BORROWER=0x... PROTECTION_TX=0x... EXPECT_CLEANUP=true npm run verify:controlled
```

Do not set the AWS keeper to `EXECUTE=true` solely because this flow succeeds. External alerts,
an execution runbook, and an explicit operator decision remain separate production gates.
