# AgentDeck Architecture

AgentDeck is split into three layers:

```text
Browser
  |
  | HTTP, WebSocket, uploads
  v
Web server
  |
  | Runtime HTTP/SSE
  v
Runtime
  |
  | Provider protocol
  v
Codex app-server / Gemini ACP / Antigravity CLI
```

The Web server handles login to AgentDeck, CSRF and origin checks, file upload/download, static assets, and forwarding events to the browser. The Runtime owns execution state: sessions, turns, provider thread IDs, event sequence, app-server lifecycle, and the active upstream account used for each turn.

## Message Flow

1. Browser sends a user message over the WebSocket.
2. Web validates the request and forwards it to Runtime.
3. Runtime validates the selected provider profile, records the executing profile, and sends the turn to the provider.
4. Provider events are persisted by Runtime.
5. Runtime streams events to Web.
6. Web forwards events to subscribed browsers.
7. Browser renders only events it has actually applied.

Canonical user messages store the user-visible `originalText` and structured
`attachments[]`. Provider adapters may derive a temporary provider input with
resource references, but that input is not persisted as message text, replayed
to the browser, exported, or allowed to expose server absolute paths.

Artifacts are owned by the turn that created or modified them. Web records a
file manifest baseline before the turn and compares path, size, and content hash
after completion. Only changed files are persisted as artifacts, with a stable
turn and item anchor. Session reads only inject persisted artifacts and do not
rescan the workspace to infer old files as new output.

## Stored State

Runtime-owned:

- Session running status and active turn.
- Provider session/thread IDs.
- creatorProfileId, selectedProfileId, executingProfileId, upstreamBindingProfileId.
- Session model and provider capabilities.
- Runtime events and latest sequence.
- Codex app-server unit and endpoint ownership.
- Turn artifact baselines and persisted artifact records.
- Runtime lifecycle: starting, accepting, draining, stopping.

Web-owned:

- AgentDeck web authentication.
- CSRF and origin policy.
- Upload metadata and static file serving.
- UI settings that are not execution state.

Read-only mirror:

- Web may mirror session rows for listing and migration compatibility.
- Browser snapshots are views, not the source of truth.

Deprecated duplicate:

- Web-side running status and inferred provider readiness are retained only for compatibility and should not drive execution decisions.

## Refresh And Reconnect

On page load, the browser loads a snapshot and opens a WebSocket subscription. Snapshot coverage does not mean the browser applied every event. Reconnect sends the browser-applied sequence so Web and Runtime replay anything missing. Duplicate events are acceptable; lost events are not.

## Accounts And Sessions

An AgentDeck Session belongs to AgentDeck, not to one provider account. Each turn records the executing profile that will consume provider quota. Switching accounts changes the default executing profile for the next turn; it does not delete history.

## Deployment Boundary

Provider processes are independent of Web and Runtime deployment by default.
Healthy Codex app-servers survive Web/Runtime restarts; the new Runtime
reconnects to them from persisted account, unit, endpoint, and session binding
state.

Gemini personal OAuth profiles can be authenticated while unable to create new
sessions when the upstream personal CLI client is unsupported. AgentDeck reports
that as `gemini_client_unsupported` with `canCreateSession=false`, not as an
unauthenticated account. API Key and enterprise-style profiles are evaluated
separately.

`scripts/deploy.sh --check` performs validation without restarting services.
`--deploy --components web` restarts only Web. `--deploy --components runtime`
starts Runtime draining, waits for active turns, submitting turns, and pending
event writes to finish, then restarts Runtime. `--deploy --components
web,runtime` drains/restarts Runtime first, then Web. Provider components are
restarted only when explicitly requested, for example
`provider:codex:<profileId>`.

Backups live outside the Git worktree under `/opt/data/agentdeck/backups/`.
The worktree-local `.backups/` path is ignored and only kept as a legacy staging
name if it appears.
