# RepoMind v0.10 连续日常工作流验收结果

本文记录 v0.10 冷启动和持久运行历史工作流的正式开发验收。该次运行通过真实的
`repomind run` 入口使用 OpenCode 连续执行了两个仓库任务，随后触发一次强制
超时，以验证生命周期清理。

验收期间，可执行文件报告的版本为 `0.9.0`，因为版本升级被有意推迟。
实际测试的 v0.10 源代码 commit 为
`30a15bd41a15f75090d58aa3af3745c00879fd68`；之后仅变更了发布元数据和文档。

## 判定

| 问题 | 结果 |
| --- | --- |
| bootstrap 是否保持审查优先？ | 是：生成了两个 Candidate，仅应用选中的 README Candidate。 |
| 第一个真实任务是否使用了 bootstrap Memory？ | 是：它检索到选中的种子 Memory，并通过全部检查。 |
| 第二个任务是否复用了先前任务的 Memory？ | 是：它同时检索到种子和任务 1 生成的解决方案。 |
| 宿主运行历史是否保留两次成功运行？ | 是：两者均记录为 `committed`。 |
| 超时清理是否关闭持久状态？ | 是：超时运行状态为 `abandoned`，不存在打开的 Session 或运行中的宿主运行。 |
| 超时是否改变了仓库？ | 否：HEAD 和干净工作树保持不变；所有检查仍然通过。 |
| Agent 是否绕过宿主生命周期？ | 否：Agent 的 RepoMind 调用次数为零。 |
| v0.10 正式开发验收 | **通过** |

## 来源信息

| 字段 | 值 |
| --- | --- |
| 生成时间 | `2026-07-28T16:24:07.0961312+08:00` |
| 测试的 RepoMind commit | `30a15bd41a15f75090d58aa3af3745c00879fd68` |
| RepoMind 报告版本 | `0.9.0`（发布前元数据） |
| 发布版本 | `0.10.0` |
| 模型 | `cliproxyapi/gpt-5.6-terra` |
| 运行器 | OpenCode `1.18.7` |
| Node.js | `v22.20.0` |
| 操作系统 | Windows 11 `10.0.26200` x64 |
| 测试仓库 Project ID | `407dd6c1-afdd-4665-b18b-78ed62e27dae` |
| 测试仓库基线 | `6b6482988bfe77dd425f688f931cf9ff08f94b32` |
| 任务 1 commit | `2e0a80822d00aa387995131c58079288ec0ebd04` |
| 任务 2/最终 commit | `126945dccb557539e623675b73c4b62d9f54ef2b` |
| `summary.json` SHA-256 | `84116e96f98553d1a4e07bc4e556923bb20f70e755a5ab29785e609e65bb7bfa` |
| `summary.md` SHA-256 | `605a18b40bbdfc50052ece583a6c751e77690444bfbe59eadb64a1af0f715048` |

完整工作区保留在
`D:\data\code\project\repomind-test\v0.10-daily-workflow-formal-20260728`。

## 方法

测试固件最初是一个不含依赖的小型库存仓库，其中记录了预留契约。RepoMind 初始化
该仓库，并从 README 和 Git 历史生成两个确定性的 bootstrap Candidate。
不带 `--yes` 的应用操作被拒绝。随后，验收只应用 README Candidate，
未选择置信度较低的 Git 历史 Candidate。

任务 1 要求 OpenCode 实现 `reserveInventory` 及针对性测试。宿主管理的 Session
提交后，外部检查确认其符合契约，固件变更也被提交。任务 2 随后要求 OpenCode
复用 `reserveInventory`，添加原子化的 `reserveBatch` 行为。其运行报告记录了
对任务 1 所生成解决方案 Memory 的检索，从而证明确实发生了跨任务 Memory 复用，
而不仅仅是成功存储。

最后，第三次 `repomind run` 使用一毫秒超时。进程由 `SIGTERM` 终止，CLI 以
非零状态退出，Session 和宿主运行状态均被标记为 abandoned，且没有修改仓库。
之后重新执行了公开检查和外部隐藏检查。

## 运行结果

| 运行 | 状态 | 检索到的 Memory | Agent 耗时 | 输入/输出 Token | Agent RepoMind 调用 |
| --- | --- | ---: | ---: | ---: | ---: |
| 任务 1 `ses_d2be4b2c-23d3-45b3-b4eb-e0eedde0816d` | committed | 1 | 68,045.770 ms | 10,944 / 1,582 | 0 |
| 任务 2 `ses_c861e8e7-0832-4b4a-bca0-caae8cbd4421` | committed | 2 | 104,390.201 ms | 16,622 / 2,411 | 0 |
| 超时 `ses_af75d368-4ff3-433d-9ed7-935bf88e2775` | abandoned | 4 | 10.827 ms | 0 / 0 | 0 |

任务 1 检索到 bootstrap 种子
`mem_c6f3ebc8-1bba-4685-9ff1-0136f36ef19a`。任务 2 检索到该种子以及
任务 1 的解决方案 `mem_fb2031e7-2acb-4ec9-ad0d-cc4bb511284e`。

## 最终状态审计

| 检查 | 结果 |
| --- | ---: |
| 成功任务 | 2/2 |
| 任务 2 和超时后的公开检查 | 8/8 通过 |
| 外部隐藏验证器 | 2/2 通过 |
| 宿主运行 / Session | 3 / 3 |
| 打开的 Session / 运行中的宿主运行 | 0 / 0 |
| Evidence / Memory | 18 / 4 |
| 超时 CLI 退出码 | 1 |
| 超时 Session 和宿主运行状态 | `abandoned` / `abandoned` |
| 超时后的固件状态 | 在 `126945dccb557539e623675b73c4b62d9f54ef2b` 上保持干净 |

最终有两条 Memory 处于 `uncertain` 状态，因为后续任务修改了与其原始 Evidence
哈希绑定的文件。这是预期的文件过期状态转换；这些 Memory 仍可审计，
且不表示生命周期仍处于打开状态。

## 产物哈希

| 产物 | SHA-256 |
| --- | --- |
| `bootstrap-candidates.json` | `677338becf3345539e2801a2b022512dda0b00180bc38faaf5ba28c06ecbe036` |
| `bootstrap-seed-inspect.json` | `e32e8dcf5d932907d521c477577bc99f5a5c9ccd1bf62945ec87f1fe0a65bfa5` |
| `run-1/run.json` | `00ba709eedd061a3744e8312307b0b4be38f22cd25ba6455cb70e6567b1112ea` |
| `run-2/run.json` | `2c9adbe7da47989270a4b9b2d9d0ae8f9018cce14de7b546dfad3555c08d093f` |
| `run-3-timeout/run.json` | `e1a9f51116d46af9051a88f8d75eb2d28f113479fa316ad02ab15eca5dc15681` |
| `status-after-timeout.json` | `011cde67db6a74f2508cd64f0b84e3a3a2ba19b151698a65af0c4d33355e2b09` |
| `runs-after-timeout.json` | `5dde6644cb0206e94f2da970fba6571b61e7a1767f9af5d6fbc1e0cef81d8d30` |

## 限制

- 这是纵向产品路径验收，不是无 Memory 或完整历史对比，也不能证明普遍的性能提升。
- 它只覆盖一个小型 JavaScript 仓库、一个模型别名、一个 OpenCode 版本、
  两个成功任务和一次强制超时。
- README 变更后，初始种子变为 uncertain。该次运行证明了系统会呈现过期状态，
  但没有评估人工重新验证流程。
- 一毫秒超时验证了进程早期清理；它没有覆盖 Agent 已编辑文件后的中断场景。
