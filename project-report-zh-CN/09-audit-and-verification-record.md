# 09 本次审计与验证记录

> **2026-08-11 追加说明**：第 1-10 节保留 2026-08-10 源码审计当时的执行记录。其后已在冻结提交 `6d421dd` 上完成当前 Host 路径的 120-stage OpenCode/Luna 跨 Session 正式实验；correctness、efficiency 的 Integrity、Acceptance 与独立 Audit 均通过。当前代码的完整 Vitest 也已重新执行，45/45 test files、259/259 tests 通过，exit 0，用时约 414.9 秒。新增实验的设计、结果和证据哈希见 [第 10 篇正式实验报告](10-cross-session-formal-experiment-20260811.md)。

## 1. 记录目的

本文件是报告中所有数字和结论的审计索引，严格区分：

- `v1.0.0-rc.1` tag 的已提交发布基线；
- 2026-08-10 当前 dirty worktree 的实际实现与验证；
- 仓库已保存、但本轮没有重新执行的重型 Acceptance；
- 仓库外 RC 120 次真实 Agent 实验的观察性产物。

这一区分避免把历史测试结果冒充当前结果，也避免把当前新增的 L2/L3 Host 注入与自动派生维护错误归因到旧的 L1-only Agent 实验。

## 2. 审计基线

```text
Repository: D:\data\code\project\repomind
Branch: main
HEAD/tag baseline: v1.0.0-rc.1
HEAD commit: 05fe873136d578738b14e01edac6f2302e22a70c
Commit time: 2026-07-30T00:17:25+08:00
Commit subject: chore: prepare v1.0.0-rc.1
Audit date: 2026-08-10
Platform: Windows
Node.js: v22.20.0
npm: 11.16.0
Git: 2.51.0.windows.1
```

审计时 `HEAD` 仍指向 RC tag，但工作树包含尚未提交的 Host 分层上下文、派生维护、Eval v6、路径硬化、测试和文档改动。因此本报告把 RC 和当前工作树作为两个代码快照，不把 dirty worktree 的能力写成 RC 已发布能力。

当前工作树规模按 UTF-8 物理行统计：

```text
src/:   62 TypeScript files / 12,967 physical lines
tests/: 42 TypeScript files / 6,226 physical lines
Vitest suites: 41
Vitest tests: 202
```

`tests/helpers.ts` 是辅助文件，因此 42 个 TypeScript 文件与 41 个 test suite 不矛盾。行数包含空行和注释，是仓库规模指标，不是逻辑代码行数。

## 3. 深度审计范围

本次重新阅读并交叉核对了：

- 根 README、Final Product Spec、Project Plan、Security、Changelog 和 package/CI 配置；
- `docs/` 下 40 份架构、工作流、ADR/acceptance/benchmark 文档；
- `src/` 中 Core、SQLite/迁移、Search、Git、Security、Extraction、L2/L3/L4、Portability、CLI、MCP、OpenCode Host 与 Eval；
- 数据库 schema 1-11 的升级和回滚路径；
- `tests/` 中 41 个 suite 及测试辅助代码；
- `benchmarks/` 中 Agent、Scale、Layered Memory、Remote Extraction、Portability、Package 脚本与 manifest；
- 仓库外 2026-08-04 RC 120 次实验的 summary、profile、命令记录和中文报告。

源码审计分为三个并行方向，再由主审计统一事实口径：

1. Core、Storage、Search、Git、Security；
2. L2-L4、CLI、MCP、OpenCode、Portability；
3. Tests、Eval、Benchmark、Acceptance 和历史实验产物。

## 4. 本次实际执行的项目命令

### 4.1 测试发现

```powershell
npx.cmd vitest list
```

结果：

```text
Exit code: 0
Test files discovered: 41
Tests discovered: 202
```

这条命令只证明测试清单可被发现；最终通过结论来自完整 `npm test`。

### 4.2 聚焦回归与审计缺陷闭环

新增 Host context、派生维护、Eval v6 和路径安全测试后，先后执行了两组聚焦回归：

```text
First focused regression: 26/26 passed
Expanded focused regression: 42/42 passed
```

首次完整测试暴露 2 项 Windows junction 失败：linked repositories root 和 linked project directory 没有被路径实现拒绝。随后 profile v6 真实旧报告 fixture 又暴露一项兼容失败。进一步并行源码审计还发现 related-file symlink、失败非测试命令误判、异步全局 data directory、Windows quote expansion、伪 Host 标题、dangling SQLite link 和 `maxMemories=0` 语义问题。

当前工作树已分别采用 canonical realpath 二次 containment、全命令成功门禁、显式 data-directory 依赖、libuv quoting 完整 argv 估算、逐行 Markdown blockquote、`lstat` 链接检测和零 L1 分支修复。日常 Host 与正式 Agent Eval Runner 现在都要求全部观察命令成功且 `repoMindCalls=0` 才可标为 success。最终聚焦结果为 6 files、49/49 通过；typecheck 通过。说明审计不只记录缺陷，也将每项修复绑定到回归测试。

