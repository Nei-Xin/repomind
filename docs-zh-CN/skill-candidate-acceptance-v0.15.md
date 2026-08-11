# RepoMind v0.15 L4 Skill Candidate 验收

## 目标

验收 runner 验证完整 L4 边界：重复成功的仓库工作流成为有 Evidence 支持的 Candidate，由人类控制审查，只有批准后的 Candidate 才能导出供外部检查。RepoMind 不安装或执行导出的 Skill。

## 运行

每次运行都使用新 workspace。Runner 拒绝覆盖现有路径，并将全部 RepoMind 状态保存在该 workspace 下。

```powershell
npm run bench:l4-real -- `
  --repo D:\data\code\project\repomind `
  --workspace D:\data\code\project\repomind-test\v0.15-l4-<new-id> `
  --commit <full-commit> `
  --repeat 20
```

Workspace 会收到 `l4-skill-candidate-report.json`、可读 Markdown 报告、已批准 `SKILL.md` 和逻辑仓库导出。

## 硬门禁

除非以下边界全部成立，否则运行失败：

- 两个匹配成功 Session 不产生 Candidate，三个则产生一个；
- partial、failed、abandoned 和无命令 Session 不合格；
- 每个 Candidate 都可追溯到其 Session 和 Evidence 来源；
- 显式批准前阻止导出；
- review 和 export 均进入 Audit，导出内容不包含提供的 Secret 或绝对路径；
- 第四个匹配来源使此前批准失效；
- 显式逻辑导入前，Project ID 保持隔离；
- 逻辑导入保留 Candidate ID、状态、Session 和 Evidence；
- SQLite integrity、外键和 closed-Session 不变量通过；
- 在测量机器上，Candidate rebuild、list、inspect P95 均低于两秒。

## 解释

这是确定性、固定 commit 的产品验收。它使用与 Agent 工作流相同的公开 Session、Candidate、review、export 和 portability API。独立的真实 OpenCode/Claude 验收覆盖真实跨 Agent 使用，不改变这些确定性门禁。精确的标准化成功命令和测试 signature 有意优先 Candidate precision，而不是模糊 recall。

## 正式发布 Evidence

2026-07-29 最终干净 commit Windows 运行通过全部 20 项门禁，包含四个成功来源 Session、四个有意排除 Session、一个 Candidate 和 28 个保留 Evidence link。Runner 和目标 checkout 固定在 commit `e9b1caf9638fcffd88dab048b421bbf782367e74`，报告记录 `sourceWorktreeDirty: false`。

制品保存在：

```text
D:\data\code\project\repomind-test\v0.15-l4-20260729-04
```

JSON 报告 SHA-256：`a7448322b3ac41a406a19ba4d0c0eb4479ee42ae866843fd6c50cfca96151858`；Markdown 报告 SHA-256：`bb72b54fa720e9f008e61e802edc6066d82d1ba6eab67bb78cbfc01737230130`。

| 操作 | 样本 | P50 ms | P95 ms | 最大值 ms |
| --- | ---: | ---: | ---: | ---: |
| Candidate rebuild | 20 | 0.429 | 0.596 | 1.040 |
| Candidate list | 20 | 0.035 | 0.115 | 0.141 |
| Candidate inspect | 20 | 0.174 | 0.201 | 0.243 |

该确定性运行证明 L4 产品边界和测得的本地延迟。独立的 [`l4-cross-agent-acceptance-v0.15.md`](l4-cross-agent-acceptance-v0.15.md) 记录真实 OpenCode/Claude 生命周期和跨平台 CI Evidence。
