# fruity-pi REST API

Base URL: wherever the server listens. Default `http://127.0.0.1:7777`; from another machine, use an SSH tunnel or SSM port forwarding. All request and response bodies are JSON.

Discovery: `GET /api/agent` (no auth) returns a short machine-readable summary and links to these docs.

## Authentication

| Client | How |
|---|---|
| **Agents / scripts** | `Authorization: Bearer fpi_…`. Create tokens in **System → API tokens** or with `fruity-pi token create <name> [--read] [--days N]`. |
| Local CLI | `Authorization: Bearer $(cat ~/.fruity-pi/cli.token)` (same machine only, file mode 600) |
| Browser | Session cookie from `POST /api/auth/login`, plus an `x-csrf-token` header on non-GET requests |

Token scopes:

- **full**: everything below except the human-only endpoints.
- **read**: `GET` endpoints, plus `POST /api/collect`, `/api/resolve`, `/api/deployments/plan` and `/api/packages/preview`.

**Human-only** (API tokens get `403`):
- `/api/tokens*`, `/api/import/*`
- `/api/system/{secrets,shell,password,totp/*,webhook,upgrade-pi,settings,cleanup}`
- `/api/auth/*` (except the public ones)
- the web shell (`/ws/shell`)

Every state-changing call is written to the audit log with the token name.

Errors look like `{"error": "message"}` with a 4xx/5xx status.

## Selectors

Several endpoints take `selector` (a string) and/or `ids` (an array of instance ids). They match the union of:

```
all                      every instance
cluster:reviewers        instances in that cluster
deployment:audit         instances created by that deployment
profile:code-review      instances using that profile
reviewers-3              a single instance (same as instance:reviewers-3)
review*                  globs work in any value
cluster:a, writers-1     comma = union
```

## Jobs

Slow operations (provisioning, rollouts, installs, repo fetches) return `{"job": {"id": "…", "status": "running", …}}` immediately.

| | |
|---|---|
| `GET /api/jobs` | recent jobs (no logs) |
| `GET /api/jobs/:id` | `{id, title, kind, status: "running" \| "done" \| "failed", error?, log: string[]}` |

Poll `GET /api/jobs/:id` every 1–2 s until `status` is no longer `running`.

## State

### `GET /api/state`
Everything in one call:
```jsonc
{
  "instances": [{
    "id": "reviewers-1", "name": "reviewers-1", "profile": "code-review",
    "deployment": "audit", "cluster": "reviewers",
    "status": "idle",              // stopped|starting|idle|running|queued|updating|error
    "modelLabel": "anthropic/claude-sonnet-5-5",
    "tail": "…last ~1200 chars of output…",
    "cost": 0.0123, "tokens": 18234,
    "configDrift": false, "repoDrift": false, "pendingRestart": false,
    "queuePosition": null, "lastError": null, "sessionId": "…", "repoShas": {"acme-skills": "9f1c…"}
  }],
  "profiles": [ /* see Profiles */ ],
  "repos": [ /* see Tracked repos */ ],
  "deployments": [{ "name": "audit", "groups": [...], "yaml": "…", "plan": [ /* pending steps */ ] }],
  "stats": { "running": 2, "queued": 0, "maxConcurrent": 8, "live": 12, "cost": 1.42 },
  "config": { "maxConcurrent": 8, "shellEnabled": false, … },
  "jobs": [ … ]
}
```

## Commanding instances

### `POST /api/send`
```jsonc
{
  "selector": "cluster:reviewers",   // and/or "ids": ["reviewers-1"]
  "action": "prompt",                // see table
  "message": "Review src/auth for injection bugs",
  "wait": true,                      // prompt/steer/follow_up only: block until each run settles
  "timeout": 900                     // seconds for wait (1–3600, default 600)
}
```
| action | extra fields | effect |
|---|---|---|
| `prompt` | `message` | Start a run. If the global concurrency cap is reached it queues (`disposition: "queued-by-fruity-pi"`). |
| `steer` | `message` | Inject guidance into an in-flight run. |
| `follow_up` | `message` | Queue a message to run after the current run. |
| `abort` | | Stop the current run. |
| `new_session` | | Start a fresh conversation. |
| `compact` | `message` (optional instructions) | Compact the context. |
| `set_model` | `model: "provider/model-id"` | Switch model live (until restart). |
| `set_thinking` | `level: off\|minimal\|low\|medium\|high\|xhigh\|max` | |
| `start` / `stop` / `restart` | | Process lifecycle. |

