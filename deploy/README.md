# Deuz SDK docs — AWS deployment

The docs site (`../docs`, Next.js 16 + Fumadocs) runs on a single EC2 instance with
CloudFront in front. Everything here is checked in so the stack can be rebuilt from scratch.

## Current state

| | |
|---|---|
| AWS account | `672850355747`, CLI profile `deuz` |
| Region | `eu-central-1` (Frankfurt) |
| Instance | `i-0a61709c172e30e60` — t4g.small (2 vCPU ARM Graviton, 2 GB + 2 GB swap) |
| Elastic IP | `3.77.16.98` |
| Security group | `sg-05c0e3628c7475a00` |
| App directory | `/opt/deuz/current`, systemd unit `deuz-docs` |
| SSH | `ssh -i ~/.ssh/deuz-docs.pem ec2-user@3.77.16.98` |
| CloudFront | **not created yet** — the account is pending Support verification |

## Deploying

```powershell
powershell -File deploy\deploy.ps1
```

It tars `docs/` (excluding `node_modules`, `.next`, `.source`), uploads it, then runs
`redeploy.sh` on the server: extract to a staging directory, reuse `node_modules` when
`package-lock.json` is unchanged, build, swap directories, health-check `/docs`. If the
health check fails it restores the previous directory and exits non-zero, so a broken
build never stays live.

The site is deployed from the **working tree**, not from git. The live content lives on
the unpushed `docs/ink-redesign` branch — cloning the repo on the server would ship an
older `main`.

## CloudFront

`dist.json` is a ready-to-apply distribution config; the cache policies and the viewer
function it references already exist in the account:

| Resource | ID |
|---|---|
| Cache policy `deuz-docs-pages` | `2afc8714-fccf-4619-843e-42bfcc080ba4` |
| Cache policy `deuz-docs-og` | `0d386266-322c-4bee-be57-4e6db4cca6c4` |
| Cache policy `deuz-docs-search` | `4d40bf31-b1b5-4fbc-bf26-c608dabf4c81` |
| Function `deuz-docs-normalize` | published to LIVE |

Once Support verifies the account:

```powershell
aws cloudfront create-distribution --profile deuz --distribution-config file://deploy/dist.json
```

then put the distribution ID into `$DIST` in `deploy.ps1` so deploys invalidate the cache.

### Why the cache key is what it is

CloudFront ignores `Vary`, and this app returns **different bodies at the same URL**:

- `proxy.ts` serves `text/markdown` when `Accept` mentions `text/markdown` (verified: the
  check is presence, not q-value — `text/html;q=0.9,text/markdown;q=0.8` still returns
  markdown). Without `accept` in the cache key, one crawler's markdown request would be
  served to every subsequent browser.
- The App Router returns an RSC flight payload when `RSC: 1` is set.

`normalize.js` runs as a viewer-request function and collapses `Accept` to exactly
`text/markdown` or `text/html` and pins `RSC` to `1`, so the cache key has at most four
states per URL instead of one per distinct browser `Accept` string.

`next-router-state-tree`, `next-router-prefetch` and `next-router-segment-prefetch` appear
in Next's `Vary` header but were measured to make **no** difference to the response — all
834 pages are prerendered — so they are deliberately left out of the cache key. If pages
ever become dynamically rendered, re-check this before trusting the cache.

Origin `Cache-Control` is `s-maxage=31536000` on HTML, so deploys must invalidate `/*`.
OG images and the sitemap come back as `max-age=0`; the `/og/*` behaviour overrides that
with a 7-day `MinTTL`.

## Files

| File | Purpose |
|---|---|
| `deploy.ps1` | run this — packages, uploads, triggers a rebuild, invalidates CloudFront |
| `redeploy.sh` | server side of a deploy, with health check and rollback |
| `user-data.sh` | EC2 bootstrap: swap, Node 22 (arm64), systemd unit |
| `dist.json` | CloudFront distribution config |
| `normalize.js` | CloudFront viewer-request function (cache-key normalisation) |
| `cp-*.json` | the three cache policies |

## Security notes

- Port 80 and 443 are currently open to `0.0.0.0/0` so the site is reachable without
  CloudFront. Once the distribution exists, drop the `0.0.0.0/0` rules — the group already
  allows port 80 from the `com.amazonaws.global.cloudfront.origin-facing` prefix list
  (`pl-a3a144ca`), which is the only origin access CloudFront needs.
- CloudFront talks to the origin over plain HTTP. Once `deuz-sdk.tech` resolves, give the
  origin its own hostname and certificate and switch the distribution to `https-only`.
- The instance runs no AWS credentials and the docs app reads **no** runtime environment
  variables, so nothing secret lives on the server.
