# RepoMind v0.12 真实仓库 L3 验收

日期：2026-07-28

完整性：**通过**

## 方法

可重建 runner 将真实 RepoMind 仓库固定 commit `051212de0e167c4a2c24addace85f1c535decb67` 克隆到 `D:\data\code\project\repomind-test` 下的隔离 workspace。它使用隔离 RepoMind 数据目录，不读取或修改开发者的日常记忆数据库。

Runner 从 L2 验收 manifest 植入 13 条已审查 module L1 事实，构建六个真实 L2 module boundary，并加入三条已审查的仓库级事实。随后测试初始 L3 生成、provenance 检查、无变化重建、低 confidence 仓库和 module 变化、合格来源变化、过期 Profile Session Start、版本化重建、current Profile Session Start 和重复延迟采样。最终 corpus 包含 19 条 L1 Memory、六个 L2 module 来源、四个仓库 L1 Profile 来源和两个 L3 版本。

使用新输出目录重建：

```powershell
npm run bench:l3-real -- `
  --repo D:\data\code\project\repomind `
  --workspace D:\data\code\project\repomind-test\l3-real-<new-id> `
  --repeat 50
```

Manifest SHA-256：`f03b002939efd3a846ab49514d1ac518ba98c75ff0aed4c5a84612e77bf80bdd`。

原始 JSON 和生成 Markdown 保存在 `D:\data\code\project\repomind-test\l3-real-v0.12-20260728`。

## 环境

| 字段 | 值 |
| --- | --- |
| OS | Windows `10.0.26200` |
| Node.js | `v22.20.0` |
| CPU | AMD Ryzen 7 H 255 w/ Radeon 780M Graphics |
| 逻辑 CPU | 16 |
| 内存 | 33,068,818,432 bytes |
| L3 字符预算 | 6,000 |
| 最小 confidence | 0.8 |

## 功能检查

15 项门禁全部通过：

- 所有已审查 L1 输入均已保存，并构建六个真实 L2 boundary；
- 初始 current Profile 保持在硬字符预算内；
- Profile 同时包含仓库 L1 和 L2 module 来源；
- 每个存活来源都可追溯到有 Evidence 支持的 L1；
- 无变化重建保留版本 1；
- 低 confidence 仓库和 module 变化不会使 L3 stale 或触发重建；
- 合格来源变化使 L3 stale；
- stale L3 不注入 Session Start；
- 重建生成 current 版本 2，并保留两个版本；
- current L3 注入 Session Start；
- 四项延迟门禁全部通过。

自动化测试还单独验证：高 confidence module L1 会在 L2 重建前使 L3 stale；每个保留的 L3 版本都保存创建时使用的精确仓库和 module L1 来源 ID。

## 延迟

| 操作 | 样本 | P50 ms | P95 ms | 最大值 ms |
| --- | ---: | ---: | ---: | ---: |
| 重建，无变化 | 50 | 3.763 | 5.204 | 6.016 |
| Get 与新鲜度检查 | 50 | 3.799 | 5.014 | 5.805 |
| Inspect provenance 与版本 | 50 | 3.981 | 5.630 | 6.203 |
| 使用 current L3 的 Session Start | 30 | 189.922 | 210.615 | 264.485 |

## 限制

- 目标是真实仓库，但审查后的确定性 L1 输入不测试远程 LLM 提取质量。
- Corpus 为仓库规模，不能证明最终 10,000-L1 性能目标。
- 结果来自一台 Windows 机器，不能证明 macOS 兼容性，也不能泛化到其他硬件。
- 本次运行不证明第二个真实 Coding Agent 的互操作性、export/import 或 backup/restore、覆盖率目标、L4 Skill Candidate 或远程 LLM 行为。
