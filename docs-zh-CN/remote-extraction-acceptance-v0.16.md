# RepoMind v0.16 远程提取验收结果

## 结果

干净 commit 的在线验收于 2026-07-29 使用 OpenAI 兼容端点来源
`https://sub2api.zzii.de` 和模型 `gpt-5.6-terra` 通过全部 13 项门槛。
目标检出和实现均固定在 commit `eae96bcc78e2cc4b30bf9048cd1ae8ec2296d7e2`，
报告记录 `sourceWorktreeDirty: false`。

API 凭据仅存在于验收进程的环境中。进程结束后凭据即被移除，且未出现在 Git、
固件、stdout 和两份报告中。运行器还扫描了序列化 JSON；如果其中出现凭据值，
它会拒绝写入文件。

## 结果数据

| 指标 | 结果 | 门槛 |
| --- | ---: | ---: |
| 正向场景 Recall | 1.000 | 至少 0.800 |
| Candidate 精确率 | 1.000 | 至少 0.750 |
| 空结果/注入准确率 | 1.000 | 恰好 1.000 |
| 当前 Session Evidence 绑定 | 1.000 | 恰好 1.000 |
| 提取 Audit 绑定 | 1.000 | 恰好 1.000 |
| 延迟 P50 | 9,565 ms | 记录值 |
| 延迟 P95 | 12,669 ms | 小于 120,000 ms |
| 输入 Token | 7,584 | 提供商报告值 |
| 输出 Token | 1,083 | 提供商报告值 |

六个正向事实分别产生一个相关 Candidate。独立重复实验产生一个 Candidate，
但未存储第二条 Memory；它将新的 Evidence 和 Audit 来源链接到现有的置信度策略
Memory。表面修改和 Prompt Injection Session 均返回空 Candidate 批次。
格式错误的输出、伪造的 Evidence 和取消操作均被拒绝，Memory、Evidence 链接和
Audit 写入数都为零。SQLite 完整性返回 `ok`，外键无违规，也没有 Session 保持打开。

人工审查认为以下 Candidate 标签和标题适合其受控 Evidence：

| 场景 | 类型 | 标题 |
| --- | --- | --- |
| 存储事务 | `architecture` | Storage transaction boundary |
| MCP stdout | `requirement` | Reserve stdout for MCP JSON-RPC |
| 两阶段提取 | `decision` | Run remote extraction after commit |
| 验证后的输出 | `decision` | Validate model candidates before persistence |
| 远程隐私 | `requirement` | Remote extraction privacy boundary |
| 置信度上限 | `requirement` | Cap remote extraction confidence at 0.9 |

## 验收驱动的修复

第一次干净的在线运行以验收运行器 commit
`e3cb54ef6a3380a6020f1dfe31141328911e20e4` 为目标。质量、空结果、Evidence、
Audit、安全、延迟、用量和数据库门槛全部通过，但整体验收失败，原因是重复事实
第一次被分类为 `decision`，第二次被分类为 `requirement`，措辞也有细微变化。
基于精确类型/内容指纹的方式存储了两条语义等价的 Memory。

Commit `eae96bc` 增加了保守的跨运行等价判断：标题和作用域必须完全匹配，
规范化内容的相似度必须较高，且数字集合与否定关系必须一致。变化的限制值和相反
声明仍保持独立。第二次在线运行随后成功去重该重复 Candidate，并通过全部门槛。
失败的运行被保留下来，因为它证明运行器发现了真实的产品缺陷，而不只是确认其固件。

## 来源信息

产物保留在仓库外部：

```text
D:\data\code\project\repomind-test\v016-remote-live-eae96bc
```

- JSON 报告 SHA-256：
  `f2267d7ceef9acf960e6bba97c3a48d1ef78018ab9c7dd089cb2e793a068f71d`
- Markdown 报告 SHA-256：
  `c32e8fec6783fbb891893f8b500f9ef1f3a4dfb02ccb302551994affe412b383`
- 报告记录的数据集 SHA-256：
  `f477202cad5b9a907e11f3bfb367b079084faaa85b1d41521aa8ac74a3390c88`
- 报告记录的运行器 SHA-256：
  `eabc210759ab4f5334deb97818f27f86ca21f78ab9ba22d6fcd7331e1328a80a`

