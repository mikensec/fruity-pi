# 🍓 fruity-pi

Run a whole orchard of [pi](https://github.com/earendil-works/pi) coding agents on one machine, from a web dashboard.

- **Isolated instances.** Every pi instance gets its own `HOME`, `~/.pi/agent`, packages, skills, sessions and workspace. Nothing leaks between instances or into your real `~/.pi`.
- **Deployments.** Declare `10× reviewers on profile A, 5× writers on profile B` in YAML, preview the plan, and apply. You can scale with +/− buttons. Config changes roll out two at a time and wait for in-flight runs to finish. Sessions continue across restarts.
- **Fan-out commands.** Send a prompt, steer, follow-up, abort, model change and more to `all`, `cluster:x`, `deployment:x`, `profile:x`, globs, or a checkbox selection. Watch every instance stream side by side, then collect the answers and export them as Markdown or JSON.
- **Tracked skill repos.** Point at a GitHub repo of skills or pi packages. fruity-pi keeps one shared checkout and polls for commits, or you can use a GitHub webhook. When a commit lands, it swaps the checkout atomically and rolls every instance that uses the repo onto it. You get history and one-click rollback.
- **Package manager.** Search the pi package catalog, read READMEs, and see what a package contains (skills, extensions, prompts, themes) before installing. Install, update or remove per profile, cluster, deployment, instance or everything. A fleet-wide matrix shows what's installed where, and individual skills and extensions can be switched on or off.
- **Web shell.** A terminal into the VM, or into any instance's isolated environment so `pi` there sees exactly what the instance sees. It's off by default and enabling it asks for your password. Every session is audit-logged.
- **Concurrency cap.** Prompts beyond `maxConcurrent` queue automatically, so 50 instances don't hammer your rate limits.
- **Plays nice with your existing pi.** Never touches `~/.pi`. **Import** your pi setup as a profile and continue any past conversation in an instance (copies, read-only).
- **Private repos & packages.** GitHub/GitLab/any-host tokens and `NPM_TOKEN` from secrets, never written to disk.
- **Built-in help.** Every non-obvious setting (worktrees, replicas, scopes, selectors…) has a `?` popover explaining it.
- **Easy install.** `./install.sh` installs Node if needed, then pi, the build and a systemd user service. The in-browser setup checklist covers the rest.

## Screenshots

**Dashboard.** Fan a prompt out to a whole cluster and watch every agent answer side by side.
![Dashboard with a live fan-out to cluster:reviewers](docs/screenshots/dashboard.png)

| | |
|---|---|
| **Deployments.** Declare clusters, preview the plan, apply. Every setting has a `?` help popover. ![Deployment editor with plan preview and help popover](docs/screenshots/deployments.png) | **Instance.** Full transcript with tool calls. Steer, follow up, abort. ![Instance transcript](docs/screenshots/instance.png) |
| **Packages.** Search the pi catalog, look inside, install to any scope. ![Package catalog](docs/screenshots/packages.png) | **Import from pi.** Bring your existing pi setup and conversations over, read-only. ![Import page](docs/screenshots/import.png) |

**Tracked repos.** Skills that auto-update across the fleet.
![Tracked repos](docs/screenshots/repos.png)

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
| `--proxy URL`, `--ca-cert FILE`, `--no-proxy LIST`, `--ca-system` | corporate proxy / TLS inspection, see [below](#behind-a-corporate-proxy-with-tls-inspection) |
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

## Works alongside your existing pi

fruity-pi **never touches your own pi**:

- Every instance runs with its own `HOME` and `PI_CODING_AGENT_DIR` under `~/.fruity-pi/instances/<name>/`, so its settings, packages, skills, logins and sessions all live there. Your `~/.pi/agent` and `~/.agents` are never read by instances or written to.
- fruity-pi ships its own copy of pi (in `~/.fruity-pi/app`). An existing global `pi` install, and its version, are left alone.
- You can keep running plain `pi` in a terminal while fruity-pi runs, including on the same machine and account.
- The only things shared, read-only, are the conveniences you'd expect: your git identity/credential helpers (`~/.gitconfig`), `~/.aws`, `~/.npmrc` and your SSH keys, so agents can reach the same private repos and clouds you can.

One thing to watch: if you point an instance's working directory at a project you're also editing with your own pi (or by hand), both will edit the same files. Use a private workspace or `worktree: true` for parallel work.

The end-to-end test checks this directly. It creates a real stand-alone pi install with a conversation, imports it, runs and deletes instances, and asserts that every file of the original is byte-for-byte unchanged.

## Import from an existing pi

**Import from pi** in the sidebar scans `~/.pi/agent` (or any pi agent dir you point it at):

- **Your pi setup → profile.** Skills (`~/.pi/agent/skills`, `~/.agents/skills`), extensions, prompt templates, `AGENTS.md`, `models.json`, packages and your default model/thinking level are **snapshotted** into `~/.fruity-pi/imports/<profile>/`. A profile is created that uses the snapshot, so later edits to your own pi don't change your agents, and vice versa. Logins in `auth.json` are not copied; add provider keys in **System → Secrets**.
- **Sessions → instances.** Every past conversation is listed with its project folder and first prompt. **Import** copies the session file into a new instance and starts it, and the agent continues exactly where you left off. You choose the working directory: the session's **original project folder** (to keep working on those files), or a **private workspace** (the conversation, without access to the files).

Your original session file stays where it is and remains usable with plain `pi --resume`.

## Private repos & packages

Tracked repos, `git:` packages and `npm:` packages can be private. There are two ways to give fruity-pi access:

1. **Tokens in System → Secrets** (recommended; works headless, on EC2 and in containers):

   | secret | used for |
   |---|---|
   | `GITHUB_TOKEN` (or `GH_TOKEN`) | `https://github.com/...`: a fine-grained or classic PAT with read access (Contents: read) |
   | `GITLAB_TOKEN` | `https://gitlab.com/...` |
   | `FRUITY_PI_GIT_TOKENS` | any other host: `git.corp.com=TOKEN,https://bitbucket.org=user:app-password,http://10.0.0.5:3000=TOKEN` |
   | `NPM_TOKEN` | private/scoped packages on registry.npmjs.org |

   Git receives the token through an environment-only credential helper, so it's **never written to disk** (not into `.git/config`, not into `~/.git-credentials`) and it's redacted from logs. The same credentials apply to the server (tracked repos, previews) and to every instance (`pi install`, and agents running `git clone`).

2. **This machine's own git setup.** Your `~/.gitconfig` credential helpers (e.g. `gh auth setup-git`) and SSH keys are used when no token is configured. This works on a desktop session. It can fail headless, when the helper needs an unlocked keyring, or for SSH keys with a passphrase (no agent in a systemd service). Git never prompts; it fails fast with an error in the job log instead.

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

## Behind a corporate proxy with TLS inspection

If your network forces traffic through a proxy that decrypts and re-signs HTTPS (Zscaler, Netskope, Palo Alto, Blue Coat, Fortinet, …), every tool fruity-pi uses has to know two things:
- **The proxy URL.**
- **Your company's root CA certificate.** Without it you'll see errors like `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`, `unable to get local issuer certificate`, or git's `SSL certificate problem`.

That covers Node (the server, pi and the AWS SDK), npm, git, curl and Python. The installer configures all of them in one go.

### 1. Get the root CA as a PEM file

Ask IT for the inspection root certificate, or export it from your browser's certificate viewer. It must be PEM; the file contains `-----BEGIN CERTIFICATE-----`. To convert a DER/`.cer` file:

```bash
openssl x509 -inform der -in corp-root.cer -out corp-root.pem
```

To see which CA is re-signing traffic, look at the **last** certificate in the chain:

```bash
openssl s_client -proxy proxy.corp:3128 -connect registry.npmjs.org:443 -showcerts </dev/null
```

### 2. Install with the proxy and CA

```bash
./install.sh --proxy http://proxy.corp:3128 --ca-cert ~/corp-root.pem
# optional: --no-proxy .corp.internal,10.0.0.0/8   extra hosts that should bypass the proxy
# optional: --ca-system                            also add the CA to the OS trust store (sudo)
```

The flags are applied to the install itself: apt/dnf via `sudo --preserve-env`, the Node.js download, `npm install` and git. They're also saved to `~/.fruity-pi/env` (mode 600), which the systemd service, the `fruity-pi` CLI and **every pi instance** read:

| setting | used by |
|---|---|
| `HTTP_PROXY`, `HTTPS_PROXY` (+ lowercase) | pi and its provider SDKs, npm, git, curl, Python |
| `NO_PROXY` | always includes `localhost,127.0.0.1,::1,169.254.169.254` (loopback + EC2 metadata) |
| `NODE_USE_ENV_PROXY=1` | Node's built-in `fetch`/`http` (the server's package search, pi extensions) |
| `NODE_EXTRA_CA_CERTS` → your CA | Node: fruity-pi, pi, npm, AWS SDK |
| `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `npm_config_cafile`, `REQUESTS_CA_BUNDLE`, `AWS_CA_BUNDLE`, `PIP_CERT` → `~/.fruity-pi/tls/ca-bundle.pem` (system roots + your CA) | OpenSSL tools, curl, git, npm, Python, AWS CLI |

Re-running `./install.sh` (for example to upgrade) reuses the saved settings; you don't need to repeat the flags. To change them, re-run with new flags, or edit `~/.fruity-pi/env` and then run `systemctl --user restart fruity-pi`. Existing instances pick up changes when they restart.

Without the installer (manual `fruity-pi serve`), export the same variables before starting the server. Instances inherit them.

### 3. Allow these hosts on the proxy

| host | why |
|---|---|
| `registry.npmjs.org` | pi packages, package catalog search, installing/upgrading pi |
| `github.com`, `codeload.github.com` (or your git host) | tracked skill repos, `git:` packages |
| your model API: `api.anthropic.com`, `api.openai.com`, `bedrock-runtime.<region>.amazonaws.com`, … | the agents themselves |
| `nodejs.org` | only if the installer has to download Node.js |
| `pi.dev` | optional (pi version checks; fruity-pi already disables telemetry) |
| `deb.debian.org` | only for `docker build` |

Model **API keys set in your shell are not passed to instances** (by design). Put them in **System → Secrets**.

### Docker behind a proxy

1. Copy the CA into `certs/` as a `.crt` file (PEM). It's git-ignored. The image adds it to the system trust store and sets `NODE_USE_SYSTEM_CA=1`, so apt, git, curl, npm, Node, Python and the AWS SDK all trust it.
2. Export the proxy and build/run. Compose passes the variables both as build args (apt + `npm ci`) and at runtime:

```bash
cp ~/corp-root.pem certs/corp-root.crt
export HTTP_PROXY=http://proxy.corp:3128 HTTPS_PROXY=http://proxy.corp:3128 NO_PROXY=.corp.internal
docker compose up -d --build
```

With plain `docker build`, pass `--build-arg HTTP_PROXY=… --build-arg HTTPS_PROXY=…`. Alternatively configure `~/.docker/config.json` → `proxies` once, and Docker injects the settings into every build and container.

### Troubleshooting

| symptom | fix |
|---|---|
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN` / `unable to get local issuer certificate` | CA not configured, or you exported the site/intermediate certificate instead of the **root**. Use the last cert from `openssl s_client -showcerts`. If there's an intermediate, put root + intermediate in the same PEM. |
| `407 Proxy Authentication Required` | put credentials in the URL, `http://user:pass@proxy.corp:3128`, URL-encoding special characters (`@` → `%40`, `:` → `%3A`). NTLM/Kerberos-only proxies need a local helper such as `cntlm` or `px`; point `--proxy` at that. |
| Package search in the UI fails but instances work | the server needs outbound access to `registry.npmjs.org`; check `journalctl --user -u fruity-pi` for the `outbound HTTP via proxy …` line. |
| Bedrock instance-role credentials time out | `169.254.169.254` must bypass the proxy (it's in `NO_PROXY` by default). |
| Test the setup | `source ~/.fruity-pi/env && curl -I https://registry.npmjs.org && git ls-remote https://github.com/earendil-works/pi HEAD` |

Note that the inspection proxy can read everything that passes through it, including prompts, code and API keys. That's inherent to TLS inspection and worth clearing with your security team.

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
