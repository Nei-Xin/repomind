# ADR-005：Memory 与 Evidence 分开存储

状态：accepted

## 背景

Memory 是可复用的结论；Evidence 是证明结论的原始材料。将两者混为一体会使结论无法审计，也会迫使每次召回都携带巨大的 diff。

## 决策

`memories` 和 `evidence` 是独立的表，通过 `memory_evidence` 关联。每条自动提取的 Memory 必须引用至少一条 Evidence。召回只返回 Memory 正文；需要时再通过 inspect 获取 Evidence。

## 后果

- `repo_memory_inspect` 始终可以回答“这条 Memory 为什么存在”。
- Evidence 一旦被引用便不可变；修正会创建新记录，而不是修改历史。
- 遗忘操作必须处理共享引用：被其他 Memory 使用的 Evidence 会保留，成为孤儿的 Evidence 可以物理删除（参见 `forget_log`）。
