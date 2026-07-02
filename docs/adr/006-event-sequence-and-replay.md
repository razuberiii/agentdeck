# ADR 006: Event Sequence And Replay

## Status

Accepted.

## Decision

AgentDeck distinguishes runtimeLatestSequence, snapshotCoveredSequence, browserAppliedSequence, and browserAcknowledgedSequence.

## Rationale

Treating snapshot coverage as browser acknowledgement can skip persisted Runtime events. The browser must advance its applied cursor only after it has accepted and rendered an event or snapshot content.

## Consequences

Reconnect sends the browser-applied sequence. Web buffers/replays from Runtime and deduplicates by sequence and generation. Duplicate delivery is acceptable; permanent event loss is not.
