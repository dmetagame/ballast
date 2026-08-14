# Always-on FCC and keeper host

Ballast's Coston2 FCC machine and the Flare mainnet keeper run on an always-on AWS host. The
FCC proxy uses the stable `ballast.rouma.online` hostname; the keeper remains in dry-run mode
until a controlled borrower enrollment and protection receipt are verified.

## Current keeper deployment

- Host: AWS, Europe (Stockholm)
- Manager: `0x746066ACe5dc89a3692137b8cdE3c31328629d09`
- Keeper: `0xA20a59090f609329405F5DcA785Af9357F6965E7`
- Start block: `67019411`
- Discovery: Blockscout bootstrap plus confirmed 30-block RPC pages with persistent checkpointing
- Mode: continuous dry-run, `EXECUTE=false`
- Service state verified August 13, 2026: active, zero restarts; confirm the deployed commit during each release
- Execution bounds: gas ceiling, minimum fee, loan-token/FLR conversion, and minimum profit set

The protected key may be loaded during dry-run so the service can reject policies naming a
different keeper without broadcasting transactions.

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

## Static product surfaces

The same Caddy site serves immutable static releases without taking over the FCC API routes:

- `/product/` serves the landing surface.
- `/risk/` serves the generated risk dashboard.
- `/enroll/` serves the V3 borrower control panel.
- Every other path, including `/info`, continues to proxy to the FCC service on `127.0.0.1:6674`.

`scripts/deploy-static-aws.sh` builds and verifies all three surfaces, refuses a dirty release by
default, records the exact Git commit in each `release.json`, atomically switches the current
release symlink, reloads Caddy, and restores the previous release and Caddy configuration if
activation or public verification fails. Run it only from a committed release:

```bash
./scripts/deploy-static-aws.sh
./scripts/verify-static-production.sh
```

Deploy the keeper code and health monitor from the same committed release:

```bash
./scripts/deploy-keeper-aws.sh
systemctl --user status ballast-keeper --no-pager
systemctl --user status ballast-keeper-health.timer --no-pager
systemctl --user start ballast-keeper-health.service
```

The runtime deployment rejects a dirty or unpushed release, installs locked monitor dependencies
into an immutable release directory, and restores the previous keeper symlink if activation or the
immediate health check fails. Run it alone only when the hosted static `release.json` files already
expose the same commit. Keep `EXECUTE=false` until the controlled protection receipt is independently
verified. For a full release, use `scripts/activate-production.sh`; it also restores the previous
static release if the keeper cannot advance to the same commit.

The Caddy configuration adds HSTS, clickjacking protection, MIME sniffing protection, a restrained
referrer policy, and disables unused camera, microphone, and geolocation permissions.

## Current Coston2 deployment

The always-on FCC is registered against the live Coston2 `FlareTeeManager` at
`0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`:

- Extension ID: `0x0000000000000000000000000000000000000000000000000000000000010246`
- TEE ID: `0xd56b33B50F76E126616d9545E3469De45415d152`
- Stable proxy: `https://ballast.rouma.online`
- TEE node/proxy: `v0.0.24` / `v0.0.18`
- Mode: `SIMULATED_TEE=true` on Coston2, status `2` (`PRODUCTION`)

Verify this state with `./scripts/verify-fcc-production.sh`. The script accepts
`TEE_ID`, `EXTENSION_ID`, and `EXT_PROXY_URL` overrides when rotating the host.

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

## Service installation

The production Compose override adds health checks and `unless-stopped` restart policies. The
installer also keeps the FCC environment at mode `0600` and grants only the proxy container's
numeric group (`1001`) read access to the private proxy configuration.

```bash
cd ~/ballast
./scripts/install-fcc-service.sh
sudo systemctl enable --now "ballast-fcc@$USER.service"
sudo systemctl status "ballast-fcc@$USER.service" --no-pager
```

The service combines the scaffold's base and Coston2 Compose files with
`deploy/fcc/docker-compose.production.yaml`. It waits for Redis and the proxy's internal
liveness endpoint before starting the extension TEE. The external `/info` endpoint depends on
the TEE startup handshake, so it must not be used as the TEE dependency health check.

## Incident response

If the health timer fails, inspect the structured result and services before changing any chain
configuration:

```bash
systemctl --user status ballast-keeper --no-pager
systemctl --user status ballast-keeper-health.service --no-pager
journalctl --user -u ballast-keeper -u ballast-keeper-health.service --since '30 minutes ago' --no-pager
```

Do not enable execution while a health check is failing. For a runtime or dependency problem,
redeploy the intended committed release with `scripts/deploy-keeper-aws.sh`; it refuses a dirty or
unpushed release and rolls back on activation failure. For an FCC failure, verify `/info`, the onchain TEE
URL, and status `2` before rotating a registration.

Keep the proxy ports bound to loopback when Caddy or another host reverse proxy terminates
HTTPS:

```text
EXT_PROXY_INTERNAL_BIND=127.0.0.1:6673
EXT_PROXY_EXTERNAL_BIND=127.0.0.1:6674
```

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
