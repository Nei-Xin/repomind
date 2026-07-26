# ADR-001: RepoMind is an independent core, not bound to one agent

Status: accepted

## Context

Coding agents (Codex, Claude Code, OpenCode) each keep session context in their own formats. Memory tied to one host cannot be reused by another, and host formats change outside our control.

## Decision

RepoMind is a standalone memory layer. The domain model knows nothing about any host's session format; hosts identify themselves only through optional `client_name` / `client_session_id` strings.

## Consequences

- The same database serves every MCP client that opens the repository.
- Host-specific behavior must live in configuration or thin adapters, never in the core.
- RepoMind cannot passively observe host activity; it depends on the explicit session protocol (see ADR-002).
