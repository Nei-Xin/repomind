# ADR-008: The core does not depend on the MCP SDK

Status: accepted

## Context

The CLI, tests, benchmark runner, and future adapters all need the same business logic. Binding the domain to the MCP SDK would force every consumer through protocol types and make the core untestable without a client.

## Decision

`RepositoryMemoryCore` and everything under `src/domain`, `src/storage`, `src/git`, `src/security`, and `src/eval` import nothing from `@modelcontextprotocol/sdk`. The MCP layer (`src/mcp/server.ts`) only parses parameters, calls the core, maps errors, and truncates output.

## Consequences

- CLI and MCP expose identical semantics because they call the same methods.
- The evaluation suite drives the real core without any protocol overhead.
- MCP schema changes never ripple into domain types.
