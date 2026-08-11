# RepoMind v1.0 发布就绪情况

## 决策

`v1.0.0-rc.1` 是 RepoMind 本地单用户产品功能冻结后的发布候选版。
`REPOMIND_FINAL_PRODUCT_SPEC.md` 第 24 节的全部 28 项最终产品标准都具备实现
和保留的验收证据。该 RC 仅变更发布元数据和文档；与 v0.18.0 相比，
不会改变产品行为、存储、协议或归档格式。

RC 期间，只有会阻塞发布的正确性、数据安全、安全性、安装、兼容性和文档缺陷
可以导致产品变更。新功能移至后续版本。

## 冻结的产品范围

v1.0 Candidate 包含：

- 仓库范围、具备 Evidence 支持且支持确定性提取的 L1 Memory；
- 可选的已验证远程 LLM 提取和可选的混合向量搜索；
- 受治理的验证、纠正、失效、冲突、过期和物理遗忘工作流；
- 确定性的 L2 Module Narrative、L3 Repository Profile，以及仅供审查的
  L4 Skill Candidate；
- 已使用 Claude Code 和 OpenCode 测试的 CLI 及 24 个 MCP 工具；
- 宿主管理的 OpenCode 生命周期、运行产物和可复现实验；
- 仅替换的逻辑导入、同 Project ID 物理恢复，以及可选的加密逻辑和物理归档；以及
- 版本化 Migration、包、规模、跨平台和恢复证据。

以下内容仍不属于 v1.0：逻辑合并导入、自动观察任意宿主工具、自动安装或执行 Skill、
云同步/上传、多用户服务运行、远程恢复工具，以及活动本地 SQLite 数据库加密。

## 兼容性契约

| 接口面 | v1.0 RC 契约 |
| --- | --- |
| 运行时 | Node.js 22.5 或更高版本，以及 Git |
| 操作系统 | 通过 GitHub CI 矩阵支持 Windows、Linux 和 macOS |
| 数据库 | Schema 11；从 v0.4.0 起的每个已发布 Schema 均可通过不可变的 Migration 哈希升级 |
| 逻辑导出 | 写入 format 2，读取 format 1 和 2；导入仍为显式替换语义 |
| 物理备份 | Format 1；恢复要求相同 Project ID，并保留回滚快照 |
| 加密 | 使用 AES-256-GCM 和 scrypt 的 Envelope format 1；默认仍为明文 |
| CLI 和 MCP | 现有命令、JSON 字段、错误码及 24 个注册 MCP 工具构成 v1.0 兼容性基线 |
| 提供商 | 确定性提取和 FTS 仍是默认值；远程 LLM、Embedding 和加密均需显式选择启用 |

`v1.0.0-rc.1` 映射到 Schema 11。从 v0.18.0 升级不需要 Migration 或归档转换。
未来不兼容的 CLI 或 MCP 变更需要发布主版本，或提供有文档说明的兼容期；
补丁版本必须继续能够打开所有已发布数据库。

## 证据基线

| 门槛 | 保留证据 | 状态 |
| --- | --- | --- |
| 最终产品标准 | `docs/final-spec-audit-v0.16.md` 及 `docs/final-spec-audit-v0.17.md` | 28/28 完成 |
| 外部跨 Session 收益 | `docs/external-open-source-cross-session-acceptance-v0.17.md` | 完成 |
| 已安装包和历史升级 | `docs/release-readiness-v0.17.md` | 完成 |
| 10,000 条 L1 规模 | `docs/scale-acceptance-v0.14.md` | 完成 |
| 真实跨 Agent 生命周期 | `docs/l4-cross-agent-acceptance-v0.15.md` 和 `docs/remote-extraction-acceptance-v0.16.md` | 完成 |
| 加密可移植性 | `docs/encrypted-portability-v0.18.md` | 29/29 项门槛完成 |
| v0.18 发布标签 | 针对 `v0.18.0` / `60c8a29` 的 GitHub Actions 运行 `30468234422` | 五个 job 通过 |

v0.18 标签运行于 2026-07-30 完成，用时 7 分 17 秒。Ubuntu、Windows、macOS、
源码覆盖率和对比任务全部通过。每个平台还运行了已安装 tarball 验收，包括加密
导出、导入、备份和恢复。

## 本地 RC 准备结果

2026-07-30 的 Windows 准备运行使用 Node.js 22.20.0。类型检查和构建通过，
39 个文件中的全部 174 项测试通过，15 项针对版本/Migration/MCP 契约的测试通过，
全部八个 Agent 固件也按预期的公开和隐藏基线验证成功。

已安装 tarball 验收使用 `repomind@1.0.0-rc.1` 通过全部 14 项检查。
包含 253 个文件的包不含禁止的数据库、本地配置、顶层测试或覆盖率文件。已安装的
CLI 和全部 24 个 MCP 工具完成明文及加密的生命周期/恢复检查，且未留下打开的
Session。

产物保留在仓库外部：

```text
D:\data\code\project\repomind-test\v100-rc1-package-precommit-20260730-01
```

- tarball SHA-256：
  `47ecf7cf5d8ec0e8530014c2e6dce4db71eac79c21cd3feec1651407547710d6`
- 包报告：`package-smoke-report.json`

这是对元数据和文档工作树的提交前验证，不能替代必需的干净 commit 主分支和标签
CI 运行。

## RC 创建门槛

创建 `v1.0.0-rc.1` 标签前：

1. RC 准备 commit 必须干净，且不包含产品行为变更；
2. 包元数据、CLI 横幅、MCP 握手、Changelog 和已发布 Schema 固件必须就
   `1.0.0-rc.1` 与 Schema 11 达成一致；
3. 本地类型检查、构建、完整回归、版本/Migration 测试及包内容检查必须通过；
4. 准备 commit 的第一次干净推送必须通过 Ubuntu、Windows、macOS、覆盖率和
   对比 job；以及
5. 只有在此之后才可创建并推送附注标签 `v1.0.0-rc.1`，随后独立的标签触发五 job
   CI 也必须通过。

在所有门槛中，密码和提供商密钥始终仅存在于环境变量。验收工作区保留在仓库外部的
`D:\data\code\project\repomind-test` 下。

## 稳定版晋级门槛

从 RC 晋级到 `v1.0.0` 需要满足以下所有条件：

- RC 至少连续使用七天，期间没有未解决的 P0 或 P1 正确性、数据丢失、安全、
  安装、升级或恢复缺陷；
- 在至少两个真实仓库中执行连续任务，Claude Code 和 OpenCode 均参与，
  且不存在无法解释的打开 Session 或宿主运行；
- 使用打包产物执行全新安装和 v0.18 到 RC 的升级检查；
- 执行明文和加密的逻辑/物理恢复检查，验证认证失败零写入行为和临时明文清理；
- 最终干净 commit 和附注标签通过相同的五个 GitHub CI job；以及
- 发布说明列出冻结的兼容性契约、安全边界、支持的运行时、恢复流程和推迟的功能。

任何 P0 或 P1 修复都会重置稳定期，并产生后续 RC。低严重性的文档修正如果不会
影响运行时、存储数据、协议、安装或恢复，则不重置稳定期。

## 回滚与发布纪律

当某项门槛状态未知或被豁免时，不得晋级 RC。失败的 RC 保持为不可变标签；
修复应发布为 `v1.0.0-rc.2`，而不是移动原标签。运维人员可以恢复保留的恢复前
快照或已验证的 v0.18 备份，但除非特定降级路径已经过测试，否则绝不能使用旧代码
打开 v1.0 数据库。RepoMind 不承诺降级兼容性。
