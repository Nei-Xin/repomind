# 故障排查

首先运行 `repomind doctor --json`。它会报告 Node 版本、SQLite 和 FTS5 可用性、Git 能否从当前目录解析出仓库根目录，以及该仓库是否已初始化。

## 错误码

每种失败都会返回稳定错误码，因此客户端可以按错误码分支，而不必解析自然语言文本。

| 错误码 | 含义 | 修复方法 |
| --- | --- | --- |
| `REPOSITORY_NOT_INITIALIZED` | 仓库根目录中没有 `.repomind/project.json` | 在该目录运行 `repomind init` |
| `NOT_A_GIT_REPOSITORY` | 路径无法解析到 Git 根目录 | 在仓库中运行，或传入 `--repo` / `repo_path` |
| `PATH_OUTSIDE_REPOSITORY` | 路径越出了仓库根目录 | 使用相对于仓库的路径 |
| `SESSION_NOT_FOUND` | 该仓库中不存在此 Session ID | 检查 `repomind sessions`；Session 只属于一个仓库 |
| `SESSION_NOT_OPEN` | Session 已经结束 | 新建 Session；已提交的 Session 不能重写 |
| `MEMORY_NOT_FOUND` | 该仓库中不存在此 Memory ID | 确认 ID 及其所属仓库 |
| `INVALID_INPUT` | schema 或前置条件失败 | `details` 字段会指出有问题的字段或状态 |
| `GIT_INSPECTION_FAILED` | 只读 Git 命令执行失败 | 检查 `git` 是否在 `PATH` 中，以及仓库是否可读 |
| `STORAGE_UNAVAILABLE` | 无法打开数据库 | 检查数据目录权限 |

## 常见情况

**MCP 客户端没有显示任何工具，或连接立即失败。** 请先构建：服务器从 `dist/` 运行。然后确认 stdout 中除了 JSON-RPC 没有其他内容；stdio 模式下一个多余的 `console.log` 就会破坏协议。`npm test` 包含纯净性检查，它会启动真实服务器并拒绝任何非 JSON 行。

**工具原本可用，之后开始返回 `repo_path is required`。** 服务器只在自身进程生命周期内记住 Session 或 Memory 来自哪个仓库。重启后，请在 commit 和 inspect 调用中显式传入 `repo_path`。

**已知存在的 Memory 没有被搜索返回。** 检查其状态。`superseded` 和 `invalid` Memory 按设计不会参与召回；inspect 仍会显示它们的完整历史。如果状态是 `uncertain`，它仍会返回，但排序较低并附带警告。

**大型重构后所有 Memory 都变成 `uncertain`。** 这是预期信号，而不是故障：相关文件发生了变化，因此结论需要复核。使用 `repomind memory-validate <id> --reason "..."` 确认仍然正确的 Memory；该操作会重建文件哈希基线并恢复为 `active`。修正错误项，并使已失效项失效。

**两条 Memory 相互矛盾且都处于 `uncertain`。** 冲突检测正常工作。先验证仍成立的一方，再修正或使另一方失效。如果修正项仍与一条存活 Memory 矛盾，它本身也可能保持 `uncertain`；结果中的 `conflicts` 字段会指出冲突对象。

**记录事实时返回 `stored: false`。** 相同事实已经存在，新 Evidence 已关联到现有事实。如果现有 Memory 已退役，再次记录会重新激活它并返回 `reactivated: true`。

**修正失败并提示“matches memory ... which is superseded/invalid”。** 修正后的文字与仍拥有该内容指纹的已退役 Memory 冲突。请改用不同措辞，或先使用 `repomind forget` 删除该已退役 Memory。

**在大型仓库中搜索较慢。** 返回结果前会刷新过期状态。每个相关文件最多读取一次；大小和修改时间未变化的文件不会重新哈希，因此常规成本是每个不同文件一次 `stat`。最近两秒内被修改的文件始终会重新哈希，这是有意设计：发生在同一文件系统时间刻度中的编辑可能保持大小和 mtime 不变。

**Windows：测试删除临时目录时出现 `EBUSY`。** 仍有 SQLite 句柄未关闭。请在 `finally` 中关闭每一个打开的 core。

**Session 卡在 `open`。** Agent 没有提交。`repomind sessions` 会列出它们；`repomind session-abandon <id>` 可以关闭其中一个。开放 Session 不会生成长期 Memory，因此不会从中静默记录任何内容。

**中文、日文或韩文查询没有结果。** v0.4.1 之前写入的 Memory 在建立索引时没有进行表意文字分词。运行一次 `repomind reindex` 重建索引；新 Memory 在写入时会正确建立索引。

## 数据位置

Memory 保存在 `~/.repomind/repositories/<projectId>/repomind.db`（Windows 上位于 `%USERPROFILE%`），`REPOMIND_DATA_DIR` 可以覆盖根目录。若要从零开始，请删除对应项目目录；仓库自身只包含 `.repomind/project.json`。若只需删除单条 Memory 及仅由其拥有的 Evidence，请使用 `repomind forget <id> --reason "..." --yes`，这是唯一会物理删除内容的操作。