Response:
```jsonc
{ "action": "prompt", "results": [
  { "id": "reviewers-1", "name": "reviewers-1", "ok": true, "disposition": "started",
    // only with wait:true
    "done": true, "status": "idle", "text": "final assistant answer" }
]}
```
With `wait: true` the HTTP request stays open until every targeted instance finishes, or the timeout hits. Set your HTTP client timeout above `timeout`. For long jobs, prefer `wait:false` and then `POST /api/collect`.

### `POST /api/collect`
`{"selector": "cluster:reviewers"}` → `{"results": [{id, name, cluster, status, text}]}`. `text` is the last assistant message, or `null`.

### `POST /api/resolve`
`{"selector": "…", "ids": [...]}` → `{"ids": [...]}`. Preview what a selector matches.

## Instances

| | |
|---|---|
| `POST /api/instances` | `{profile, count=1, cluster?, namePrefix?, cwd?, model?, start=true}` → `{instances: [ids], job}` |
| `GET /api/instances/:id` | `{instance, command}` (`command` runs the same instance interactively in a terminal) |
| `GET /api/instances/:id/events?tail=500` | persisted pi events (`message_end`, `tool_execution_*`, …) |
| `GET /api/instances/:id/commands` | loaded commands incl. `skill:*` entries, straight from pi |
| `GET /api/instances/:id/state` | pi's live state (model, sessionId, messageCount, isStreaming…) |
| `POST /api/instances/:id/start` · `stop` · `restart` | |
| `POST /api/instances/:id/reprovision` | re-apply profile packages/settings, then restart → `{job}` |
| `POST /api/instances/:id/delete` | stop and delete (sessions and workspace too) |

## Profiles

| | |
|---|---|
| `PUT /api/profiles/:id` | create or replace (body = profile without `id`) |
| `DELETE /api/profiles/:id` | only when unused |
| `POST /api/profiles/:id/rollout` | re-provision + restart every instance using it → `{job}` |

```jsonc
{
  "description": "Code review agents",
  "repos": ["acme-skills"],                         // tracked repo ids
  "packages": ["npm:pi-web-access", {"source": "git:github.com/x/y@v1", "skills": ["-skills/noisy"]}],
  "skills": ["/opt/skills/house-style"],            // extra local skill paths
  "model": "anthropic/claude-sonnet-5-5",           // or amazon-bedrock/us.anthropic.claude-sonnet-5, …
  "thinking": "high",
  "tools": "read,bash,edit,write",                  // optional allowlist
  "approve": false,                                 // pi -a: trust project-local .pi files
  "appendSystemPrompt": "Be terse.",
  "modelsJson": "{\"providers\":{…}}",              // optional custom providers (Ollama, …)
  "extraArgs": [], "env": {"FOO": "1"}
}
```
Saving a profile doesn't touch running instances until you roll it out, or until a deployment apply does.

## Deployments

| | |
|---|---|
| `POST /api/deployments/plan` | `{yaml}` → `{spec, steps: [{op: create\|update\|remove, cluster, name, reasons?}]}` (no changes made) |
| `PUT /api/deployments` | `{yaml, apply?: bool}` → saves; with `apply:true` also `{job, steps}` |
| `POST /api/deployments/:name/apply` | apply the saved spec → `{job, steps}` |
| `DELETE /api/deployments/:name` | tear down all its instances → `{job}` |
| `GET /api/deployments/example` | `{yaml}` starter spec |

```yaml
name: audit                 # lowercase id
groups:
  - cluster: reviewers      # instance names become reviewers-1, reviewers-2, …
    profile: code-review
    replicas: 5             # 0–200; lowering it DELETES the highest-numbered replicas
    model: provider/model   # optional override
    cwd: /work/app          # optional shared working dir (must exist on the server)
    worktree: true          # optional: one git worktree + branch per replica (cwd must be a git repo)
```
Updates roll two instances at a time. Each waits for its in-flight run to settle, and the session continues.

## Tracked repos

| | |
|---|---|
| `POST /api/repos` | `{url, ref="main", id?, mode?: track\|pinned, pollSeconds=120, subdir?}` → `{repo, job}` |
| `PUT /api/repos/:id` | change `ref`, `mode`, `pollSeconds`, `subdir` → `{repo, job}` |
| `POST /api/repos/:id/check` | check for new commits now → `{job}` |
| `POST /api/repos/:id/rollback` | `{sha}`; pins the repo to that commit and rolls instances back |
| `DELETE /api/repos/:id` | only when no profile uses it |

