# RepoMind v0.17 最终规格审计

## 结果

`REPOMIND_FINAL_PRODUCT_SPEC.md` 第 24 节的全部 28 项标准现在均具备
实现和保留的验收证据。最后一项未完成的产品证明标准，即外部真实开源项目的
跨 Session 收益案例，已在 v0.17.0 发布后通过。本审计记录证据完整性，
不会将 v0.17.0 更名为 v1.0。

详细的 27 项实现审计仍保留在 `docs/final-spec-audit-v0.16.md` 中。
其中当时未完成的条目现由以下内容取代：

| 标准 | 证据 | 状态 |
| --- | --- | --- |
| 外部真实开源项目的跨 Session 收益 | `docs/external-open-source-cross-session-acceptance-v0.17.md`：固定的 `p-limit` commit、Claude Code 任务 1、三组配对的 OpenCode 无 Memory/RepoMind 重复实验、外部隐藏检查、原始事件和哈希 | 完成 |

## 证据边界

外部实验结果将成功率和效率分开衡量。两组均通过了所有公开检查和隐藏检查。
随后，RepoMind 在每一组配对实验中都展示出更低的输入 Token 数和 Agent 耗时。
报告保留了原始的负面运行器摘要及其未经重跑的修正分析，因此该证明没有隐藏
已知的上游测试失败，也没有把失败的任务结果重新解释为成功。

以下内容仍是有意不作为门槛的项目，而不是缺失的第 24 节标准：

- 逻辑合并导入，尚待定义身份、冲突、替代关系、Evidence、Audit 及 L2-L4 策略；
- 可选择启用的加密导出和备份归档；
- 自动观察 Agent 宿主工具；以及
- 自动安装或执行 L4 Skill Candidate。