失败的首次运行产物保留在
`D:\data\code\project\repomind-test\v016-remote-live-e3cb54e`；其 JSON 报告
SHA-256 为
`5f98aa7885c87eacf6bbf30ed8b87b2744c35a569ac938c38d2d75fd2246cc09`。

通过的运行使用 Windows 10.0.26200、Node.js 22.20.0 和 AMD Ryzen 7 H 255
处理器。它完成了九次远程调用，包括构建、克隆、Session 设置、本地探测和报告，
总耗时 101.6 秒。

## 跨 Agent 连续任务

另一项真实 Agent 验收于 2026-07-29 在已推送的干净 commit
`d00adf10d7444ea27aa6ebce9a21cb61d52b5e9e` 上通过全部 17 项门槛。
Claude Code 2.1.220 通过隔离的 RepoMind MCP 配置使用其已配置的
`gpt-5.6-luna` 模型。它实现并从外部验证了仓库范围内具有幂等性的库存预留，
随后提交 Session `ses_fd70d0d6-c38e-4d1d-9e8b-810f8268a489`。
第二个仅使用 MCP 的 Claude 进程显式调用了远程提取、搜索和 Inspect。

在线 `gpt-5.6-terra` 提取调用用时 17,814 ms，使用 2,503 个输入 Token 和
569 个输出 Token，并存储三条已验证的 L1 Memory。检查的 Memory
`mem_0ef3d816-cb1b-4dd9-a7e7-3d22441711ec` 保留 Claude Session 中的
`git_diff` 和成功的 `test_result` Evidence。其 Audit 记录了 `remote-llm`、
提供商 `openai-compatible`、模型 `gpt-5.6-terra` 和源 Session ID。

随后，OpenCode 1.18.7 通过宿主管理的 `repomind run` 日常入口，使用
`cliproxyapi/gpt-5.6-terra` 和全新的模型上下文执行相关发布任务。RepoMind 在
Agent 执行前检索到五条 Memory；上述被检查的远程 Memory 排名第一。任务刻意省略
幂等性作用域，但 OpenCode 应用了记忆中的 `${warehouseId}:${requestId}` 约定。
它在 Agent 侧的 RepoMind 调用为零，正常退出，宿主提交了 Session。全部九项仓库
测试和一项外部隐藏发布检查均通过。最终状态包含两个已关闭 Session、16 条 Evidence、
八条 Memory、一个已完成宿主运行、零个打开的 Session 和零个运行中的宿主运行。

产物保留在仓库外部：

```text
D:\data\code\project\repomind-test\v016-cross-agent-d00adf1-02
```

- JSON 报告 SHA-256：
  `471cc6aa653960ad585712783357837f03a6d589761edbb7dc8ec6d933bb08e6`
- Markdown 报告 SHA-256：
  `5a136b9e8f85ffc9c65278124a884effee58e7f5edb359ef9cee4ffdfabe0cab`

第一次跨 Agent 尝试单独保留在
`D:\data\code\project\repomind-test\v016-cross-agent-d00adf1`，不计入结果。
其 PowerShell 启动器只传递了多行 Claude Prompt 的第一个单词，因此 Claude 没有
收到固定任务，从未调用远程提取，OpenCode 也未启动。Attempt 02 通过 stdin 传递
Prompt，并在 JSON 报告中保留修正后的 Prompt 和事件哈希。

## 跨平台 CI

[GitHub Actions 运行 30431838774](https://github.com/Nei-Xin/repomind/actions/runs/30431838774)
在同一 `d00adf1` commit 上成功完成。Ubuntu、Windows、macOS、覆盖率和完整对比
基准 job 均首次通过。工作流用时 5 分 15 秒。

在线阶段结束后，临时提取凭据已移除。对两个跨 Agent 尝试目录的结构化扫描发现，
除不透明的加密 Agent 签名字段外，类似凭据的值为零。仓库和正式报告均未保留凭据值。

## 限制

本结果证明一个模型、端点、受控数据集、机器和单次运行满足所述质量和安全门槛，
并证明 Windows 上一次受控的 Claude Code 到 OpenCode 连续任务。它不比较 Agent
或模型质量，不证明提供商保密性，也不建立通用的仓库质量结论。端点报告了 Token
用量，但未提供价格表，因此本结果不声明货币成本。
