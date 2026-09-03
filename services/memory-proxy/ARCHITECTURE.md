# MemoryProxy architecture

This file is the public source of truth for the extracted MemoryProxy service.
Some source comments retain links to historical internal design notes; the
tracked compatibility notes at those paths redirect here.

## Request lifecycle

The Hono server accepts OpenAI Chat Completions, Anthropic Messages, Codex and
WorkBuddy Responses, and DSH requests. A primary request is authenticated,
classified by its Agent adapter, associated with a Session, optionally enriched
by the Injection pipeline, rate-limited, forwarded upstream, and then reported
to the enabled observability and extraction sinks.

Auxiliary protocol endpoints bypass the primary conversation lifecycle. The
`skill-bridge` and `memory-bridge` routes derive identity from initialized
Session state and replace caller-supplied identity fields before forwarding.

## Security boundaries

Tenant authentication uses `auth.*` and `x-tdai-user-key`. Administration is a
separate boundary: `/v3/admin/*`, `/v3/session/*`, and instance-destruction
routes require `Authorization: Bearer <admin.apiKey>`. When the administrator
key is empty, those routes fail closed with HTTP 503.

The normal RepoMind local service manager binds MemoryProxy to `127.0.0.1`.
Standalone deployments default to `0.0.0.0` and therefore must configure the
administrator key and their network boundary before exposing port 8096.

## State and storage

Session, injection, binding, Skill-buffer, and version-pin state can use Redis
or ProxyStorage. ProxyStorage supports COS, SQLite, filesystem, and memory
backends. Keys are split between rebuildable `ttl/` state and persistent
`nottl/` business state.

COS is the only supported multi-node backend and is fail-closed. If the private
cost-guard adapter, Shark, or STS initialization is unavailable, startup fails;
it never silently degrades to node-local state. For local development, the
fallback order is SQLite, filesystem, then memory.

## Optional private extension

`@context-proxy/cost-guard` is not part of this public checkout. Routing and
request preparation degrade to direct passthrough when it is absent. COS is the
exception because its kernel-STS adapter is supplied by that extension; asking
for the COS backend without the extension is a startup error.

## Validation boundary

The service has its own package, lock file, typecheck, and Vitest suite. Root CI
runs these in a dedicated `memory-proxy` job. The root RepoMind npm artifact does
not package this service; transparent Claude integration that uses it is a
source-checkout workflow.
