# Ballast enrollment app

Static borrower-facing enrollment UI for Ballast's Morpho protection policy. It uses `viem` and the existing project manager configuration.

## Run

```sh
npm install
npm run check
npm run build
npm run dev
```

Local builds target the finalized Flare mainnet V3 manager and hosted keeper, but remain
read-only unless `VITE_ENABLE_ENROLLMENT_WRITES=true` is set. Production releases must run:

```sh
VITE_ENABLE_ENROLLMENT_WRITES=true npm run build
npm run verify:production
```

`verify:production` rejects a bundle containing the legacy manager, the wrong ABI version,
disabled writes, or the wrong hosted keeper address.

V3 requires a nonzero keeper address in every policy. Use a dedicated keeper operator and do not
reuse the owner or guardian identity. The published app prefills the hosted operator
`0xA20a59090f609329405F5DcA785Af9357F6965E7`, which remains dry-run until a controlled live
protection receipt succeeds.

The form defaults are deliberately conservative for the controlled beta: trigger `1.15`, target
`1.30`, `100 FXRP` per-action cap, and `1%` slippage. Borrowers must authorize Morpho before the
UI enables policy submission, and the summary warns when a policy would be actionable immediately.

Public app: https://ballast-enrollment.vercel.app
