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

## For AI agents

Claude or any other agent can drive fruity-pi over its REST API:

1. Create a token: **System → API tokens**, or `fruity-pi token create my-agent`.
2. Give the agent `FRUITY_PI_URL` and `FRUITY_PI_TOKEN`.
3. Point it at [`AGENTS.md`](AGENTS.md), or install the skill: `cp -r skills/fruity-pi ~/.claude/skills/`. The skill includes `fpi`, a bash + curl client.

Full reference: [`docs/API.md`](docs/API.md). A running server also describes itself at `GET /api/agent`.

```bash
fpi ask cluster:reviewers "Review src/auth for injection bugs"   # prompt a whole cluster and wait for every answer
```

Tokens are hashed at rest, can be read-only or expiring, and are audit-logged by name. They can never open the shell, read secrets, change security settings or create more tokens.

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

### Getting to the dashboard from your laptop

fruity-pi and all agents run on the server; your laptop only runs a browser. The server listens on `127.0.0.1` only, so you reach it through an SSH tunnel:

```bash
ssh -N -L 7777:127.0.0.1:7777 you@your-vm   # then open http://localhost:7777
```

`-L 7777:127.0.0.1:7777` means: open port 7777 on my laptop and forward it, encrypted, to `127.0.0.1:7777` as seen from the VM. Nothing new is exposed to the internet. To make it permanent, add it to `~/.ssh/config`:

```
Host pi-vm
  HostName 203.0.113.10
  User you
  LocalForward 7777 127.0.0.1:7777
```

## Run in a container (Docker / Podman)

The image runs the dashboard, the supervisor and every pi instance inside one container, as the unprivileged `node` user. Instances are isolated from each other in the usual way (their own home folders), and the whole fleet is isolated from the host.

```bash
git clone https://github.com/mikensec/fruity-pi.git && cd fruity-pi
mkdir -p work                                   # optional: code the agents can work on, mounted at /work
docker compose up -d --build
docker compose logs fruity-pi | grep "setup token"
```

Open http://localhost:7777 (over the SSH tunnel if the host is remote), enter the setup token and choose an admin password. Then follow the setup checklist.

Without compose:

```bash
docker build -t fruity-pi .
docker run -d --name fruity-pi --restart unless-stopped \
  -p 127.0.0.1:7777:7777 \
  -v fruity-pi:/home/node/.fruity-pi \
  -v "$PWD/work:/work" \
  fruity-pi
```

Useful commands:

```bash
docker compose exec fruity-pi fruity-pi ls                    # CLI inside the container
docker compose exec fruity-pi fruity-pi send all "hello"
docker compose exec -e FRUITY_PI_PASSWORD='new-long-password' fruity-pi fruity-pi set-password
git pull && docker compose up -d --build                      # upgrade; state lives in the volume
```

Notes:

- **Keep the port on loopback.** Publish it as `127.0.0.1:7777:7777`, never `7777:7777`. In container mode (`FRUITY_PI_CONTAINER=1`, set in the image) the server listens on 0.0.0.0 *inside* the container without TLS, so the publish rule is what keeps it private. To expose it wider, put a TLS reverse proxy in front.
- **Working on code.** Mount repos under `/work` and point deployments at them (`cwd: /work/my-app`, optionally `worktree: true`). A bind-mounted `./work` must be writable by uid 1000 (`mkdir -p work` as a normal user does that).
- **Upgrading pi.** The pi version is pinned by `package-lock.json` and baked into the image. Bump it with `npm install @earendil-works/pi-coding-agent@latest` and rebuild. The in-app **Install / upgrade pi** button works too, but the change is lost when the container is recreated.
- **More tools for the agents.** The image ships with git, ripgrep, jq, python3 and curl. Add your own stack in a derived image (`FROM fruity-pi` then `USER root`, `apt-get install …`, `USER node`).
- **Git access.** Mount credentials read-only if agents need private repos, e.g. `-v ~/.ssh:/home/node/.ssh:ro` or a `~/.gitconfig` with a credential helper.
- **Podman** works the same way: `podman compose up -d --build` or `podman run …` with the same flags.
- **One container for the whole fleet.** Running each pi instance in its own container isn't supported yet.

## AWS EC2 + Amazon Bedrock

Yes, this works. pi has a built-in `amazon-bedrock` provider, and fruity-pi can use the EC2 instance's IAM role, so there are no keys to store.

**1. IAM role for the instance.** Attach a role (instance profile) with at least:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    "Resource": [
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:*:*:inference-profile/*"
    ]
  }]
}
```

Also enable access to the models you want in the Bedrock console (**Model access**), in each region you'll call.

**2. Launch and install.** Amazon Linux 2023 or Ubuntu 24.04 both work. The security group only needs inbound SSH, or nothing at all if you use SSM (see step 4).

```bash
git clone https://github.com/mikensec/fruity-pi.git && cd fruity-pi && ./install.sh
```

**3. Tell fruity-pi to use the instance role.** In **System → Secrets & API keys**, add:

| variable | value |
|---|---|
| `AWS_REGION` | e.g. `us-east-1` |
| `FRUITY_PI_AWS_INSTANCE_ROLE` | `1` |

Then give your profile a Bedrock model, e.g. `amazon-bedrock/us.anthropic.claude-sonnet-5`. The `us.` / `eu.` / `apac.` / `global.` prefixes are cross-region inference profiles. To list what's available, open a shell into an instance and run `pi --list-models bedrock`. Restart or roll out the instances so they pick up the new settings.

Why the setting is needed: pi only switches Bedrock on when it sees AWS credentials in the environment, and a bare instance role doesn't count. With `FRUITY_PI_AWS_INSTANCE_ROLE=1`, fruity-pi gives each instance a generated AWS profile that sets only the region. That switches Bedrock on, and the AWS SDK then fetches credentials from the instance role via the EC2 metadata service (IMDS).

**4. Connect** with the SSH tunnel above, or with **SSM Session Manager**, which needs no inbound ports at all:

```bash
aws ssm start-session --target i-0123456789abcdef0 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["7777"],"localPortNumber":["7777"]}'
# then open http://localhost:7777
```

**Other ways to authenticate to Bedrock:**

| method | set in System → Secrets (or the host environment) |
|---|---|
| Bedrock API key | `AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION` |
| IAM user keys | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`), `AWS_REGION` |
| Named profile | `AWS_PROFILE`, `AWS_REGION`. Your real `~/.aws/config` and `~/.aws/credentials` are passed through to instances even though each instance has its own HOME. |
| ECS task role / EKS IRSA | picked up automatically from `AWS_CONTAINER_CREDENTIALS_*` / `AWS_WEB_IDENTITY_TOKEN_FILE` |

**Bedrock + Docker on EC2.** For containers to reach the instance role, raise the IMDSv2 hop limit to 2. The default of 1 blocks containers on the bridge network.

```bash
aws ec2 modify-instance-metadata-options --instance-id i-0123456789abcdef0 \
  --http-endpoint enabled --http-tokens required --http-put-response-hop-limit 2
AWS_REGION=us-east-1 FRUITY_PI_AWS_INSTANCE_ROLE=1 docker compose up -d --build
```

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

Only a short allowlist of host variables passes through (`PATH`, locale, `TERM`, `SSH_AUTH_SOCK`, proxies, and AWS region/profile/role variables for Bedrock). Secrets from **System → Secrets** are injected. `GIT_CONFIG_GLOBAL` points at your real `~/.gitconfig` so agents can use your git identity and credential helpers.

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
