# RepoMind v0.12 真实仓库 L2 验收

日期：2026-07-28

完整性：**通过**

## 方法

可重建 runner 将真实 RepoMind 仓库固定 commit `fb3d133bbfb8548280c88d3e92fa896e2c5e71b8` 克隆到 `D:\data\code\project\repomind-test` 下的隔离 workspace。它使用隔离 RepoMind 数据目录，不读取或修改开发者的日常记忆数据库。

经审查的 manifest 在六个真实源码 module 中植入 13 条有 Evidence 支持的 L1 事实。Runner 执行初始完整构建、provenance 检查、无变化重建、单来源修改、过期 module 检查、定向重建、FTS 召回、Session Start 召回和重复延迟采样。最终 corpus 包含 14 条 L1 Memory 和六个 L2 Narrative。

使用新输出目录重建：

```powershell
npm run bench:l2-real -- `
  --repo D:\data\code\project\repomind `
  --workspace D:\data\code\project\repomind-test\l2-real-<new-id> `
  --repeat 50
```

Manifest SHA-256：`f03b002939efd3a846ab49514d1ac518ba98c75ff0aed4c5a84612e77bf80bdd`。

## 环境

| 字段 | 值 |
| --- | --- |
| OS | Windows `10.0.26200` |
| Node.js | `v22.20.0` |
| CPU | AMD Ryzen 7 H 255 w/ Radeon 780M Graphics |
| 逻辑 CPU | 16 |
| 内存 | 33,068,818,432 bytes |
| L2 字符预算 | 4,000 |

## 功能检查

全部检查通过：

- 每条 manifest Memory 均已保存；
- 至少六个真实 module 生成 Narrative；
- 所有初始和最终 Narrative 均为 current；
- 每个 Narrative 均在硬内容预算内；
- 每个 L2 来源都可追溯到 L1 和至少一个 Evidence ID；
- 无变化重建不产生新版本；
- 添加 storage L1 后只有 `src/storage` 变为 stale；
- 定向重建恰好只更新该 module；
- FTS 为 migration 查询返回 storage 上下文；
- Session Start 返回相关的 current L2 上下文。

## 延迟

| 操作 | 样本 | P50 ms | P95 ms | 最大值 ms |
| --- | ---: | ---: | ---: | ---: |
| 完整重建，无变化 | 50 | 3.574 | 4.712 | 5.301 |
| 定向重建，无变化 | 50 | 3.484 | 4.795 | 5.651 |
| 列表 | 50 | 3.011 | 4.391 | 4.555 |
| 搜索 | 50 | 2.833 | 4.070 | 4.327 |
| Inspect | 50 | 2.876 | 3.742 | 4.605 |
| Session Start | 30 | 185.767 | 252.765 | 256.685 |

## 限制

- 目标是真实仓库，但审查后的 L1 事实是确定性输入。这不测试远程 LLM 提取质量。
- Corpus 为仓库规模，不能证明最终 10,000-L1 性能目标。
- 结果来自一台 Windows 机器，不能泛化到其他 OS 或硬件。
- 本次验收证明 L2 层，不证明 L3、跨 Agent MCP 兼容性、export/restore、macOS CI、L4 或远程 LLM 行为。
