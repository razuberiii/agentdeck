# ADR 007: Deployment Unit

## Status

Accepted.

## Decision

Deployment is a checked operation exposed by `scripts/deploy.sh`. `--check` never restarts services. `--deploy --components ...` scopes the cutover to Web, Runtime, or a named Provider profile. Runtime deploy enters draining, refuses new sessions and turns with retryable `runtime_draining`, lets existing turns and event writes finish, restarts Runtime, and verifies health.

## Rationale

Separate manual restarts can sever the current AgentDeck session and leave Web and Runtime on mismatched versions. Component-scoped deploys avoid restarting healthy Provider processes when only Web or Runtime code changed.

## Consequences

Production deployment happens after the coding task final report. Codex app-servers are not restarted by default, and Provider restart requires an explicit `provider:<name>:<profileId>` component. Backups are written under `/opt/data/agentdeck/backups/`, not the Git worktree.
