# 对比基准

`repomind eval --compare` 回答一个问题：**面对相同任务和相同 Token 预算，每种记忆策略实际交付什么上下文？**

它不回答 Agent 随后能否成功。引用其中任何数字前，请先阅读[本基准不支持的结论](#本基准不支持的结论)。

```bash
repomind eval --compare --json
repomind eval --compare --markdown
repomind eval --compare --lint            # validate fixtures only
repomind eval --compare --strict          # non-zero exit if a gate fails
repomind eval --compare --repeat 10        # collect ten latency samples per evaluation unit
```

`--repeat` 接受 1 到 100 的整数。每次重复都从同一数据库 snapshot 重建相同 context bundle，并记录独立延迟样本。确定性内容指标为每个 fixture、arm、placement、alpha 和 budget 保留一个评分 cell，因此增加 `--repeat` 不会虚增质量比较所用的统计样本量。报告的 `latency.samples` 字段记录最终原始样本数。

## 各个 Arm

每个 arm 获得相同仓库基底，包括 README 摘录、package script 和浅层文件列表。因此 Token delta 可归因于记忆层，而不是某个 arm 偶然打包了更多仓库上下文。

| Arm | 含义 |
| --- | --- |
| `no-memory` | 完全没有记忆数据库，但并非毫无能力：使用与 RepoMind 相同 tokenizer 和 ranker，对仓库文件 chunk 执行 BM25 检索。没有记忆的 Agent 仍会 grep。 |
| `full-history` | 全部 Session 完整渲染，最新优先，不过滤、不标记。它并非无知，而是包含 corpus 中每项事实，代价是 Token 和噪声。 |
| `flat-lexical-rag` | 对原始 Session 文本执行带 recency weight、无治理的 BM25。权重遍历五个值并报告最佳结果，因此以最强状态评价基线。 |
| `recency-k` | 最近更新的存活 Memory。没有查询、排序或相关性信号，用来检验检索机制是否值得。 |
| `repomind-nogov` | 关闭治理后的 RepoMind 筛选：所有状态都可用，不刷新过期状态，也无警告，用于隔离筛选与治理效果。 |
| `repomind` | 与 Agent 实际获得完全相同的 `core.search`。 |
| `oracle-ceiling` | Fixture 的 gold fact，以最小形式渲染。它是参考尺度，绝不进入 win/loss ledger。 |
| `flat-vector-rag` | 使用确定性离线 feature-hash 提供方，在原始 Session chunk 上执行 sqlite-vec cosine retrieval。 |
| `repomind-layered-hybrid` | 对受治理 L1 Memory 执行加权 lexical/vector reciprocal-rank fusion。L2/L3 layer 仍是未来工作。 |

词法 arm 调用与生产搜索相同的 `buildMatchExpression` 和 `searchTokens`。若不同时修改 RepoMind 自身运行的代码，基线无法漂移成 strawman。

## 测量内容

**比较型**指标用于 arm 真正竞争：`answerCoverage`、`tokensToCoverage`、`mrrFact`、`noiseShare`、`redundancyRate`、`unwarnedStaleRate`、`conflictWarnedRate`。只有这些进入 win/loss ledger。

**单边**指标 `overWarnRate`、`evidenceCitationRate`、`conflictNoiseShare` 只衡量 RepoMind 才有的机制。其他 arm 得零分是因为缺少该机制，而不是表现更差。它们是绝对诊断项（RepoMind 多久误报一次、冲突标记消耗多少预算），显示在独立列中，绝不计为胜利。

Delta 携带跨 fixture 的 paired bootstrap 95% interval；区间跨越零时，renderer 输出 `indistinguishable`，而不是“better”。

## Fixture 的工作方式

一个 fixture 声明仓库、Session 历史、可选治理操作和文件修改、查询，以及理想 bundle 应包含的 gold fact。Replay 通过公开 API 写入每个 Session：`startSession` / `commitSession` / `record` / 治理方法，绝不直接写 SQL。因此基准也是写路径集成测试：治理 bug 会表现为明显构建失败，而不是静默获得有利的零值。

每个历史 Session 在同一循环中写入原始 corpus 并提交到 RepoMind，因此信息对等由结构保证。RepoMind 提取器漏掉的任何事实仍对其他 arm 可见，并记为 RepoMind loss。

十项硬检查会直接拒绝 fixture，包括：gold fact 没有匹配任何内容；gold fact 已在查询中陈述；事实只能通过 decision text 到达，而 RepoMind 会逐字复制该文本并轻易找到；声明的 repository-discoverability flag 与重新计算不符。一个静默地什么都没有测量的 fixture 比缺失 fixture 更糟。

## 诚实性门禁

Tier 1 在绝对故障时失败：fixture 无法 replay、已退役 Memory 进入 bundle、打包 Memory 没有 Evidence。

Tier 2 检查确定性验收目标。可由文件检测的 stale Memory 未警告使用率门禁低于 5%。仅文字版本会**报告但有意不设门禁**：文件哈希过期检测在结构上无法识别后来文字中撤回的结论，将其隐藏在聚合值后并不诚实。

Tier 3 是防止自利的核心。Fixture 声明 `designedLoss`，指定必须在某一指标上击败 RepoMind 的 arm；或声明 `designedCost`，指定必须超过下限的单边指标。如果 RepoMind 赢了一个本来用于击败它的 fixture，门禁会以 `the fixture is not stressing what it claims` 失败。若 RepoMind 在任何地方都没有输、caveat 缺失或对抗 fixture 占比低于 0.375，运行也会失败。

`designedLoss` 只能通过带原因且提升 fixture version 的显式 `waivers` 条目豁免，否则真正改进 RepoMind（例如加入 embedding）的人反而会破坏构建，门禁就变成惩罚进步。

## 本基准不支持的结论

> **1. Gold-fact coverage 只检查 bundle 中是否在任何位置出现字面短语。** 位于 9,000 Token transcript 第 8,000 Token 的事实，与 rank 1 的 40 Token 精炼 Memory 得分相同。这系统性地偏爱 `full-history`，而 RepoMind 的优势正是在该指标上声明，因此所有 coverage 数字都是“可用知识”的上限，整个比较依赖 Token 效率轴。每个 arm（包括无排序 arm）都会发布 `firstGoldRank` 和 `mrrFact`，至少可以看见埋藏情况。没有应用可读性惩罚，因为这种惩罚不可证伪。
>
> **2. 本基准不衡量任务成功率。** 没有 LLM 参与，因此不能据此声称“RepoMind 将任务成功率提升 X%”。+15% 成功率目标仍未验证，并报告为 `not-evaluated`。`taskSuccessRate`、`turnsToCompletion`、`wallClockTaskTimeMs`、`outputTokens`、`repeatedFileReads`、`repeatedFailedCommands`、`llmCostUsd` 和 `embeddingCostUsd` 都以带原因的显式 null 出现，而不是被省略。
>
> **3. 它衡量上下文质量，而不是 Agent 行为。** Agent 随后是否正确使用交付知识未经测试。Bundle 可以包含 Agent 忽略的事实，也可以漏掉 Agent 很容易重新发现的事实。关键假设“更好的上下文产生更好的结果”是整个产品前提，本基准假设它成立，而不测试它。
>
> **4. `approxTokens = ceil(chars / 4)` 是有文档说明的启发式，不是 BPE 计数。** 只有 arm 之间的比例有意义。估算误差与 arm 相关，因为 `full-history` 携带 Git diff 和 JSON blob，其中每 Token 字符数与自然语言差异很大。报告发布精确字符数和按记录类型的细分，任何人都可用真实 tokenizer 重算。
>
> **5. 向量 arm 使用确定性 feature-hash embedding。** 这使 sqlite-vec 检索离线且可复现，但它不是学习得到的语义模型。结果不能估计 OpenAI-compatible embedding 提供方的质量、延迟或成本，也不能泛化到它们。
>
> **6. 只有 RepoMind 能得分的指标不构成可证伪性。** `overWarnRate`、`conflictNoiseShare` 和 `evidenceCitationRate` 按定义是单边的：其他 arm 得零分是因为缺少机制，而非表现更差。它们是单独呈现的绝对诊断项，绝不进入 win/loss ledger。
>
> **7. Fixture 由 RepoMind 作者编写。** 这存在选择偏差，任何 validator 都不能消除。缓解措施是局部的：十项硬失败条件（包括重新计算 repository-discoverability）、CI 强制执行声明 designed loss 的 fixture、版本化 fixture schema，以及公开邀请外部贡献 fixture。剩余偏差仍存在。
>
> **8. Fixture 数量较少。** 内容指标完全确定，因此运行间 variance 为零；这只是隐藏 label variance 和 fixture selection variance，而没有消除它们。每个 delta 都报告跨 fixture 的 paired bootstrap 95% interval，区间跨零时 renderer 拒绝打印“better”。在当前样本量下区间很宽，小 delta 不能视为结果。
>
> **9. `residualExplorationFiles` 是代理指标。** 它根据 fixture 声明的 discoverability 列表进行算术计算，并非观察到的 Agent 行为。
>
> **10. 延迟数字来自单机器、单 OS**，在当前 corpus 大小下主要由常量因素主导。套件不对墙钟时间设门禁。这里的任何 fixture 都没有证明 10,000 条 Memory 的检索延迟目标。
>
> **11. Budget sweep 使用整数档位**，而不是测得的真实上下文预算。结论只有顺序意义，没有校准到任何特定 Agent 的 context window。
>
> **12. 这不是公开任务集。** Fixture 固定且可复现，并会将内容哈希写入每份报告，但由本项目编写而非第三方提供。每个验收目标均标记 `taskSetIsPublic: false`。

## 贡献 Fixture

外部 fixture 是真正解决第 7 条 caveat 的唯一办法。复制 `benchmarks/comparison/reuse-debug-experience.json`，运行 `repomind eval --compare --fixtures <your-file> --lint` 直到通过。一个能击败 RepoMind 的 fixture 比一个 RepoMind 获胜的 fixture 更有价值。
