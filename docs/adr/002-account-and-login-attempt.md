# ADR 002: Account And LoginAttempt

## Status

Accepted.

## Decision

Formal provider accounts are separate from login attempts. Starting a login creates a LoginAttempt only. A ProviderProfile becomes visible only after authentication succeeds and identity is read.

## Rationale

Placeholder accounts such as "Codex Account" and "Gemini Account" leaked into the UI and could become active profiles. Separating LoginAttempt prevents unfinished authorization jobs from being treated as accounts.

## Consequences

Pending login UI is labelled as tasks. Failed or cancelled attempts do not alter the active account. Unresolved identities are not allowed to create sessions until account identity is resolved or the user intervenes.