### 4.3 最终完整 Vitest

```powershell
npm.cmd test
```

在 Agent profile v6 fixture 修复之前，完整运行仍有 1 项失败；之后又加入上述 hardening 与 Eval Runner 一致性回归。所有修复和新测试进入工作树后，从头重新执行最终完整套件。

```text
Tests discovered: 202
Focused regression: 6 files / 49 passed
Test Files: 41 passed / 41
Tests: 202 passed / 202
Exit code: 0
Duration: about 258.9 seconds
```

日志中的 Node `node:sqlite` experimental warning 和 Windows LF/CRLF warning 不是测试失败。最终结论来自完整套件，不是用 focused 结果替代。

### 4.4 类型检查与构建

```powershell
npm.cmd run typecheck
npm.cmd run build
```

结果：

```text
typecheck: Exit code 0, tsc -p tsconfig.json --noEmit
build:     Exit code 0, tsc -p tsconfig.json
```

### 4.5 八任务 Fixture 校验

```powershell
npm.cmd run bench:agent-fixtures
```

结果：

```text
Exit code: 0
Manifest version: 2
Tasks validated: 8/8
All public baselines: passed
All hidden baselines: failed-as-designed
```

任务包括 `renamed-module`、`failed-solution`、`migration-rollback`、`historical-command`、`stale-endpoint`、`error-contract`、`dependency-boundary` 和 `config-default`。“hidden baseline failed-as-designed”表示未修改的 base commit 被外置 hidden verifier 正确拒绝，不是项目测试失败。

## 5. 本次文档验证

对 `project-report-zh-CN/*.md` 执行以下结构检查：

- 以 UTF-8 读取；
- 每个文件恰好一个 H1；
- 三反引号代码围栏数量为偶数；
- 跳过 `http/https` 和页面内 anchor 后，所有相对 Markdown link 均能解析；
- 搜索已经过时的 L1-only Host、显式维护、report v5 和测试失败表述。

最终检查结果记录在本文件第 11 节。Windows PowerShell 读取无 BOM UTF-8 中文时必须显式指定 `-Encoding UTF8`，否则默认代码页可能制造乱码和错误统计。

## 6. 覆盖率口径

本次没有在当前 dirty worktree 上重新执行 `npm run test:coverage`。仓库现有 `coverage/coverage-summary.json` 对应此前测试快照：

| Metric | Covered / Total | Percent | CI threshold |
| --- | ---: | ---: | ---: |
| Lines | 7,506 / 8,956 | 83.80% | 80% |
| Statements | 7,506 / 8,956 | 83.80% | 80% |
| Functions | 417 / 438 | 95.20% | 90% |
| Branches | 2,179 / 2,803 | 77.73% | 75% |

这些数字不能证明新增 `context.ts`、derived maintenance、Eval v6 和路径硬化仍达到同样覆盖率。准确表述是“已有快照超过 CI 全局阈值，当前改动需重新生成 coverage”。

## 7. 2026-08-10 审计中未重新执行的重型 Acceptance

2026-08-10 的源码审计没有重新调用远程模型或生成下列正式批次。结论来自仓库保留的报告和原始 Acceptance 脚本：

| Acceptance | 来源 |
| --- | --- |
| v0.8 72-run Host-managed | [`../docs/agent-benchmark-results-v0.8.md`](../docs/agent-benchmark-results-v0.8.md) |
| p-limit cross-session | [`../docs/external-open-source-cross-session-acceptance-v0.17.md`](../docs/external-open-source-cross-session-acceptance-v0.17.md) |
| L2 | [`../docs/l2-real-repository-acceptance-v0.12.md`](../docs/l2-real-repository-acceptance-v0.12.md) |
| L3 | [`../docs/l3-real-repository-acceptance-v0.12.md`](../docs/l3-real-repository-acceptance-v0.12.md) |
| L4 deterministic/cross-Agent | [`../docs/skill-candidate-acceptance-v0.15.md`](../docs/skill-candidate-acceptance-v0.15.md)、[`../docs/l4-cross-agent-acceptance-v0.15.md`](../docs/l4-cross-agent-acceptance-v0.15.md) |
| 10k L1 | [`../docs/scale-acceptance-v0.14.md`](../docs/scale-acceptance-v0.14.md) |
| Remote Extraction | [`../docs/remote-extraction-acceptance-v0.16.md`](../docs/remote-extraction-acceptance-v0.16.md) |
| Portability | [`../docs/data-portability-acceptance-v0.13.md`](../docs/data-portability-acceptance-v0.13.md) |
| Encrypted Portability | [`../docs/encrypted-portability-v0.18.md`](../docs/encrypted-portability-v0.18.md) |
| Release readiness | [`../docs/release-readiness-v1.0.md`](../docs/release-readiness-v1.0.md) |

不能把“读取了历史正式报告”写成“2026-08-10 当轮重新通过”。截至那次审计，当前分层 Host 路径只完成了实现级和 fixture wiring 验证；随后在 2026-08-11 完成的是新的 120-stage 跨 Session 两臂实验，不是旧版 `8 tasks × 3 arms × 5 repeats` 三臂实验的重跑。