`url` accepts `github.com/owner/repo`, `https://…`, `git@…`, `file:///path`. A repo with a `package.json` "pi" manifest, or `skills/ extensions/ prompts/ themes/` folders, loads as a pi package. Otherwise it's scanned for `SKILL.md` files.

## Packages

| | |
|---|---|
| `GET /api/packages/search?q=web` | npm catalog search (`keywords:pi-package`) |
| `GET /api/packages/info?name=pi-web-access` | README, versions, manifest, `runsCode` |
| `POST /api/packages/preview` | `{source}` → resources inside (skills/extensions/prompts/themes) without installing |
| `GET /api/packages/installed` | fleet matrix: `{instances, packages: [{identity, source, tracked?, runsCode, instances: {id: {origin, version, resources[]}}}]}` |
| `POST /api/packages/action` | see below → `{job, skipped?}` |

```jsonc
{
  "action": "install",            // install | remove | update | toggle
  "source": "npm:pi-web-access",  // npm:…, git:host/owner/repo@ref, https://…, /abs/path
  "scope": {"kind": "cluster", "value": "reviewers"},   // profile | cluster | deployment | instance | all | selector
  // toggle only:
  "resourceType": "skills", "resourcePath": "skills/noisy", "enabled": false
}
```
`scope.kind = "profile"` edits the profile, so current and future instances get the change. The other kinds add instance-level overrides.

## Import from an existing pi (interactive login only)

Reads an existing stand-alone pi install (default `~/.pi/agent`; pass `dir` to scan another). The source is never modified; everything is copied.

| | |
|---|---|
| `GET /api/import/setup?dir=` | summary: model, skills, extensions, prompts, AGENTS.md, models.json, session count |
| `POST /api/import/setup` | `{id, dir?}` → snapshot into `~/.fruity-pi/imports/<id>` and create profile `<id>` |
| `GET /api/import/sessions?dir=` | `{sessions: [{file, id, cwd, messages, firstPrompt, lastPrompt, updatedAt, …}]}` |
| `POST /api/import/session` | `{file, profile, name?, cwd?: "original" \| "private" \| "/path", start?}` → `{job}`; copies the session into a new instance that continues it |

## System (read-only for tokens)

| | |
|---|---|
| `GET /api/system` | checks, pi version, host info, masked secret names, recent audit log |
| `GET /api/system/disk` | disk usage per instance and per repo |
| `GET /api/system/latest-pi` | newest pi version on npm |

## Live events (optional)

`GET /ws` (WebSocket; `Authorization: Bearer …` works for non-browser clients) streams JSON messages:

- `{topic:"instance", instance}`: status and output changes
- `{topic:"event", id, event}`: every raw pi event, including `message_update` text deltas and `agent_settled`
- `{topic:"job", job}` / `{topic:"job-log", id, line}`
- `{topic:"repo", repo}`
- `{topic:"state"}`: something structural changed; re-fetch `/api/state`

Most agents don't need this: `POST /api/send` with `wait:true`, or polling, is simpler.

## Examples

```bash
H="authorization: Bearer $FRUITY_PI_TOKEN"; U=${FRUITY_PI_URL:-http://127.0.0.1:7777}

# Ask a cluster and wait for the answers
curl -s -H "$H" -H 'content-type: application/json' "$U/api/send" \
  -d '{"selector":"cluster:reviewers","action":"prompt","message":"List 3 risks in src/","wait":true,"timeout":900}' \
  | jq -r '.results[] | "## \(.name)\n\(.text)"'

# Scale via a spec
curl -s -H "$H" -H 'content-type: application/json' -X PUT "$U/api/deployments" \
  --data-binary "$(jq -Rs '{yaml: ., apply: true}' fleet.yaml)"
```

```python
import os, requests
U = os.environ.get("FRUITY_PI_URL", "http://127.0.0.1:7777")
S = requests.Session(); S.headers["Authorization"] = f"Bearer {os.environ['FRUITY_PI_TOKEN']}"
r = S.post(f"{U}/api/send", json={"selector": "all", "action": "prompt",
                                   "message": "Summarize the README", "wait": True, "timeout": 600}, timeout=700)
for res in r.json()["results"]:
    print(res["name"], "→", res.get("text"))
```
