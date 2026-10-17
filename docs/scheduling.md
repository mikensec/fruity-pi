# Provider-aware scheduling

Fruity-Pi schedules **agent turns**, not individual LLM HTTP requests. A Pi turn can issue many model calls. These limits reduce bursts and control aggregate fleet behavior, but are **not** an exact enforcement of a provider's requests-per-minute or tokens-per-minute quotas. For precise usage admission, configure an LLM proxy/gateway at the provider-request layer.

## Configuration

Edit `~/.fruity-pi/config.json`, or use `POST /api/system/settings` (interactive admin session only):

```json
{
  "maxConcurrent": 8,
  "providerLimits": {
    "anthropic": { "maxConcurrent": 2, "maxStartsPerMinute": 5 },
    "openai": { "maxConcurrent": 3, "maxStartsPerMinute": 10 },
    "amazon-bedrock": { "maxConcurrent": 4 }
  },
  "maxDailyCostUsd": 25
}
```

- Provider keys are the prefix of a Pi model identifier, e.g. `anthropic/claude-...`. Instances without a known provider use `unknown`.
- `maxConcurrent` is the global cap, and provider `maxConcurrent` is an additional cap.
- `maxStartsPerMinute` caps **agent turn admissions** in a rolling 60-second interval. It does not count every subsequent model call in the turn. Counts are in-memory and reset after a restart.
- `maxDailyCostUsd` blocks **new turns** after Pi's reported cumulative spending meets the budget for the current UTC day. `0` disables this budget. It does not cancel active turns. Usage records persist in SQLite, but delayed reports and provider-specific accounting may differ from actual bills.
- On a reported 429, rate-limit, or throttling error, admissions for that provider are paused for 60 seconds. Fruity-Pi **does not automatically retry** a turn that may already have issued model requests.
- Turn prompts that cannot yet be admitted are stored in SQLite and survive a service restart. Pending prompts for a stopped instance are removed when explicitly stopped. Queue handoff has *at-most-once* semantics: a process crash after removing a queued item and before an RPC acknowledgement can lose that item rather than retry it.
- `steer` remains immediate because it modifies an already-running turn; `follow_up` goes through the scheduler.

An instance's isolated HOME is **not** an OS security boundary. For hostile code or untrusted agent packages, use a separate VM/container and scoped credentials.

## Limitations

Admission counters and throttling cooldowns do not persist through a restart. Additional turns triggered internally by Pi, token spending per provider, and errors handled internally by provider SDKs cannot be reliably controlled from the supervisor. Do not treat the daily reported-cost guardrail as a hard billing limit.