## 8. RC 120 次实验产物

仓库外路径：

```text
D:\data\code\project\repomind-test\uplift-v1-preflight-20260804-01
```

关键产物：

```text
TEST_REPORT_REPEAT5_LUNA_ZH.md
FORMAL_REPEAT5_COMMANDS_AND_RESULTS.md
results-repeat-5-luna-retry-2/summary.json
profile-repeat-5-luna-retry-2/profile.json
profile-repeat-5-luna-retry-2/profile.md
```

审计确认：

```text
Planned and completed runs: 120
Report schema: v5
Injected context: ranked L1 only
Integrity: failed
Acceptance: failed
Failure: failed-solution/full-history-1, certificate verification, exit 1
RepoMind hidden: 40/40
No-memory hidden: 29/40
Full-history hidden: 39/40
RepoMind retrieval: 40/40
RepoMind commit: 40/40
Open sessions after run: 0
```

该批次只在 [05 测试、评测与效果分析](05-testing-evaluation-and-results.md) 中作为观察性证据引用。它不能证明当前 L1+L2+L3 prompt 或自动 maintenance 的效果。

## 9. 当前工作树保护

审计开始和结束时工作树都不是 clean 状态。源码、测试、英文 docs、`docs-zh-CN/` 和本报告目录存在并发或既有修改；`tmp/` 中还有与本任务无关的简历图片。本次工作遵循以下规则：

- 不 reset、checkout 或删除用户和其他审查分支的修改；
- 将当前工作树能力与 RC tag 清楚分开；
- 不把 `tmp/` 纳入报告或清理；
- 文档修改只围绕当前实现、测试证据和用户要求。

因此 `git status --short` 中出现其他改动，不表示这些文件全部由技术报告任务创建。

## 10. 后续提交变化后的复核顺序

```powershell
git diff -- src tests benchmarks docs package.json
npm.cmd ci
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
npm.cmd run test:coverage
npm.cmd run bench:agent-fixtures
npm.cmd run bench
```

如果 Core、Host context、派生维护或 Eval 行为变化，还应在全新外部目录重新执行分层消融和三臂真实 Agent 实验；不要把新样本补入旧正式批次。

## 11. 最终文档校验结果

最终以 UTF-8 对全部文档重新校验：

```text
project-report-zh-CN: 11 files
Exactly one H1 per report: passed
Even fenced-code markers: passed
Relative Markdown links: passed
docs English sources: 53 files
docs-zh-CN: all 53 source paths mirrored + 1 Chinese index README
docs-zh-CN H1/fences/relative links: passed
Stale implementation/test-state searches: no unintended matches
git diff --check: exit 0
```

`git diff --check` 只输出 Windows 工作树的 LF-to-CRLF 提示，没有 trailing whitespace 或空白错误。结合第 4 节，2026-08-10 源码审计的验证口径为：typecheck、build、8-task fixture、6-file focused regression 和 41-file/202-test 完整套件均通过。2026-08-11 当前版本又完成 45-file/259-test 全量回归；新增的 120-stage 真实模型实验另见第 10 篇报告，未与历史 Acceptance 或旧三臂批次混合。

## 12. 2026-08-11 最终复核与证据固化

文档口径修正后执行：

```powershell
npx.cmd vitest list --json
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
git diff --check
```

结果：

```text
Vitest inventory: 45 test files / 259 tests
Full Vitest: 45/45 files / 259/259 tests passed
Full Vitest exit: 0
Full Vitest duration: about 414.9 seconds
Typecheck: exit 0
Build: exit 0
git diff --check: exit 0; LF-to-CRLF warnings only
project-report-zh-CN: 11 Markdown files, H1/fences/relative links passed
docs English sources: 53 Markdown files
docs-zh-CN: 53 same-path mirrors + 1 Chinese index; H1/fences/relative links passed
Stale current-state phrases checked: no unintended matches
```

冻结源码快照仍为 clean 的 `6d421ddab90d45a2747f1b25c2d270fb3c306e5e`，348 个 tracked files、0 个 untracked files。按 `repomind-source-snapshot-v1` 独立重算的 SHA-256 仍为：

```text
67c1fcdc46a3ff3e669c7078437d7d476bd1b5b799bc68b7fea451ec75017e78
```

最终文档与实验日志哈希：

| 文件 | SHA-256 |
| --- | --- |
| `10-cross-session-formal-experiment-20260811.md` | `F8A9CC17D6E8C22CEA00B4A4FF3E5A22A51F638ACE896F47B28569ED56F510A8` |
| `EXPERIMENT-LOG.md` | `0155F4814EC5F4C042C2870EDB81776B81BCFEEF332126F9AC9A6DCBDF3A399F` |

Correctness/Efficiency 的 summary 与 audit 四个 SHA-256 也已重新计算，并与第 10 篇报告记录完全一致。没有重跑、补写或覆盖任何模型实验及审计产物。
