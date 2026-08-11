# ADR-010：只执行预定义的只读 Git 命令

状态：accepted

## 背景

RepoMind 通过调用 Git 收集 Evidence。接受任意参数会把记忆工具变成命令执行入口，任何会修改状态的 Git 命令也可能破坏用户工作。

## 决策

Git inspector 只执行固定的只读命令集合（`rev-parse`、`branch --show-current`、`status`、各种 `diff`、以及用于计算空树哈希的 `mktree`），并设置超时和输出上限。除经过验证的路径外，任何用户或模型输入都不会拼接进 Git 参数。敏感路径在 pathspec 层面就会从 diff 捕获中排除。

## 后果

- RepoMind 绝不会对仓库执行 commit、push、checkout、reset 或 clean。
- 大型 diff 会以明确标记截断，而不是无限流式传输。
- diff 捕获会排除 `.env*`、密钥材料和 `.npmrc`，并记录被排除的文件。
