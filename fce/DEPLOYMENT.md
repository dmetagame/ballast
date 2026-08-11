# Ballast Coston2 Deployment

The hardened Ballast FCC implementation is ready for a fresh Coston2 deployment. The actual
registration requires external Flare infrastructure credentials and a stable public callback.

## Public Configuration

```text
CHAIN_URL=https://coston2-api.flare.network/ext/C/rpc
CHAIN_ID=114
TEE_NODE_MINIMUM=v0.0.24
FLARE_TEE_MANAGER=0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE
SIMULATED_TEE=true
```

Do not use the old `0x004224fa...5d41F` FCC deployment.

## Required Private Inputs

Keep these outside Git and out of logs:

- Funded Coston2 deployment key
- Separate proxy-signing key
- Official Flare Coston2 indexer DB host, database, username, and password
- Stable HTTPS extension-proxy hostname from a named Cloudflare Tunnel or reserved ngrok domain

Copy the proxy example and fill the ignored file with the current official indexer values:

```bash
cp config/proxy/extension_proxy.coston2.docker.toml.example \
  config/proxy/extension_proxy.coston2.docker.toml
```

## Deployment Sequence

```bash
./scripts/check-versions.sh
./scripts/pre-build.sh
./scripts/start-services.sh --chain coston2
./scripts/post-build.sh
```

`post-build.sh` must use `register-tee -command rRap`. Quick-tunnel hostnames are unsuitable:
the URL is stored on-chain and becomes invalid when the tunnel restarts.

## Fresh Policy

Generate a random salt outside the repository and compute:

```text
keccak256(abi.encode(triggerHealth, targetHealth, salt))
```

Pass only the commitment hash to `DeployCoston2Ballast.s.sol` through `POLICY_COMMITMENT`.
Encrypt the complete policy to the selected PRODUCTION machine public key, then call:

```text
enroll(teeId, marketId, commitment, ciphertext)
```

The sender pins subsequent evaluations to that machine and rejects stale or repeated blocks.

## Current Status

Fresh FCC registration completed on August 9, 2026 against the live Coston2 deployment and is
now hosted on the always-on AWS VPS:

```text
EXTENSION_ID=0x0000000000000000000000000000000000000000000000000000000000010246
INSTRUCTION_SENDER=0xe430Da1C7836e496013A6ba96F9F88632a35EAc6
TEE_ID=0xd56b33B50F76E126616d9545E3469De45415d152
EXT_PROXY_URL=https://ballast.rouma.online
```

Registration used the current scaffold, `tee-node v0.0.24`, `tee-proxy v0.0.18`,
`SIMULATED_TEE=true`, and `register-tee -command rRap`. The live manager returns status
`2 = PRODUCTION`, and its stored machine URL matches the stable VPS hostname exactly.

The FCC service is still a simulated TEE on Coston2 and is not an uptime-guaranteed service.
On-chain status alone is insufficient: run `../scripts/verify-fcc-production.sh` to check both
the manager record and the public `/info` endpoint. A private borrower enrollment and complete
confidential evaluation demo remain separate evidence tasks.
