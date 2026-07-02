# ADR 001: Runtime Source Of Truth

## Status

Accepted.

## Decision

Runtime is the owner of execution state. Web and browser can display or cache state, but they cannot decide whether a session is running, which provider profile executes a turn, whether a provider runtime must be started, or which event sequence is latest.

## Rationale

The previous split let Web, Runtime, and browser each infer parts of the same state. That made reconnects, account switching, and provider process reuse ambiguous. A single owner prevents silent fallback to the wrong account and prevents browser cursor mistakes from hiding persisted events.

## Consequences

Web routes must call Runtime for execution decisions. Browser code must treat snapshots as data to apply, not as acknowledgement cursors. Runtime DB remains separate for now, but duplicate Web fields are read-only mirrors or compatibility fields.
