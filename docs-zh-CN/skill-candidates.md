# L4 Skill Candidate（技能候选项）

RepoMind v0.15 加入产品模型的最终记忆层：从重复成功的仓库工作派生、需要审查的工作流 Candidate。Candidate 是有 Evidence 支持的知识，不是可执行自动化。

## 生成契约

运行：

```bash
repomind skill-rebuild --json
```

默认生成器要求至少三个不同 Session。Session 只有处于 `committed` 且包含至少一个成功 `command_result` 或 `test_result` 时才合格。生成器按标准化后的成功命令集和测试集对 Session 分组。匹配刻意保持严格和确定性；v0.15 不声称能够推断语义等价的自然语言工作流。

以下输入绝不合格：

- `partial`、`failed` 或 `abandoned` Session；
- 没有命令或测试 Evidence 的成功 Session；
- 在少于三个成功 Session 中出现的工作流；
- 成功命令集或测试集不同的工作流。

每个 Candidate 包含触发条件、通用输入、有序步骤、验证命令、作为风险的已观察失败，以及到每个来源 Session 和 Evidence 的直接链接。来源不变时重建为 no-op。出现另一个匹配 Session 时，Candidate 会更新，之前的批准会重置为 `pending`。

成功的 `repomind run` Host Commit 会在 L2 和 L3 维护后同步调用该生成器。它使用相同资格契约创建或刷新需要审查的 Candidate。partial、failed 和 abandoned Run 不触发 L4 维护；生成器错误会独立记录，不回滚 committed Session，也不改变 Host-run 成功状态。

该自动生成只属于 Host-managed 生命周期。`skill-rebuild` 和 `repo_skill_candidate_rebuild` 仍然可用；Agent-managed Session、直接 CLI/MCP Commit 和直接 Core Commit 必须显式请求 Candidate rebuild。

## 人工审查

```bash
repomind skills --status pending --json
repomind skill-inspect l4_... --json
repomind skill-review l4_... --action approve --reason "Reviewed commands, verification, and risks" --json
```

Candidate 状态为：

```text
generated -> pending
pending -> approved
pending -> rejected
approved/rejected -> pending  (source set changed)
```

每次转换都会被 Audit。审查原因必填，并使用与其他长期数据相同的 Secret 脱敏规则。已审查 Candidate 在新来源重新打开之前不能再次审查。

自动维护止于 Candidate 的生成或刷新。RepoMind 永远不会自动 approve 或 reject Candidate，也不会自动 export、install、register 或 execute。

## 安全导出

```bash
repomind skill-export l4_... --output ./review/SKILL.md --json
```

只有 `approved` Candidate 才能导出。输出必须是现有目录中的新 `.md` 文件。RepoMind 拒绝覆盖文件，脱敏 Secret 模式和绝对路径，将 SHA-256 写入 Audit；如果 Audit 持久化失败，还会删除刚写出的文件。

导出文档包含标准 Skill frontmatter，以及 Inputs、Steps、Verification、Risks 和 Provenance 部分。导出不会把文件复制到 Agent 配置目录、向客户端注册、安装或执行任何命令。这些仍是 RepoMind 之外、由用户显式控制的操作。

## MCP 工具

以下工具提供相同语义：

- `repo_skill_candidate_rebuild`
- `repo_skill_candidate_list`
- `repo_skill_candidate_inspect`
- `repo_skill_candidate_review`
- `repo_skill_candidate_export`

Candidate ID 受仓库 scope 限制。MCP 重启后，请为 inspect、review 和 export 调用传入 `repo_path`。

## 当前限制

确定性 signature 以召回率为代价，优先保证精度和可审计性。它不会合并 `npm test` 与 `npm run test` 之类的别名、按语义重新排列多步骤流程、推断缺失输入或请求远程模型合成文字。这些是未来远程 LLM 适配器的评估输入，而不是削弱 v0.15 Evidence 门禁的理由。
