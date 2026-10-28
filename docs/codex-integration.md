# Codex native integration

RepoMind supports local Codex through project Hooks. The first validated
version is **Codex CLI 0.165.0**, with Node.js 22.5+ available to RepoMind.

```bash
repomind codex setup --repo /path/to/repository
repomind doctor codex --repo /path/to/repository
cd /path/to/repository
codex
```

Setup initializes repository memory, merges RepoMind handlers into
`.codex/hooks.json`, and starts the loopback Bridge. Other hooks and model
configuration are preserved. Re-running setup repairs the managed definitions
without duplicating them, including when RepoMind moves.

**Trust the repository, then review and trust the RepoMind definitions using
`/hooks` in Codex.** Codex skips untrusted hooks. Re-review definitions after
setup changes their command or options. RepoMind does not modify Codex's trust
database or disable its checks. Status checks installation, supported version
and Bridge health; `ready` does not prove the client has trusted or executed
the hooks. Restart an existing Codex session after setup.

Configure your model, provider and credentials in Codex as usual. RepoMind does
not proxy model traffic or write API keys. Keep `REPOMIND_DATA_DIR` consistent
between setup and Codex if you override it. Avoid a second, model-managed
RepoMind MCP lifecycle alongside native hooks.

## Lifecycle and evidence

`UserPromptSubmit` retrieves repository context and returns it as additional
developer context. `PreToolUse` and `PostToolUse` capture tool activity. `Stop`
records the final answer and finishes the task. `Interrupt` abandons the
interrupted turn, and `SessionEnd` abandons any unfinished task. Native session,
turn and tool identifiers isolate events; delayed events cannot close a newer
task. Subagent-tagged hooks are ignored so they cannot finalize the main task.

**Codex 0.165 Bash hooks return raw stdout without an exit code, even when the
command fails.** RepoMind retains that output as activity but does not infer
success from it or from the assistant's final answer. Test/build/lint activity
without a known exit remains unresolved, so that task is `partial` and does not
produce successful-task memories. Explicit structured exit codes, when supplied
by the client, can become command evidence. Raw output containing text such as
`exit code 0` cannot bypass this rule. File-changing tasks without unresolved
verification can still produce memories under the existing quality rules.

This limitation does not prevent recall of verified commands captured by Pi,
Claude or OpenCode. RepoMind does not parse Codex's unstable transcript format,
rewrite shell commands, or repeat commands to manufacture missing evidence.

Normal hook requests recover a stopped default Bridge. `Interrupt` and
`SessionEnd` have a three-second client limit, so they use a short request and
skip service startup. Unavailable memory produces a nonblocking warning; there
is no offline queue. Forced process termination cannot guarantee finalization.

Validated scope: local Codex CLI. Desktop and cloud orchestration surfaces have
different hook availability and require separate validation. Native hooks do
not add Codex to `repomind run --runner`.

Official interface: [Codex Hooks](https://learn.chatgpt.com/docs/hooks).
