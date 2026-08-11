# Ballast hackathon audit

This audit maps the repository's current state to the Flare Summer Signal product and judging requirements. It distinguishes verifiable implementation from planned or externally blocked work.

## Executive assessment

Ballast is already a strong Bounty 1 submission. It solves a measured problem for FXRP borrowers, depends materially on Flare-native assets and pricing, has verified mainnet contracts, and demonstrates the complete protection transaction against forked live state.

The principal submission risk is not missing smart-contract functionality. It is product packaging and evidence: no real borrower has enrolled, the keeper is operator software rather than a hosted service, and the FCC work must be described as a separate Coston2 prototype rather than a completed mainnet confidential-protection path.

## Eligibility and submission completeness

| Requirement | State | Evidence or action |
|---|---|---|
| Project name | Ready | Ballast |
| Selected bounty | Ready | Lead with Bounty 1: Interoperable Asset Products |
| Product description | Ready | `README.md` and `docs/HACKATHON_SUBMISSION.md` |
| Target user | Ready | Leveraged FXRP borrower on Morpho |
| Working demo | Ready | `./demo.sh` against a Flare mainnet fork |
| Repository | Ready | Public GitHub repository |
| Flare integration explanation | Ready | FXRP, Morpho, FTSO-priced oracle path, SparkDEX |
| New work explanation | Needs final wording | Add dated before/during-hackathon summary to DoraHacks form |
| Deployments | Ready | Mainnet and Coston2 addresses documented |
| Roadmap | Ready | Submission pack and README known gaps |
| Demo video | Missing | Record a concise end-to-end walkthrough |
| Hosted product link | Partial | Static dashboard is hostable; protection demo remains CLI/fork based |

## Judging criteria

### Product usefulness — strong

- The user and failure mode are precise: XRP holders borrowing against FXRP can incur liquidation penalties during price drops.
- The repository quantifies the addressable risk from Flare mainnet state rather than relying on hypothetical market size.
- Ballast preserves borrower custody and lets the borrower set all hard action limits.
- The key missing proof is external use. No borrower has enrolled on the published manager, so traction should be stated as market validation and technical validation, not adoption.

Recommended evidence before submission:

1. Ask at least three XRP/Flare users or protocol contributors to test the dashboard and demo.
2. Record their feedback and any resulting change.
3. If safe, enroll a controlled mainnet or fork demonstration account and capture the full policy-to-protection flow.

### Flare integration quality — very strong

- FXRP is the collateral being protected.
- Morpho Blue on Flare is the lending primitive.
- The market oracle path is used in Morpho-exact health calculations.
- SparkDEX liquidity settles the deleveraging transaction.
- The system is materially chain-specific because timely price updates and Flare liquidity determine whether protection can beat liquidation.

Avoid claiming that Ballast directly calls FTSO contracts on mainnet unless the exact deployed Morpho oracle path is shown. The accurate claim is that Ballast reads the Morpho market oracle, whose Flare deployment supplies the price used by the lending market.

### Technical execution — strong

- Mainnet contracts are deployed and source verified.
- The protection path is atomic and non-custodial.
- Slippage, action size, cooldown, keeper compensation, and authorization are borrower-bounded.
- The manager and adapter retain no normal transaction surplus.
- Fork tests cover real Morpho positions, real tokens, real oracle behavior, and real SparkDEX pools.
- Liquidity tests document where deleveraging stops being economically rational.
- The new keeper discovers enrolled policies, previews actions, defaults to dry-run, simulates before broadcast, and requires explicit execution credentials.

Remaining technical risks:

1. Owner can replace the adapter.
2. Contracts are unaudited.
3. Only one pool is used per token pair.
4. Keeper operation has no uptime, alerting, or profitability controls.
5. Mainnet enrollment and protection have not occurred with a consenting live borrower.

### Evidence of new work — good but must be packaged

