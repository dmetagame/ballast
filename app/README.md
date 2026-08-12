# Ballast enrollment app

Static borrower-facing enrollment UI for Ballast's Morpho protection policy. It uses `viem` and the existing project manager configuration.

## Run

```sh
npm install
npm run check
npm run build
npm run dev
```

The published app targets the finalized Flare mainnet V3 manager with writes enabled. Configure
`VITE_BALLAST_MANAGER`, `VITE_ENABLE_ENROLLMENT_WRITES=true`, and
`VITE_MANAGER_VERSION=v3` before building another production release.

V3 requires a nonzero keeper address in every policy. Use a dedicated keeper operator and do not
reuse the owner or guardian identity.

Public app: https://ballast-enrollment.vercel.app
