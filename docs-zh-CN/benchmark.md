# 检索基准

`repomind eval` 使用固定、版本化的数据集衡量检索质量。它是分阶段基准计划（`REPOMIND_PROJECT_PLAN.md` 第 32 节）的第一块基础：在构建更大的任务级对比（无记忆、flat RAG、RepoMind）之前，先量化搜索能否找到正确 Memory。

## 工作方式

1. 数据集（`benchmarks/datasets/*.json`）声明种子 Memory 和查询。每个查询列出应视为相关的 Memory 标题。
2. Runner 创建临时 Git 仓库和临时数据目录，因此结果可复现且绝不触及现有仓库 Memory。
3. 每条 Memory 都通过正常 `record` 路径记录（包括脱敏、FTS 索引和冲突检测），每个查询随后通过正常 `search` 路径执行。
4. 报告为每个查询及总体给出：
   - **Recall@K**：前 K 个结果中出现的预期 Memory 比例（K = `--limit`，默认 5）。
   - **MRR**：第一个相关结果的 mean reciprocal rank。
   - **latency**：`search` 墙钟时间，以全部查询的 P50/P95 报告。
   - **missedQueries**：未检索到预期 Memory 的每个查询。遗漏会如实报告，绝不掩盖。

## 运行

```bash
repomind eval --dataset benchmarks/datasets/basic-retrieval.json --json
```

## 示例结果

测量环境：Windows 11、Node.js 22.20、10 条种子 Memory、8 个查询、K = 5：

```json
{
  "queries": 8,
  "meanRecallAtK": 1,
  "mrr": 0.938,
  "p50LatencyMs": 0.614,
  "p95LatencyMs": 1.771,
  "missedQueries": []
}
```

延迟取决于硬件和数据量；报告时应始终附带 OS、Node 版本和数据集大小。规范目标（10,000 条 Memory 时 FTS P95 < 150 ms）只是目标，这个 10 条 Memory 的数据集不能证明该目标。

## 跨 Session 场景套件

`repomind eval --scenarios` 重放六个端到端场景，每个场景使用独立临时仓库，并报告最终产品规范第 20.4 节中无需 LLM 的确定性目标：

| 场景 | 验证内容 | 规范目标 |
| --- | --- | --- |
| cross-session-recall | 新 core 实例能够召回前一 Session 有 Evidence 的 Memory | 跨 Session 召回有效 |
| evidence-binding | 每条已保存 Memory 至少引用一条 Evidence | 绑定率 100% |
| repository-isolation | 搜索绝不返回其他仓库的 Memory | 污染率 0% |
| stale-warning | 相关文件变化时产生带警告的 `uncertain` 结果 | 未警告的过期使用 < 5% |
| conflict-surfacing | 矛盾决策都以显式冲突警告出现 | 不静默合并 |
| idempotent-commit | 使用同一 key 重复 commit 不创建新内容 | 无重复项 |

当前结果（全部场景通过）：

```json
{
  "scenarios": 6,
  "passed": 6,
  "failed": 0,
  "crossSessionRecall": 1,
  "evidenceBindingRate": 1,
  "isolationViolations": 0,
  "staleWarnedRate": 1,
  "conflictSurfacedRate": 1,
  "idempotencyViolations": 0
}
```

## 已知限制

- 数据集较小且由人工编写；它验证检索管线，而不是端到端 Agent 收益。
- 场景套件确定性验证机制保证，不衡量 Agent 任务成功率或 Token 节省。
- 规范中的对比基准已经实现：`repomind eval --compare` 在固定 Token 预算下，对八个评分 arm 和五种预算下各记忆策略交付的**上下文 bundle**评分。参见 [`benchmark-comparison.md`](./benchmark-comparison.md)。
- 由于没有 LLM 参与，它仍**不衡量**任务成功率、完成所需轮次、任务墙钟时间、输出 Token、真实 BPE 或货币成本。“任务成功率 +15%”目标会报告为 `not-evaluated`，绝不会宣称已满足。
- 两项验收目标可确定性测量：未警告的过期 Memory 使用（CI 只门禁可由文件检测的过期；文件哈希检测器在结构上无法识别仅在文字中陈述的撤回）和 100% Evidence 绑定。
- `flat-vector-rag` 和 `repomind-layered-hybrid` 使用 sqlite-vec 与确定性离线 feature-hash 提供方。这使管线可复现，但不能估计学习型远程嵌入模型的语义质量、延迟或成本。
