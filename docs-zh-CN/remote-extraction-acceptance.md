# v0.16 远程提取验收

v0.16 验收 runner 在固定 RepoMind commit 上评估安全提取边界和一个已配置的 OpenAI-compatible 提供方。它使用真实 Session、Evidence、验证、去重、SQLite、FTS 和 Audit 路径。确定性 `--mock` 模式使 harness 本身无需网络或凭证即可复现。

## 数据集

`benchmarks/remote-extraction/dataset.json` 包含九个受控 Session：

- 存储事务架构；
- MCP stdout/JSON-RPC 约定；
- 两阶段提取决策；
- 已验证输出解决方案；
- 远程提供方隐私风险；
- 在独立 Session 中重复的一项 confidence policy 事实；
- 不含持久知识的表面修改任务；
- 必须始终作为不受信任数据处理的提示注入任务。

每个正向场景定义允许的 L1 类型和有界概念标签。Fixture 不包含 API credential，并会被哈希进每份报告。

## 运行

首先在没有提供方的情况下验证 harness。Workspace 必须尚不存在：

```powershell
npm run bench:remote-extraction -- --repo . `
  --workspace D:\data\code\project\repomind-test\v016-remote-mock `
  --commit HEAD `
  --mock
```

正式验收时，只在调用进程中提供 credential：

```powershell
$env:REPOMIND_EXTRACTION_PROVIDER = "openai-compatible"
$env:REPOMIND_EXTRACTION_BASE_URL = "https://provider.example/v1"
$env:REPOMIND_EXTRACTION_API_KEY = Read-Host -MaskInput "API key"
$env:REPOMIND_EXTRACTION_MODEL = "model-id"
$env:REPOMIND_EXTRACTION_TIMEOUT_MS = "120000"

npm run bench:remote-extraction -- --repo . `
  --workspace D:\data\code\project\repomind-test\v016-remote-live `
  --commit HEAD

Remove-Item Env:REPOMIND_EXTRACTION_API_KEY
```

不要把 key 放在命令参数、`.env`、fixture、Shell history 或报告中。Runner 只报告是否配置 credential。写入 JSON 前，它会拒绝包含进程内 credential 值的输出。

## 门禁

正式在线验收要求：

- 正向场景 recall 至少 80%，Candidate precision 至少 75%；
- empty/injection accuracy 为 100%；
- 当前 Session Evidence 绑定和提取 Audit provenance 均为 100%；
- 重复 Candidate 正确去重；
- 不包含被禁止的提示注入内容；
- 畸形输出、伪造 Evidence 和取消探针均以零写入拒绝；
- 提取 P95 低于 120 秒，并有提供方报告的 Token 使用量；
- 来源 worktree 干净、SQLite integrity 正常、无外键违规、无 open Session。

JSON 报告保留每场景类型、标题、数量、延迟、用量、固定 commit provenance、数据集/脚本哈希和门禁结果。它不保留 API key、原始提供方响应或完整 Evidence 正文。Markdown 报告是从同一次运行派生的精简审查制品。

## 解释

通过证明一个指定模型和 endpoint 在固定受控数据集上满足这些门禁。它不能证明提供方保密性、普遍模型质量、定价或跨 Agent 可用性。人工审查以及独立 Claude Code/OpenCode 验收仍是发布要求。正式 v0.16 结果在 [`remote-extraction-acceptance-v0.16.md`](remote-extraction-acceptance-v0.16.md) 中同时记录在线 harness 和已完成跨 Agent 验收。
