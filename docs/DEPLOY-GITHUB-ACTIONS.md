# CI/CD — GitHub Actions over SSH

Two workflows:

| Workflow | File | Trigger | What it does |
|----------|------|---------|--------------|
| CI | [.github/workflows/ci.yml](../.github/workflows/ci.yml) | push to `main`/`develop`/`business`, PRs to `main`/`develop` | `npm ci` + `typecheck` + `test` (vitest) + `build` for `server/` and `web/` in parallel jobs |
| Deploy | [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) | push to `main`, or manual **Run workflow** | builds both apps in CI, rsyncs the output to the host over SSH, `npm ci --omit=dev`, restarts systemd, reloads nginx, smoke-tests `/api/health` |

Nothing is built on the host — CI ships `server/dist` + `web/dist`, so the host needs
only Node 20, nginx, and production dependencies.

## Host layout

```
/opt/csge/server/dist/          <- rsync target (API build)
/opt/csge/server/package.json   <- rsync target
/opt/csge/server/.env           <- SECRETS, host-only, never deployed, never in git
/opt/csge/server/node_modules/  <- created by `npm ci --omit=dev` on the host
/var/www/csge/                  <- rsync target (SPA build), nginx root
```

nginx serves the SPA and proxies `/api` → `127.0.0.1:8080`; systemd runs the API.

## One-time host setup

```bash
# 1. user + directories
sudo useradd --system --create-home --shell /usr/sbin/nologin csge
sudo mkdir -p /opt/csge/server /var/www/csge
sudo chown -R deploy:deploy /opt/csge /var/www/csge   # deploy = the SSH user

# 2. Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx rsync

# 3. secrets — copy server/.env.example, fill it in, lock it down
sudo -u deploy vi /opt/csge/server/.env
sudo chmod 600 /opt/csge/server/.env
sudo chown csge:csge /opt/csge/server/.env

# 4. systemd unit
sudo cp deploy/csge-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now csge-server

# 5. nginx
sudo cp deploy/nginx-csge.conf /etc/nginx/sites-available/csge
sudo ln -sf /etc/nginx/sites-available/csge /etc/nginx/sites-enabled/csge
sudo nginx -t && sudo systemctl reload nginx

# 6. TLS
sudo certbot --nginx -d csge.example.com
```

The API runs as `csge` but the deploy user writes the files, so `csge` needs read access
to `/opt/csge/server` — `sudo chmod -R a+rX /opt/csge/server` after the first deploy.

### Passwordless sudo for exactly three commands

The deploy user must restart the service and reload nginx without a TTY password prompt.
Grant nothing else:

```
# /etc/sudoers.d/csge-deploy  (edit with `sudo visudo -f /etc/sudoers.d/csge-deploy`)
deploy ALL=(root) NOPASSWD: /bin/systemctl restart csge-server, \
                            /bin/systemctl reload nginx, \
                            /usr/sbin/nginx -t, \
                            /bin/journalctl -u csge-server *
```

## SSH key

Generate a **deploy-only** key pair. It authenticates one GitHub repo to one host — do not
reuse a personal key.

```bash
ssh-keygen -t ed25519 -C "github-actions-csge" -f ~/.ssh/csge_deploy -N ""
```

Public half → host:

```bash
ssh-copy-id -i ~/.ssh/csge_deploy.pub deploy@YOUR_HOST
# or append ~/.ssh/csge_deploy.pub to /home/deploy/.ssh/authorized_keys
```

Optionally restrict what the key may do in `authorized_keys`:

```
from="140.82.0.0/16",no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA...
```

Private half → GitHub secret (see below). **Never commit `csge_deploy`.**

Get the host key fingerprint for pinning:

```bash
ssh-keyscan -H YOUR_HOST
```

## GitHub configuration

Repo → **Settings → Environments → New environment → `production`** (add required
reviewers here if you want a manual approval gate before every deploy).

Secrets (Settings → Secrets and variables → Actions → **Secrets**):

| Name | Value |
|------|-------|
| `DEPLOY_SSH_KEY` | full contents of the **private** key `~/.ssh/csge_deploy`, including the BEGIN/END lines |
| `DEPLOY_HOST` | host name or IP |
| `DEPLOY_USER` | SSH user (e.g. `deploy`) |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -H YOUR_HOST` |

Variable (Settings → Secrets and variables → Actions → **Variables**), optional:

| Name | Value |
|------|-------|
| `DEPLOY_PORT` | SSH port if not `22` |

`DEPLOY_KNOWN_HOSTS` is pinned deliberately — `StrictHostKeyChecking yes` means a
changed or spoofed host key fails the deploy instead of silently trusting it.

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
