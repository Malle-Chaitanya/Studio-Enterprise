# CI/CD — GitHub Actions over SSH

Two workflows:

| Workflow | File | Trigger | What it does |
|----------|------|---------|--------------|
| CI | [.github/workflows/ci.yml](../.github/workflows/ci.yml) | push to `main`/`develop`/`business`, PRs to `main`/`develop` | `npm ci` + `typecheck` + `test` (vitest) + `build` for `server/` and `web/` in parallel jobs |
| Deploy | [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) | push to `main`, or manual **Run workflow** | builds both apps in CI, rsyncs the output to the host over SSH, `npm ci --omit=dev`, restarts systemd, reloads nginx, smoke-tests `/api/health` |

Nothing is built on the host — CI ships `server/dist` + `web/dist`, so the host needs
only Node 20, nginx, and production dependencies.

## Host layout

Settled on 2026-08-13: no dedicated service user — the API runs as `laxman`, the same
account the deploy SSHes in as. Everything under `/data/studio-ent`. Hostname is
`studioent.cftools.live` (A record verified → `208.70.248.68`).

```
/data/studio-ent/.env            <- SECRETS, host-only, never deployed, never in git.
                                    Deliberately OUTSIDE both rsync targets so a sync
                                    with --delete can never remove it.
/data/studio-ent/server/dist/    <- rsync target (API build)      = SERVER_DIR
/data/studio-ent/server/package.json
/data/studio-ent/server/node_modules/  <- `npm ci --omit=dev` on the host
/data/studio-ent/web/            <- rsync target (SPA build), nginx root = WEB_DIR
```

nginx serves the SPA, proxies `/api/` **and `/callback/`** → `127.0.0.1:8083`; systemd
runs the API. The `/callback/` block is not optional: `server.ts:56` mounts the OAuth
callbacks at the root, so without it the SPA catch-all answers them with `index.html`
and both sign-ins dead-end.

## One-time host setup

The full runbook, with the failure modes, is [DEPLOY-MANUAL.md](DEPLOY-MANUAL.md) — do
that by hand once before the first automated deploy. Summary, as root:

```bash
# 1. directories — rsync runs as laxman and cannot write a root-owned dir
mkdir -p /data/studio-ent/server /data/studio-ent/web
chown -R laxman:laxman /data/studio-ent

# 2. secrets — copy server/.env.example, fill it in, lock it down. 600, not 644:
#    this host also runs 40+ other projects.
chmod 600 /data/studio-ent/.env
chown laxman:laxman /data/studio-ent/.env

# 3. Node — the host has v24.16.0 while both workflows pin 20. Pick one.
apt-get install -y nginx rsync

# 4. systemd unit
cp deploy/csge-server.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now csge-server

# 5. nginx — validate before reloading; 41 other sites share this nginx
cp deploy/nginx-csge.conf /etc/nginx/sites-available/csge
ln -sf /etc/nginx/sites-available/csge /etc/nginx/sites-enabled/csge
nginx -t && systemctl reload nginx

# 6. TLS — after the site answers on port 80
certbot --nginx -d studioent.cftools.live
```

`.env` must also carry `WEB_ORIGIN`, `MS_REDIRECT_URI` and `GOOGLE_REDIRECT_URI` for the
real hostname, and both redirect URIs must be registered verbatim with Azure and Google.
See [DEPLOY-MANUAL.md](DEPLOY-MANUAL.md) → "The three .env values the domain forces".

### Passwordless sudo for exactly four commands

The deploy user (`laxman`) must restart the service and reload nginx without a TTY
password prompt — a CI job has no terminal and cannot answer one. The host's existing
NOPASSWD list is `nginx, certbot, cp, ln`, which does not cover any of these, and its
blanket `(ALL : ALL) ALL` rule demands a password. Grant these four and nothing else:

