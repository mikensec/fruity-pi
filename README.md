# 🍓 fruity-pi

Run a whole orchard of [pi](https://github.com/earendil-works/pi) coding agents on one machine, from a web dashboard.

- **Isolated instances.** Every pi instance gets its own `HOME`, `~/.pi/agent`, packages, skills, sessions and workspace. Nothing leaks between instances or into your real `~/.pi`.
- **Deployments.** Declare `10× reviewers on profile A, 5× writers on profile B` in YAML, preview the plan, and apply. You can scale with +/− buttons. Config changes roll out two at a time and wait for in-flight runs to finish. Sessions continue across restarts.
- **Fan-out commands.** Send a prompt, steer, follow-up, abort, model change and more to `all`, `cluster:x`, `deployment:x`, `profile:x`, globs, or a checkbox selection. Watch every instance stream side by side, then collect the answers and export them as Markdown or JSON.
- **Tracked skill repos.** Point at a GitHub repo of skills or pi packages. fruity-pi keeps one shared checkout and polls for commits, or you can use a GitHub webhook. When a commit lands, it swaps the checkout atomically and rolls every instance that uses the repo onto it. You get history and one-click rollback.
- **Package manager.** Search the pi package catalog, read READMEs, and see what a package contains (skills, extensions, prompts, themes) before installing. Install, update or remove per profile, cluster, deployment, instance or everything. A fleet-wide matrix shows what's installed where, and individual skills and extensions can be switched on or off.
- **Web shell.** A terminal into the VM, or into any instance's isolated environment so `pi` there sees exactly what the instance sees. It's off by default and enabling it asks for your password. Every session is audit-logged.
- **Concurrency cap.** Prompts beyond `maxConcurrent` queue automatically, so 50 instances don't hammer your rate limits.
- **Easy install.** `./install.sh` installs Node if needed, then pi, the build and a systemd user service. The in-browser setup checklist covers the rest.

## Install

```bash
git clone https://github.com/mikensec/fruity-pi.git && cd fruity-pi
./install.sh                      # localhost only (recommended)
```

The installer prints the URL and a one-time admin password. From your laptop:

```bash
ssh -L 7777:127.0.0.1:7777 you@your-vm     # then open http://localhost:7777
```

Options:

| flag | |
|---|---|
| `--port 8080` | change the port |
| `--remote` | listen on `0.0.0.0` over HTTPS with a self-signed cert (firewall it!) |
| `--no-service` | skip the systemd user service; run `fruity-pi serve` yourself |
| `--uninstall [--purge]` | remove the app (and with `--purge`, all state) |

Re-running `install.sh` upgrades in place and keeps your config, password and instances. You can also upgrade pi itself from **System → Install / upgrade pi**. That does a rolling restart onto the new version.

### Development

```bash
npm install
npm run dev            # API + supervisor with reload (http://127.0.0.1:7777; prints a setup token on first run)
npm run dev:web        # Vite UI on :5173, proxied to the API
npm test               # unit tests
npx tsx test/e2e.ts    # full end-to-end run: real pi processes against a fake LLM
```

## Concepts

| | |
|---|---|
| **Profile** | Recipe for an instance: tracked repos, pi packages (with optional resource filters), local skill paths, model, thinking level, tools, `-a/--approve`, system-prompt append, env, custom `models.json` (e.g. Ollama). |
| **Instance** | One long-lived `pi --mode rpc` process with an isolated home under `~/.fruity-pi/instances/<name>/`. |
| **Deployment** | YAML spec of clusters → profiles × replicas (+ optional model override, shared `cwd`, or one `git worktree` per replica). |
| **Tracked repo** | Git repo + branch/tag/sha. Tracked refs auto-update; pinned refs never move. |
| **Selector** | `all`, `cluster:reviewers`, `deployment:eval`, `profile:docs`, `writers-3`, `review*`, comma-separated. |

```yaml
name: skills-eval
groups:
  - cluster: reviewers
    profile: code-review
    replicas: 10
  - cluster: writers
    profile: docs
    replicas: 5
    model: anthropic/claude-sonnet-5-5
  - cluster: fixers
    profile: code-review
    replicas: 3
    cwd: ~/src/app
    worktree: true          # each replica gets its own branch + worktree
```

CLI (it talks to the running server using `~/.fruity-pi/cli.token`):

```bash
fruity-pi ls
fruity-pi apply deploy.yaml          # or: fruity-pi plan deploy.yaml
fruity-pi send cluster:reviewers "Review src/auth for injection bugs"
fruity-pi collect cluster:reviewers
```

## How isolation works

Each instance runs as your user, with this environment:

```
HOME                          ~/.fruity-pi/instances/<name>/home
PI_CODING_AGENT_DIR           …/home/.pi/agent        (settings, packages, models.json, auth)
PI_CODING_AGENT_SESSION_DIR   …/sessions
XDG_*                         inside the instance home
cwd                           …/workspace  (or the cwd / worktree from the deployment)
```

Only a short allowlist of host variables passes through (`PATH`, locale, `TERM`, `SSH_AUTH_SOCK`, proxies). Secrets from **System → Secrets** are injected. `GIT_CONFIG_GLOBAL` points at your real `~/.gitconfig` so agents can use your git identity and credential helpers.

This is **config-level** isolation, not a sandbox. Instances can still read anything your user can. For hard isolation, run fruity-pi under a dedicated user or inside a VM or container.

fruity-pi owns each instance's `settings.json` `packages`/`skills` keys. Remote packages are installed with the real `pi install` in the instance's environment. Tracked repos load as local package paths through a `current` symlink, so N instances share one checkout.

## Security model

- **Loopback only by default.** Binding anything else requires `"allowRemote": true` *and* TLS, or the server refuses to start.
- **Sign-in required for everything.** Passwords are hashed with scrypt, the session cookie is HttpOnly and SameSite=Strict (Secure under TLS), there's a 12 h idle timeout, and failed logins lock out exponentially. TOTP 2FA is optional.
- **CSRF and cross-origin protection.** Every state-changing request needs a CSRF token header, and every request and WebSocket upgrade must pass an Origin check. The CSP allows no inline scripts, and framing is denied.
- **The web shell is off by default.** Enabling it needs your password. It never runs as root. You can hard-lock it off with `"shellLocked": true` in `~/.fruity-pi/config.json`, and optionally record sessions in asciicast format.
- **Secrets stay on the server.** They live in `secrets.env` (mode 600), are never returned by the API, and are redacted from event logs, job logs and the audit log.
- **Audit log.** `~/.fruity-pi/audit.log` records logins, config pushes, deployments, broadcasts, package actions, shell open/close and repo updates.
- **GitHub webhooks** are verified with HMAC-SHA256 using a constant-time compare.
- **Trust.** Anyone who can sign in controls your agents and, if it's enabled, a shell. pi packages and extensions run arbitrary code with your user's permissions, and so do skills that tell the model to run commands. Only install or track repos you trust, and pin third-party repos to a commit.

## Layout

```
~/.fruity-pi/
  config.json  secrets.env  state.db  audit.log  cli.token
  app/                     installed fruity-pi + pi (node_modules)
  instances/<name>/        home/  sessions/  workspace/  logs/{events.jsonl,stderr.log}
  repos/<id>/              mirror.git  <sha>/  current -> <sha>
```
