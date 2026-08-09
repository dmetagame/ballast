# Ballast enrollment app

Static borrower-facing enrollment UI for Ballast's Morpho protection policy. It uses `viem` and the existing project manager configuration.

## Run

```sh
npm install
npm run check
npm run build
npm run dev
```

The published Flare mainnet manager is read-only by default. To enable enrollment writes, deploy
and finalize the hardened V3 manager first, then configure `VITE_BALLAST_MANAGER`,
`VITE_ENABLE_ENROLLMENT_WRITES=true`, and `VITE_MANAGER_VERSION=v3` before building.

V3 requires a nonzero keeper address in every policy. Use a dedicated keeper operator and do not
reuse the owner or guardian identity.