```
# /etc/sudoers.d/csge-deploy  (edit with `sudo visudo -f /etc/sudoers.d/csge-deploy`)
laxman ALL=(root) NOPASSWD: /bin/systemctl restart csge-server, \
                            /bin/systemctl reload nginx, \
                            /usr/sbin/nginx -t, \
                            /bin/journalctl -u csge-server *
```

Putting the host's root password in a GitHub secret instead would work, but it hands
every workflow run full root on a box serving 41 other production sites. This rule
gives CI exactly the four commands the deploy needs.

## SSH key

Generate a **deploy-only** key pair. It authenticates one GitHub repo to one host — do not
reuse a personal key.

```bash
ssh-keygen -t ed25519 -C "github-actions-csge" -f ~/.ssh/csge_deploy -N ""
```

Public half → host:

```bash
ssh-copy-id -p 63152 -i ~/.ssh/csge_deploy.pub laxman@208.70.248.68
# or append ~/.ssh/csge_deploy.pub to /home/laxman/.ssh/authorized_keys
#
# Already done for this host, and key auth is verified working. Note /home/laxman/.ssh
# is owned root:root there, so appending as laxman fails with "operation not permitted"
# — do it as root, or chown the directory back to laxman:laxman first.
```

Optionally restrict what the key may do in `authorized_keys`:

```
from="140.82.0.0/16",no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA...
```

Private half → GitHub secret (see below). **Never commit `csge_deploy`.**

Get the host key fingerprint for pinning — `-p` is required, the host does not listen on 22:

```bash
ssh-keyscan -p 63152 -H 208.70.248.68
```

## GitHub configuration

Repo → **Settings → Environments → New environment → `production`** (add required
reviewers here if you want a manual approval gate before every deploy).

Secrets (Settings → Secrets and variables → Actions → **Secrets**). All five are
**present and verified** as of 2026-08-13:

| Name | Value |
|------|-------|
| `DEPLOY_SSH_KEY` | full contents of the **private** key `csge_deploy`, including the BEGIN/END lines |
| `DEPLOY_HOST` | `208.70.248.68` |
| `DEPLOY_USER` | `laxman` |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -p 63152 -H 208.70.248.68` — all three lines (ecdsa, ed25519, rsa) |
| `DEPLOY_PORT` | `63152` |

Repo-level secrets are visible to a job with `environment: production`, so they do not
need to be duplicated into the environment. The `production` environment exists with no
protection rules — add required reviewers there if you want a manual gate before each
deploy.

`DEPLOY_PORT` is read as `secrets.DEPLOY_PORT || vars.DEPLOY_PORT || 22`. It is not
sensitive and a variable is its natural home, but reading only `vars` meant a port added
as a secret — the obvious place, beside the other four `DEPLOY_*` values — resolved to
empty and silently fell back to 22, failing at connect with a timeout that says nothing
about the real cause. Either location works now.

`DEPLOY_KNOWN_HOSTS` is pinned deliberately — `StrictHostKeyChecking yes` means a
changed or spoofed host key fails the deploy instead of silently trusting it. Note
`ssh-keyscan` needs `-p 63152`; without it you scan port 22 and get nothing.

## Verifying

```bash
# CI only, no deploy
git push origin develop

# full deploy
git push origin main
# or: Actions -> Deploy -> Run workflow
```

The deploy fails loudly if the service does not come up (it dumps the last 50 journal
lines) or if `/api/health` does not return a `status` field.

## Rollback

```bash
git revert <bad-commit> && git push origin main    # re-deploys the previous build
```

Or on the host: `sudo systemctl stop csge-server`, restore a previous `dist/`, start again.
There is no automatic release-versioned directory yet — rsync overwrites in place.

## What is deliberately NOT in these workflows

- **No secrets in the deploy.** `.env` is excluded from rsync; the host owns it. If a config
  value changes, edit it on the host (or Secret Manager) and restart.
- **No Mongo migration step.** Collections and indexes are created idempotently at boot in
  `server/src/db/mongo.ts`.
- **No `npm run build` on the host.** devDependencies never land in production.
