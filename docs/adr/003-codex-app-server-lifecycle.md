# ADR 003: Codex App Server Lifecycle

## Status

Accepted.

## Decision

Runtime owns Codex app-server lifecycle through a profile-aware ensure path. Each profile maps to one unit, one endpoint, one runtime client, and one account identity.

## Rationale

Starting app-servers from multiple routes caused duplicate systemd-run calls and stale endpoint reuse. Invalid run users produced 217/USER and Restart=always amplified the failure.

## Consequences

The default service user is the existing deployment user unless configured otherwise. Units use bounded restart policies. Invalid user/group, endpoint conflicts, and identity mismatches return structured errors instead of retry loops.