The Git history shows a clear progression through market research, mainnet deployment, FCC design, Coston2 deployment, hardening, and documentation. The DoraHacks entry should summarize this explicitly rather than expecting judges to reconstruct it from commits.

Suggested statement:

> During Summer Signal we scanned Flare lending markets, measured the FXRP liquidation surface and DEX depth, implemented the policy registry and atomic Morpho/SparkDEX deleveraging path, deployed and verified the contracts on Flare mainnet, built fork and liquidity tests, shipped a reproducible demo and risk dashboard, and prototyped a confidential trigger with Flare Confidential Compute on Coston2.

### Clarity and future potential — strong after packaging

- The one-line product is easy to understand.
- The dashboard establishes urgency before the technical demo.
- The `Protected` event provides a clear transaction receipt.
- Multi-pool routing, governed ownership, hosted keeper operation, and confidential triggers form a credible roadmap.

The biggest clarity risk is presenting Bounty 1 and Bounty 2 as one completed production system. Lead with the complete Bounty 1 product. Present FCC as technically meaningful bonus work and clearly state the current chain split.

## Bounty 1 fit

Ballast fits Interoperable Asset Products directly: it makes FXRP safer and more useful as collateral in Flare DeFi. The product is not a generic EVM application with a Flare deployment; its collateral, lending market, oracle behavior, liquidity measurements, and settlement venue are all Flare-specific.

## Bounty 2 fit

The FCC prototype hides a borrower's precise trigger behind a salted commitment, evaluates the condition inside a TEE, and verifies that the returned verdict was signed by an attested production machine for the expected extension.

Current limitations that must remain explicit:

- FCC infrastructure is on Coston2 while the production lending/liquidity path is on Flare mainnet.
- The current FCC machine is freshly registered and PRODUCTION on the redeployed manager, but no private borrower enrollment and end-to-end confidential evaluation evidence is published yet.
- The current work proves confidential evaluation and verdict verification, not direct cross-network mainnet deleveraging.

Recommendation: submit primarily to Bounty 1 unless a fresh private enrollment and complete confidential evaluation demo are captured before the deadline.

## Demo readiness

Recommended three-minute sequence:

1. State the user loss: liquidation penalty versus bounded swap cost.
2. Show the dashboard's measured positions and drawdown exposure.
3. Run `./demo.sh` and explain each printed number.
4. Show the position health before and after protection.
5. Show that Ballast ends with zero FXRP and USD₮0 balances.
6. Show the verified mainnet contracts and the keeper dry run.
7. End with limitations and the multi-pool/confidential roadmap.

Do not spend demo time on every contract or every FCC infrastructure component. Judges need the user problem, Flare dependency, working transaction, safety bounds, and evidence first.

## Priority backlog

### Submission critical

1. Record and publish the demo video.
2. Add the hosted dashboard URL to the README and DoraHacks entry.
3. Write the exact before/during-hackathon work statement.
4. Collect and document external user feedback.
5. Confirm all DoraHacks fields, deadline timezone, team details, and bounty selection in the logged-in submission flow.

### High impact product work

1. Add a borrower enrollment UI for Morpho authorization and `setPolicy`.
2. Add keeper alerts, persistent state, gas/profit checks, and retry behavior.
3. Add multi-pool routing for stressed FXRP liquidity.
4. Move owner powers to a timelock or constrained governance mechanism.

### FCC completion

1. Obtain current official indexer access/configuration.
2. Provision a stable public proxy hostname.
3. Register a fresh extension and production machine.
4. Generate a private policy salt and encrypt enrollment to that machine.
5. Capture a complete Coston2 enrollment/evaluation/verdict demo.

## Current recommendation

Freeze the core Bounty 1 contracts unless a defect is found. Spend remaining time on enrollment UX, the demo video, live evidence, and submission clarity. The current implementation already demonstrates more technical depth than most hackathon prototypes; the best path to a higher score is making that depth immediately verifiable to judges.
