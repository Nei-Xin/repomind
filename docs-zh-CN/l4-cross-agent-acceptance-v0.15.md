# RepoMind v0.15 真实跨 Agent 验收

## 结果

2026-07-29 的正式运行针对 RepoMind commit `a45a356125fdd1bb36570b7058d9eca76eccd2db` 通过全部 17 项检查。OpenCode 创建重复的真实 Host-managed 任务 Evidence，Claude Code 独立使用 RepoMind MCP 接口重建、检查、批准、导出并在之后刷新同一个 L4 Candidate。全局 OpenCode 或 Claude 配置均未修改。

制品保存在仓库之外：

```text
D:\data\code\project\repomind-test\v0.15-cross-agent-20260729-01
```

JSON 报告 SHA-256：`25aa967f499019b273b47aa8fb26a3792bcf9f913b5674a7546287d72969ca3b`；Markdown 报告 SHA-256：`2988ef047fb772d422aedcf77fc0793729b3e6f824b5209ec87f287a5c6baaf6`。

## Agent 与生命周期

OpenCode 1.18.7 使用 `cliproxyapi/gpt-5.6-terra` 完成五个成功的真实 Host-managed 仓库任务。五个任务都修改源码或测试，通过目标仓库测试套件，并提交 RepoMind Session。Memory 检索数量从第一次任务的 0 增长为 2、4、5、5。由于宿主负责生命周期，Agent 没有直接调用 RepoMind。OpenCode 使用 28,869 输入 Token 和 3,960 输出 Token。

Claude Code 2.1.220 通过隔离 MCP 配置连接，并使用配置的主模型 `gpt-5.6-luna`。两个 Claude Session 重建并检查 Candidate，批准并导出它，然后在新的匹配 OpenCode 来源到达后再次重建。这证明跨 Agent 操作；配置模型不同，因此不是模型质量对比。

| 阶段 | 状态 | 来源 Session | Evidence link |
| --- | --- | ---: | ---: |
| 三次匹配 OpenCode 运行后生成 | `pending` | 3 | 18 |
| 通过 Claude MCP 审查并导出 | `approved` | 3 | 18 |
| 新匹配 OpenCode 来源后重建 | `pending` | 4 | 24 |

Candidate ID：`l4_8afaea82-2a12-48b2-9dcf-6db8e51f57b0`

Audit 序列：`generated -> approved -> exported -> sources_changed`

Export SHA-256：`b9927e8779be8a5e0ad45c4b50bdba770b6a17ea1f5760c52374d41ac4a721db`

最终目标状态包含六个 Session，其中五个 committed，一个在初始 Windows `.cmd` launcher 出现 `spawn EINVAL` 后被安全 abandoned；还包含 33 条 Evidence、十条 L1 Memory、一个 L4 Candidate、零 open Session 和零 running Host Run。六个目标仓库测试全部通过。导出的 Skill 不包含 credential 或 Windows/Unix 绝对路径。

## 跨平台 CI

[GitHub Actions CI #61](https://github.com/Nei-Xin/repomind/actions/runs/30424663099) 在 release-closure commit `e9b1caf9638fcffd88dab048b421bbf782367e74` 上成功完成。Ubuntu、Windows、macOS、coverage 和 comparison benchmark job 第一次尝试全部通过，workflow 用时 5 分 54 秒。

早期实现 [CI #57](https://github.com/Nei-Xin/repomind/actions/runs/30421126920) 在重新运行一个出现分散 test/hook timeout、但没有 assertion failure 的 Windows 尝试后通过全部五个 job。发布 CI 随后暴露 macOS 上同毫秒 L4 Audit 排序缺陷和另一次缓慢 Windows timeout。Commit `297a9eb` 和 `e9b1caf` 修复排序 tie-breaker，并为常规 SQLite 和子进程测试提供 30 秒 runner allowance。产品性能门禁未变化。CI #61 是两项修复均第一次通过的干净确认。

Coverage artifact SHA-256：`9afc026660ab2c6c38ecd9f1f132b4f5c2f9c72fd6b5a8af1a126f77e919d9d9`

Comparison artifact SHA-256：`58ba7e784d522022c66a4b9d77261b8c1164837905eb9e0bc0d6d333c7b78114`

本地发布基线在 34 个文件中通过 153 个测试。源码覆盖率为 statements/lines 83.48%、branches 77.55%、functions 94.82%。L4 Candidate 实现达到 lines 95.96%、branches 82.70%、functions 100%。

## 解释与限制

- 这是互操作性和生命周期 Evidence，不是 Agent 或模型质量对比。
- 目标是受控真实 Agent 仓库 fixture，不是生产仓库的广泛样本。
- 精确命令集分组会有意排除成功命令不同但语义相似的工作流。因此一个还执行了 `git status` 和 `git diff` 的成功 OpenCode 运行未进入该 Candidate。
- RepoMind 导出可审查 `SKILL.md`，绝不会安装、注册或执行 Skill。
- 初始 launcher 失败、早期 CI 失败及重试仍是可见 Evidence；CI #61 是最终第一次通过。
