# RepoMind v0.13 真实仓库恢复验收

## 结果

固定 commit 恢复演练于 2026-07-28 通过全部功能和延迟检查。原始报告和全部恢复制品保存在仓库之外：

```text
D:\data\code\project\repomind-test\v0.13-real-recovery-20260728-01
```

Runner 两次克隆 RepoMind commit `97f9816c0d397af89937ada1a8386728b1b8f644`，并使用隔离 `REPOMIND_DATA_DIR`。来源包含 15 条 L1 Memory、15 条 Evidence、10 个 L2 Module Narrative 和一个 L3 Repository Profile。逻辑导入使用不同 Project ID；物理恢复保留来源 Project ID。

## 恢复检查

- 版本化逻辑导出重新加载后 SHA-256 checksum 相同。
- Dry-run 和确认后的 replace-import 保留 L1 ID 与 L2/L3 provenance，重建 FTS，移除目标独有数据，并使向量缓存保持为空。
- 物理备份和 manifest 通过 checksum、大小、schema 和 Project ID 验证。
- 每次重复中，dry-run 和确认后的 restore 都移除备份后修改，并保留带 checksum 的 restore 前 snapshot。
- 修改后的备份被拒绝，恢复数据库不发生变化。
- 不可读 live database 在显式批准前被拒绝；批准后的恢复保留不可读输入，并生成可读数据库。

## 性能

每项操作在记录的 Windows 主机上重复十次。

| 操作 | P50 ms | P95 ms | 最大值 ms |
| --- | ---: | ---: | ---: |
| 逻辑导出 | 4.940 | 7.385 | 7.385 |
| 逻辑导入 dry-run | 5.173 | 10.525 | 10.525 |
| 逻辑导入确认 | 8.469 | 10.982 | 10.982 |
| 物理备份 | 8.043 | 10.465 | 10.465 |
| 物理恢复 dry-run | 63.570 | 73.421 | 73.421 |
| 物理恢复确认 | 80.076 | 94.046 | 94.046 |

在新目录中运行验收：

```powershell
npm run bench:portability-real -- `
  --repo D:\data\code\project\repomind `
  --workspace D:\data\code\project\repomind-test\<new-directory> `
  --commit <full-commit> `
  --repeat 10
```

这些结果只证明当前仓库规模数据集上的恢复行为，不证明最终 10,000-L1 目标、远程 LLM 提取、逻辑 merge、加密归档或其他硬件上的性能。
