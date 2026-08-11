# 远程 LLM Memory 提取

远程提取是 Session 提交后的显式、可选第二阶段。确定性提取仍保持启用且行为不变。RepoMind 绝不会在 `start` 或 `commit` 时调用远程模型。

## 配置

使用独立于可选嵌入提供方的 OpenAI-compatible 配置：

```text
REPOMIND_EXTRACTION_PROVIDER=openai-compatible
REPOMIND_EXTRACTION_BASE_URL=https://api.example.com/v1
REPOMIND_EXTRACTION_API_KEY=...
REPOMIND_EXTRACTION_MODEL=...
REPOMIND_EXTRACTION_TIMEOUT_MS=60000
```

Timeout 可选，必须在 1,000 到 300,000 毫秒之间。`repomind status` 和 `repomind doctor` 会报告是否已配置远程提取，但绝不报告 API key。

先 commit，再从已完成 Session 显式提取：

```bash
repomind commit --session ses_... --key task-1 --summary "Completed and tested" --json
repomind extract --session ses_... --json
```

MCP 客户端使用 `repo_memory_extract`，传入 `session_id`；服务器重启后还要传入 `repo_path`。

## 安全边界

请求包含已完成 Session 中已经脱敏的任务和 Evidence（摘要、有界 Git 数据、测试和命令），包括 Evidence ID 和元数据。每条 Evidence 正文上限为 12,000 字符，批次上限为 60,000 字符。仓库内容会被包装成不受信任的数据，system prompt 禁止遵循其中出现的指令。

这是对提示注入的防御，不是保密保证。脱敏基于模式，已配置提供方会接收仓库数据。请检查提供方的数据保留政策，不要为政策禁止数据传输的仓库启用远程提取。

模型必须返回严格 Candidate 对象。打开写事务之前，RepoMind 会使用 Zod 和确定性规则验证完整批次：

- 每个 Candidate 至少引用一个本次请求提供的 Evidence ID；
- 伪造和重复 Evidence ID 会被拒绝；
- confidence 不超过 `0.9`；
- repository scope 不带值，module/path scope 必须带相对于仓库的值；
- 相关文件和 scope 路径不能越出仓库；
- Candidate、tag、file 和 batch 大小都有上限。

一项无效 Candidate 会拒绝整个批次。超时、取消、拒绝、畸形 JSON、schema 失败和 Evidence 失败不会写入任何 Memory、Evidence 链接或 Audit。验证通过后，整个批次使用一个 SQLite 事务，并复用现有 fingerprint 去重、Evidence 关联、冲突检测、文件哈希、脱敏、FTS 索引和 Audit 路径。Audit 保存提取模式、提供方、模型和来源 Session ID，绝不保存 API key；去重后只增加新 Evidence 的 Candidate 也会进入 Audit。

跨运行的模型措辞/类型漂移只有在标题和 scope 完全匹配、标准化内容相似度较高、数字值和否定关系一致时才会去重。这样，限制值变化和相反声明仍会进入正常的 conflict/governance 路径。

## 不提供的能力

远程提取不会自动观察宿主工具、替代确定性提取器、安装或执行 L4 Skill，也不会使模型输出变得可信。它创建的是由现有 Session Evidence 支持、受治理的 L1 Candidate。v0.16 真实提供方的质量、Token、跨 Agent 和 CI Evidence 记录在 [`remote-extraction-acceptance-v0.16.md`](remote-extraction-acceptance-v0.16.md)。提供方返回了 Token 数量但没有价格表，因此报告不声明远程提取的货币成本。
