# pi-limit-resume

Auto-continue for [pi](https://pi.dev) when a subscription's **5-hour usage window** runs out, similar to Claude Code's auto-continue. It supports ChatGPT/Codex, Claude (OAuth), the GLM Coding Plan and OpenCode Go.

When a run stops on a usage-window limit, the extension finds the reset time and shows a countdown. It then waits in the same session, on the same model, and sends exactly one `continue` after the reset. It never switches models or accounts, never loops, and never spends credits.

## Install

```bash
pi install git:github.com/Haichiu/pi-limit-resume
```

Or copy `extensions/limit-resume/` into `~/.pi/agent/extensions/`. Use only one of the two methods; loading the extension twice registers `/limit-resume` twice.

Restart pi or run `/reload`. `/limit-resume status` should then print `idle`.

## Supported providers

| pi provider | Limit it recognizes | Where the reset time comes from |
|---|---|---|
| `openai-codex` (ChatGPT subscription) | `Codex error: The usage limit has been reached`, `Codex usage limit reached ...`, `You have hit your ChatGPT usage limit ...` | The message, when it has one; otherwise a read-only `GET {baseUrl}/wham/usage` |
| `anthropic` (Claude subscription, OAuth) | 429 `rate_limit_error` "would exceed your account's rate limit" | Read-only `GET /api/oauth/usage` (an undocumented endpoint) |
| `zai`, `zai-coding-cn` (GLM Coding Plan) | Code 1308 (5-hour) and 1310 (weekly/monthly) | The timestamp in the message |
| `opencode-go` | `GoUsageLimitError` "5-hour usage limit reached. Resets in ..." | The duration in the message |

Everything else is ignored: transient 429s, overload, per-minute token limits, and credit or billing errors. pi's own retry handles those.

## Behavior

- It runs after pi has finished its own retries (`agent_settled`), and only in interactive or RPC mode.
- It waits until `max(reset, now) + precision margin + 60 s grace`. A weekly or monthly limit, an unknown reset time, or a reset more than 5 h 15 min away produces one notice and no wait.
- Right before sending `continue`, it checks four things: the session is the same, the limit error is still the latest message, the provider and model are the same, and the session is idle with nothing queued. If anything differs, it shows one notice and sends nothing.
- The wait is cancelled by your own input, `/limit-resume cancel`, a model switch, `/tree` navigation, another agent run starting, or session shutdown or reload. This also applies while it is still checking usage.
- If the automatic `continue` hits the limit again before any successful reply, it notifies once and stops.
- State is kept in memory only, so closing pi discards the wait. Keep the machine awake while it waits.

## Commands

- `/limit-resume` or `/limit-resume status` shows the current state and the last decision.
- `/limit-resume cancel` cancels a pending wait, or a usage check that is still in progress.
- `/limit-resume probe` runs the current provider's read-only usage probe and shows the parsed windows.

## Safety

- Usage probes are read-only GET requests. They use the token pi already holds in memory and go only to the provider's configured base URL, with `redirect: "error"` and a 10 s timeout. Tokens never appear in notices, status text, or logs.
- It never calls reset-credit or any other mutating endpoint.
- `PI_LIMIT_RESUME_GRACE_MS` overrides the 60 s grace (a non-negative integer in milliseconds).

## Deliberately not supported

- Waiting for weekly or monthly quotas. The wait is too long for an unattended timer, so you get a notice instead.
- Switching to another model, account, or credential. A limit is not permission to switch.
- Resuming after pi restarts, background daemons, and response-header capture.
- Continuing on a model that another extension switched to after the limit (for example pi-codex-conversion's Luna Reserve). You get a notice and decide yourself.

## Adding a provider

Add one entry to `ADAPTERS` in `extensions/limit-resume/adapters.ts`:

- A pure `classify()` that returns `null` for anything that is not a usage-window limit.
- A `probe()` only if the provider has a read-only usage endpoint. It must use the injected `fetch`, token, and base URL.

Add sanitized fixture tests. `index.ts` and `core.ts` need no changes.

## Development

```bash
npm install
npm test
```

The RPC wiring test starts the `pi` CLI against a local mock provider, and is skipped if `pi` is not on PATH. It proves pi's lifecycle wiring only, not the real provider transports.

## License

MIT
