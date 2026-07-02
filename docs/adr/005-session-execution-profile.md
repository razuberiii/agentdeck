# ADR 005: Session Execution Profile

## Status

Accepted.

## Decision

Sessions keep separate creatorProfileId, selectedProfileId, executingProfileId, and upstreamBindingProfileId fields.

## Rationale

History belongs to AgentDeck, while provider quota is consumed by the account executing the current turn. Continuing a session after switching accounts must not silently reuse the old account.

## Consequences

Each turn records the executing profile and account snapshot. If the current account cannot load the old upstream thread, Runtime can create a new upstream binding with local history context. If execution is impossible, Runtime returns a clear error.
