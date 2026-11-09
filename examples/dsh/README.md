# DeepSeek Harness native memory

RepoMind's Cordis plugin recalls repository memory before a DSH user turn and
records the resulting evidence through the local Bridge. DSH continues to use
its configured model provider. MemoryProxy is not required.

Validated host: `@deepseek-ai/dsh@0.2.2-rc.1`, Node.js >=24.9.0. DSH is a preview
and its plugin interfaces can change; `doctor dsh` reports other versions as
unvalidated rather than assuming semver compatibility.

## Install and launch

Install/build RepoMind as described in the main README, and install the pinned
DSH version in your preferred npm prefix:

```bash
npm install -g @deepseek-ai/dsh@0.2.2-rc.1
cd /path/to/git/repository
repomind dsh setup
repomind doctor dsh --json
dsh web --patch .repomind/dsh/cordis.patch.yml
```

Setup initializes RepoMind, writes `.repomind/dsh/cordis.patch.yml`, and starts
the local Bridge. The overlay references this RepoMind installation by absolute
file URL and binds it to this Git checkout. Re-run setup after moving or updating
RepoMind. An existing unmanaged overlay is never overwritten. No existing DSH
profile, model configuration, API key, or MCP configuration is changed.

DSH does not automatically load repository-local plugins. **Keep `--patch` on
every launch**, or add the generated overlay to your own launcher. The same
overlay works with a headless invocation:

```bash
dsh headless --patch .repomind/dsh/cordis.patch.yml --json "Fix and verify the invoice tests"
```

This is native plugin operation, not `repomind run --runner dsh` (not supported).
If DSH is not on PATH, pass `--runner-executable /absolute/path/to/dsh` to setup
and doctor. Setup/status return the launch executable, arguments, and cwd as
separate JSON fields.

Use the same `REPOMIND_DATA_DIR` environment for setup and DSH if you customize
storage, so the plugin reads the matching Bridge token. DSH's `DSH_HOME` selects
its profiles and sessions independently. Avoid enabling a second RepoMind MCP
start/commit lifecycle for the same task.

## Model configuration

Your existing DSH model selection is preserved. For an OpenAI-compatible test
endpoint, a separate DSH overlay can configure the shipped pi-ai adapter:

```yaml
- id: agent-default-model
  config:
    provider: local-test
    model: your-model-id
- id: llm-pi-ai
  config:
    providers:
      local-test:
        apiKeyEnv: OPENAI_API_KEY
        api: openai-completions
        baseURL: https://your-endpoint.example/v1
        models:
          - id: your-model-id
            contextWindow: 128000
            maxTokens: 4096
            reasoning: false
```

Set the key through the launch environment, then include both overlays:

```bash
dsh web --patch /path/to/model.patch.yml --patch .repomind/dsh/cordis.patch.yml
```

Use the actual model's context/output limits and reasoning capabilities. Model
credentials are not part of the RepoMind overlay or its Bridge activity records.

## Lifecycle and evidence

- `agent/pre-step`: respect downstream rejection/rewrites, select messages
  whose source is `user`, then retrieve context before this request enters.
  Recall is inserted into the returned batch, since prompt assembly precedes
  this hook. Tool continuations and generated runtime context do not start tasks.
- `tools/result`: observe the executor's final canonical value. Only a completed
  foreground bash result with an integer exit establishes command verification.
  Tool errors, timeouts, missing exits, and background-job acceptance cannot
  establish a passing test. Durable custom-executor results remain unverified.
- `session/event`: capture calls, the final assistant response, and `turn/end`.
  Errors become failed tasks; truncation, blocked turns, missing results or
  recording errors become partial; cancellation/interruption abandons the task.
  `agent/turn-stopping` is not used as a completion signal.
- Per-session queues drain at `session/flush` and plugin disposal. Event identity
  and native sequence numbers suppress replay. A resumed conversation starts a
  new RepoMind task for its new user turn. Steering stays within the open turn.
- The Bridge applies existing redaction, Git evidence, extraction and derived
  memory maintenance. Failed recall/recording warns and allows DSH to continue.

First-version boundaries: root user turns only; subagents are ignored rather
than treated as independent user tasks. Background results are not correlated
back to commands for verified evidence. A session that changes to another Git
checkout abandons its current RepoMind task. The plugin does not import old DSH
history or reconstruct execution-local values after a process crash.

In the validated DSH release, interrupting a headless process can print an
upstream `flush on a closed handle` diagnostic. RepoMind's awaited Cordis effect
cleanup still abandons its task; a hard process kill cannot run that cleanup.

## Check the result

Have DSH make a small change and run a repository test, then open a fresh
conversation and ask for the previously verified command. To separate memory
recall from rediscovering the answer, ask it to answer from the supplied memory
without reading files or calling tools.

```bash
repomind dsh status --json
repomind search "invoice verification" --json
repomind inspect <memory-id> --json
```

`ready` verifies the overlay, build entry, exact host version and Bridge health;
it does not prove that a running DSH process loaded the overlay. After updating
the plugin, restart DSH. The automated integration suite (`tests/dsh-native.test.ts`)
uses a real isolated Bridge and database with simulated DSH callbacks and no
paid model. Real model acceptance is a separate, explicit server-side exercise.
