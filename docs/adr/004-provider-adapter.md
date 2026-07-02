# ADR 004: Provider Adapter

## Status

Accepted.

## Decision

Provider-specific behavior belongs behind ProviderAdapter operations and capability flags. Unsupported features return supported=false with a reason code and message.

## Rationale

React pages and Web routes previously guessed login state, model support, quota support, and creation capability from provider-specific details. That caused inconsistent UI states.

## Consequences

Pages consume ProviderStatus and adapter capabilities. Gemini quota unsupported is an informational state, not an unauthenticated state. Antigravity can report unknown auth when reliable detection is not available.
