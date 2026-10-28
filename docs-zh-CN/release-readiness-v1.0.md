# RepoMind v1.0 发布就绪情况

## 当前决策

当前源码准备发布 **`v1.0.0-rc.3`**。截至 2026-10-29，GitHub 最新发布版仍为
`v1.0.0-rc.2`，RC.3 标签尚不存在。本文记录准备状态，不表示已经发布或通过跨平台 CI。

RC.3 在此前候选版范围上增加 Claude Code、OpenCode、Pi、Codex CLI、Gemini CLI
原生接入及 Schema 12 活动记录，因此此前 RC.1/RC.2 的功能冻结说明不再代表本次范围。
历史 28/28 产品标准验收不能替代这些新接入的独立验证。稳定版仍须满足下方晋级条件。

## RC.3 范围与兼容性

- 本地单用户、仓库范围的 L0 活动与证据、L1 记忆、L2 模块叙述、L3 仓库概况，
  以及仅供审阅的 L4 Skill 候选；支持确定性提取、可选远程提取与混合向量搜索。
- CLI、24 个 MCP 工具、OpenCode/Claude 宿主管理运行，以及五种客户端的原生自动召回和活动采集。
- 受认证保护的本地 Bridge、显式替换语义的逻辑导入、同 Project ID 物理恢复和可选归档加密。
- 不包含云同步、多用户服务、任意宿主工具自动观察、自动安装 Skill 或活动数据库加密。

| 接口面 | RC.3 契约 |
| --- | --- |
| 运行时 | Node.js 22.5+ 与 Git |
| 数据库 | Schema 12，保留历史 Migration 哈希 |
| 逻辑归档 | 写 format 2、读 format 1/2；验证具体 Schema 与字段 |
| 物理备份 | Format 1，同 Project ID，恢复前保留快照 |
| 加密 | Envelope format 1，AES-256-GCM 与 scrypt，显式启用 |
| 平台 | 发布前须通过 Linux、Windows、macOS CI；原生客户端实测范围另行说明 |

RC.2 与 v0.18 使用 Schema 11；RC.3 打开旧仓库时应用 Migration 12。升级前使用旧版
备份，不应再用 RC.2 打开迁移后的数据库。归档格式版本不变不等于支持向旧程序降级导入。

## 当前验收证据

最终运行时代码提交为 `2dc602d`。2026-10-28 在用户指定的 Debian 13.7 x86_64
服务器完成 build、typecheck 和 75 个文件中的 **901 项测试**，2 项 Windows 专项跳过。
提交前通过 SHA-256 比对确认服务器测试源码与本地修改一致。

真实 npm 打包后的全局安装、符号链接入口和重复 setup 通过。Gemini CLI 0.66.0 的
原生 TUI 实测覆盖多轮召回、取消后继续、按原 ID 恢复会话、强杀 Bridge 后自动恢复，
以及通过全局命令停止恢复后的 Bridge。最终一轮 5 个任务 committed，1 个 abandoned。
Pi 1.4.0、Codex CLI 0.165.0 的原生和跨 Agent 验收已单独完成。

- [Pi / Codex 验收记录](pi-codex-validation.md)
- [Gemini CLI 验收记录](gemini-validation.md)
- [历史 RC.2 包验收](../docs/release-audit-v1.0.0-rc.2.md)

模型使用用户指定的 GPT 中转；Gemini 通过临时外部协议转换器调用。未验证 Gemini
官方模型端点或上游逐 token 流式行为。测试服务与临时 Key 均已清理。

2026-10-29 同服务器另行通过 Agent 固件、跨会话固件、分层消费固件及全新工作区中的
17 项安装包验收。报告保留于 `/home/debian/repomind-validation/rc3-package-smoke`，
对应固件日志位于父目录中的 `rc3-*-fixtures.log`。

服务器结果不能替代 PR、合并后 main 和标签 CI。当前 CI 包含三平台检查、MemoryProxy
Node 22/24、覆盖率及完整对比基准；Release 工作流另外验证回归、Agent/跨会话/分层
固件及安装包后才生成产物。

## RC.3 发布门槛

1. 版本元数据、CLI/MCP 版本、Changelog 和说明一致为 `1.0.0-rc.3`，当前 Migration 为 12。
   历史发布 Schema 清单必须保留 RC.1/RC.2 → Schema 11 的不可变映射。
2. 推送审阅后的分支，创建到 main 的 PR，最终 PR 提交通过全部配置的 CI。
3. 合并后验证实际 main 提交的 CI，不能用其他分支或较早服务器结果替代。
4. 确认标签未使用后，在已验证的 main 提交上创建附注标签 `v1.0.0-rc.3`。
5. 标签 CI 与 Release 工作流均通过；下载并核验 tarball 和 `SHA256SUMS`，补充准备好的
   发布说明后，才宣布发布完成。发布标签及产物不覆盖、不移动。

现有工作流只创建 GitHub 预发布版，不发布 npm Registry。npm 上的无作用域名称
`repomind` 属于其他发布者，应使用本项目 GitHub 产物或源码。如需发布 Registry，
必须另选具有所有权的包名并配置独立流程。

## 稳定版晋级与回滚

- 至少连续七天 RC 使用，无未解决的 P0/P1 正确性、数据安全、安装、升级或恢复缺陷。
- 至少两个真实仓库连续使用，Claude 与 OpenCode 均参与，无无法解释的打开任务。
- 完成全新安装、历史升级、明文和加密恢复，以及认证失败零写入和临时文件清理验证。
- 最终提交与标签通过全部配置的 GitHub CI，发布说明明确兼容性、安全边界、恢复方式和限制。

P0/P1 修复重置稳定期并产生新的候选版；未知或豁免的门槛不能算通过。
失败发布保持不可变，修复使用后续版本。保留升级前备份，未测试的降级路径不受支持。

英文规范及历史 RC.1/RC.2 证据见 [发布就绪文档](../docs/release-readiness-v1.0.md)。
