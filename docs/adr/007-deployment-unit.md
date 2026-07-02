# ADR 007: Deployment Unit

## Status

Accepted.

## Decision

Deployment is a single checked operation exposed by `scripts/deploy.sh`. `--check` never restarts services. `--deploy` uses a lock, refuses active turns, backs up data, runs validation, restarts Runtime/Web in order, checks health, and rolls back on failure.

## Rationale

Separate manual restarts can sever the current AgentDeck session and leave Web and Runtime on mismatched versions.

## Consequences

Production deployment happens after the coding task final report. Codex app-servers are not restarted by default, and the manual app-server used by the current task is left alone.
