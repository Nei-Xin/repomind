# ADR-007：项目 UUID 保存在仓库中，数据保存在用户目录中

状态：accepted

## 背景

Memory 必须能随项目跨克隆和工作目录复用，但记忆数据库包含执行追踪和可能的敏感片段，绝不能提交到版本库。

## 决策

`repomind init` 只在仓库中写入 `.repomind/project.json`（稳定 UUID 和名称），可以安全提交。全部数据保存在 `~/.repomind/repositories/<projectId>/repomind.db`，也可以通过 `REPOMIND_DATA_DIR` 覆盖。分叉项目可通过 `init --new-id` 获取新身份。

## 后果

- 同一台机器上的同一项目的两个 checkout 共享同一个记忆数据库。
- 数据库不会出现在 `git status` 中，敏感内容不会被意外提交。
- checkout 路径记录在 `repository_checkouts` 中，因此能够识别路径移动。
