# Pi / Codex 原生接入验收记录

日期：2026-10-28。测试运行于用户指定的 Debian 服务器，使用隔离目录
`/tmp/repomind-pi-codex`，未修改服务器上的业务项目。

环境：Node.js 22.23.4、Pi 1.4.0、Codex CLI 0.165.0。
两端都使用用户指定中转服务的 `gpt-6.1-sol`，通过原生 Responses 配置调用；
RepoMind 不代理或转换模型协议。API Key 不进入源码和验收产物。

## 自动化检查

- 构建及最终 typecheck 通过。
- 全量回归：74 个测试文件通过，889 项通过，2 项 Windows 专项跳过。
- 此后新增错误/截断和子 Agent/重复事件两项测试；最终原生适配专项共 9 项全部通过。
- 覆盖跨 Agent 召回、明确退出码、未知或失败测试、取消、旧回合事件拒绝、
  Pi 最终 settled 边界、重试、会话关闭、敏感文件输出过滤、Bridge 故障降级、
  安装幂等、迁移路径及保留用户配置。

首次全量运行有四项依赖 Git 元数据的测试失败，原因是远端源码通过 tar 复制，
没有 `.git`。创建隔离的验证仓库并保存源码快照后，全量重跑通过。

## 原生客户端真实调用

| 场景 | 结果 |
| --- | --- |
| Pi 原生运行前召回 | 模型读到仅存在于记忆库的标记 `MAGNOLIA-7264` |
| Pi 自动记录 | 执行 `node --test smoke.test.mjs`，结构化退出码 0；生成验证命令记忆 |
| Pi → Codex | Codex 无需搜索文件即可读到上述标记和验证命令 |
| Codex 原生保存 | 用 apply_patch 创建说明文件，任务 committed，生成可复用解决方案 |
| Codex → Pi | Pi 不读文件即可召回 Codex 保存的说明和 `COPPER-5931` |
| 原生交互多轮 | 两个客户端在各自 TUI 中继续对话，事件按会话归属 |
| 取消 | 两端运行 `sleep 60` 时按 Escape，任务 abandoned；只有开始时的需求/快照证据，没有完成证据 |
| 取消后继续 | 两端下一轮正常召回并完成任务 |
| Bridge 强杀 | 对测试 Bridge 执行 SIGKILL，两个客户端随后提交请求，服务恢复且任务完成 |
| 会话恢复 | 关闭后用原生会话 ID 恢复，两端继续召回；新任务仍绑定原生会话 ID |
| 重复验证 | Pi 再次执行相同测试，验证命令记忆仍只有一条 |

Codex 自动化验收在隔离仓库中使用其官方单次 Hook trust bypass 参数，
仅加载本次检查过的 RepoMind Hooks；产品 setup 不写入该参数或修改信任数据库。
正常使用需要用户通过 `/hooks` 信任定义。桌面端、云端和 Windows 原生运行不在此次实测范围。

## 确认的 Codex 接口限制

Codex 0.165.0 的 Bash PostToolUse 输入中，`tool_response` 是 stdout 文本。
实际执行失败（退出 127）和成功（退出 0）都没有向 Hook 提供退出码。
因此两类测试任务都保守处理为 partial，不依据文本或最终回答生成验证证据。
适配器把原始文本包裹为输出字段，防止文本中的 `exit code 0` 被通用解析器误认。

这是原生 Hooks 能力限制。没有通过不稳定 transcript、改写 shell 命令或重复执行
测试来补造证据。Codex 的召回、普通操作记录、文件变更记忆、取消和恢复正常工作。

## 产物与清理

服务器验证目录保留 `validation-summary.json`、`tui-validation.json`、
`full-tests-current.log`、`native-tests-final.log` 和构建/类型检查日志。
测试客户端和 RepoMind Bridge 已停止，临时 API Key 文件已删除。

使用说明：[Pi](pi-integration.md)、[Codex](codex-integration.md)。
