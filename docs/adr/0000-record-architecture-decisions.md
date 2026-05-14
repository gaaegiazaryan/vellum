# 0000. Record architecture decisions

## Status

Accepted, 2026-05-14.

## Context

Vellum will accumulate non-obvious technical choices over time: ORM picks, AI extraction patterns, idempotency model, deploy targets, multi-tenancy boundaries. Without a record, these decisions become tribal knowledge that disappears the moment the original context is forgotten. Code shows what; ADRs show why.

## Decision

Architecture Decision Records live in `docs/adr/`, one file per decision, numbered sequentially. Each ADR follows the Nygard template (Status, Context, Decision, Consequences). ADRs are immutable once accepted; if we change our minds, we write a new ADR that supersedes the old one and link both ways.

## Consequences

The repo gets a visible reasoning trail. A new contributor (or future me) can read `docs/adr/` and understand why the code looks the way it does. ADRs cost a few minutes per significant decision; trivial choices (file naming conventions, prettier settings) do not need one. The history of changed minds is preserved instead of being silently overwritten.
