# Always-on FCC and keeper host

Ballast's Coston2 FCC machine and the Flare mainnet keeper should run on an always-on host
before production use. The current workstation-backed FCC registration is valid for judging,
but its URL is unavailable whenever the workstation, WSL, Docker, or Tailscale stops.

## Recommended host

- Ubuntu 24.04 LTS
- 4 vCPU, 8 GB RAM, 60 GB SSD
- Static public IPv4
- Outbound HTTPS and database access
- Inbound SSH (`22`) and HTTPS (`443`)

## Stable HTTPS

Prefer a DNS name managed by the operator, for example `fcc.example.com`, with an `A` record
pointing at the VPS. Put Caddy or another ACME-capable reverse proxy in front of the FCC
external proxy on port `6674`. Do not use a quick Cloudflare or ngrok tunnel.

Tailscale Funnel is acceptable for judging if the VPS device remains registered, but a domain
and direct HTTPS endpoint are preferable for operational continuity.

## Migration sequence

1. Create a non-root `deploy` user with SSH-key access and usable `sudo`.
2. Install Docker, Compose, and the required system packages.
3. Copy the rebased scaffold and Ballast repository over SSH; never paste secrets into a shell
   command or commit them.
4. Copy the ignored Coston2 proxy config, deployer key, proxy key, and current policy files with
   mode `0600`.
5. Start the stack and verify local `/info`.
6. Configure the stable HTTPS hostname and verify public `/info`.
7. Run a fresh `pre-build`, because the machine public key and extension registration are host
   specific.
8. Run `post-build.sh` with `SIMULATED_TEE=true` and `register-tee -command rRap`.
9. Confirm `getTeeMachine(teeId)` stores the VPS URL and
   `getTeeMachineStatus(teeId)` returns `2`.
10. Install the Ballast keeper as a systemd service in dry-run mode, then enable execution only
    after a controlled borrower enrollment and simulated transaction pass.

## Required operator inputs

The migration needs only the VPS address, SSH user/key access, and stable hostname. Existing
local secrets can be transferred over the authenticated SSH connection and must not be sent in
chat. The VPS deployer and keeper identities remain separate from the owner and guardian.

## Verification commands

```bash
curl -fsSL https://fcc.example.com/info | jq '.machineData.extensionId'
./scripts/verify-fcc-production.sh
./scripts/verify-production.sh
```
