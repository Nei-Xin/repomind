# ADR-002: MCP is the first public protocol, not a host tool hook

Status: accepted

## Context

An MCP server only sees calls made to its own tools. It cannot observe the host agent's file edits, shell commands, or test runs, so "automatically capture everything the agent does" is not implementable on MCP alone.

## Decision

RepoMind exposes an explicit session protocol over MCP stdio: `repo_session_start` captures a Git baseline, the agent works normally, and `repo_session_commit` submits results while RepoMind re-reads Git state to compute verifiable differences. Host hooks may later enrich traces but must never become a hard dependency.

## Consequences

- Evidence quality depends on the agent calling commit; the CLI lists long-open sessions as a safety net.
- Git snapshots and diffs are the objective evidence source, independent of agent honesty.
- stdout in `repomind mcp` carries only JSON-RPC; logs go to stderr (verified by an automated purity test).
