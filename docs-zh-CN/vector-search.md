# 向量与混合搜索

RepoMind 保留 FTS5 作为零配置检索路径。当嵌入提供方和 sqlite-vec 可用时，`repo_memory_search` 和 CLI search 命令使用加权 reciprocal-rank fusion 合并词法与向量排名。任何提供方、配置或扩展错误都会通过 MCP 返回 FTS5 结果和回退原因。

## 提供方

设置 `REPOMIND_EMBEDDING_PROVIDER=deterministic` 可使用离线 feature-hash 提供方。它用于可复现测试和基准，并不是学习得到的语义模型。

为远程 OpenAI-compatible endpoint 设置：

```text
REPOMIND_EMBEDDING_PROVIDER=openai-compatible
REPOMIND_EMBEDDING_BASE_URL=https://api.example.com/v1
REPOMIND_EMBEDDING_API_KEY=...
REPOMIND_EMBEDDING_MODEL=...
REPOMIND_EMBEDDING_DIMENSIONS=1536
```

远程请求会接收已经脱敏的 Memory 标题和内容，不会接收 Evidence 正文或 Git diff。仓库文本是否可以离开本机始终由操作者显式决定：默认不会启用任何远程提供方。

## 缓存生命周期

`memory_embeddings` 是派生数据。行以 Memory ID 为键，并包含提供方模型、维度和内容哈希。搜索会惰性嵌入缺失或过期的行。模型变化后，`repomind vector-reindex` 强制完整重建。嵌入会在写事务开始前计算，因此失败批次不会写入任何内容。Forget 通过 Memory 外键自动删除缓存向量。

使用 `repomind status --json` 检查已配置能力，使用 `repomind doctor --json` 验证平台扩展能否加载。
