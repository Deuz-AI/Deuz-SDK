# Deuz SDK docs — AWS deployment

The docs site (`../docs`, Next.js 16 + Fumadocs) runs on a single EC2 instance with
CloudFront in front. Everything here is checked in so the stack can be rebuilt from scratch.

## Current state

Checked on the live server on 2026-11-24.

| | |
|---|---|
| Region | `eu-central-1` (Frankfurt) |
| Instance | `i-01e6a3a3d56a037a4` (`deuz-docs`), t4g.medium (ARM Graviton, 4 GB) |
| Public IP | `18.199.24.25`; `deuz-sdk.tech` resolves to it |
| Security group | `sg-0077849369698a6c8`: 80 and 443 open, 22 from one admin IP only |
| App directory | `/opt/deuz/current`, systemd unit `deuz-docs` (Next.js on `127.0.0.1:3000`) |
| Front | Caddy on 80 and 443 terminates TLS and proxies to the app; plain HTTP is redirected (308) |
| SSH | `ssh -i ~/.ssh/deuz-docs.pem ec2-user@18.199.24.25`, from the admin IP |
| CloudFront | not in front of the site: responses come `Via: Caddy` |

`user-data.sh`, `dist.json`, `normalize.js` and the `cp-*.json` policies describe the first
server (Next.js on port 80, CloudFront planned). The live server was set up by hand after
that, with Caddy in front; its Caddy configuration is not in this directory.

## Deploying

There is no local wrapper script: a deploy is three commands from the repository root
(`tar`, `scp` and `ssh` ship with Windows 10 and later as well as Linux and macOS):

```sh
tar --exclude=node_modules --exclude=.next --exclude=.source -czf deuz-docs.tar.gz -C docs .
scp -i ~/.ssh/deuz-docs.pem deuz-docs.tar.gz deploy/redeploy.sh ec2-user@18.199.24.25:/tmp/
ssh -i ~/.ssh/deuz-docs.pem ec2-user@18.199.24.25 bash /tmp/redeploy.sh
```

`redeploy.sh` expects the tarball at `/tmp/deuz-docs.tar.gz`, with the contents of
`docs/` at its root. It extracts it to a staging directory, reuses `node_modules` when
`package-lock.json` is unchanged, builds, swaps directories and health-checks `/docs`, first
on the app's own port (`127.0.0.1:3000`), then on port 80. If the health check fails it
restores the previous directory and exits non-zero, so a broken build never stays live.

The server never clones the repository: it builds whatever `docs/` you upload. Deploy from
a checkout of the `main` branch. The redesign branch the site was first deployed from is
merged into it, so `main` is where the current docs live.

## Deploying without the SSH key

Port 22 is open to one admin IP only. From anywhere else, use EC2 Instance Connect in the
AWS console:

1. Add a temporary inbound rule to the security group: TCP 22 from the prefix list
   `com.amazonaws.eu-central-1.ec2-instance-connect`.
2. Open the instance, choose Connect, then EC2 Instance Connect (user `ec2-user`).
3. In the browser terminal, build the tarball from `main` on the server and run the script:

   ```sh
   cd /tmp && curl -fsSL https://github.com/Deuz-AI/Deuz-SDK/archive/refs/heads/main.tar.gz -o repo.tar.gz
   mkdir deuz-src && tar -xzf repo.tar.gz -C deuz-src --strip-components=1
   tar -czf /tmp/deuz-docs.tar.gz -C deuz-src/docs .
   nohup bash deuz-src/deploy/redeploy.sh > /tmp/redeploy.log 2>&1 &
   tail -f /tmp/redeploy.log
   ```

   `nohup` keeps the deploy running if the browser session drops. The build takes about
   four minutes on this instance.
4. Remove `/tmp/deuz-src`, `/tmp/repo.tar.gz` and `/tmp/deuz-docs.tar.gz`, then delete the
   temporary rule.

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

then invalidate the cache after every deploy (see below for why `/*`):

```powershell
aws cloudfront create-invalidation --profile deuz --distribution-id <DIST> --paths "/*"
```

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
| `redeploy.sh` | server side of a deploy (upload it with the tarball), with health check and rollback |
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
