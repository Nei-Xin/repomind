# 跨 Session Agent 基准测试

跨 Session 基准测试要回答的问题，比普通代码能力测试更具体：

> 当新的 Agent Session 在持续演进的真实仓库中接手工作时，RepoMind 从前序
> Session 学到的上下文，能否提高正确率，或者让 Agent 用更少的工作达到相同结果？

测试会真实启动 OpenCode，并操作真实 Git 仓库。`shared` 与 `isolated` 两个实验臂
使用相同模型、任务提示、初始仓库提交、检查命令和 RepoMind 项目标识；预期处理变量是
RepoMind 数据库是否跨阶段保留。由于两个实验臂会独立调用模型，它们产生的 checkpoint
仍可能不同，必须通过 sequence 设计和报告复核控制这个混杂因素。

## 实验单元

一个 manifest 包含一个或多个 sequence，每个 sequence 至少包含两个有序 stage：

- producer stage 产生后续可能有用的证据、决策、约定或失败经验；
- 一个或多个 transfer stage 让全新的 Agent Session 完成依赖这些知识的后续任务。

对于每个 sequence 的每次重复，runner 只生成一个随机 `projectId`，并在两个实验臂
和所有 stage 中复用。下一次重复会生成新的 `projectId`，因此记忆不会跨重复次数泄漏。

| 属性 | `isolated` | `shared` |
| --- | --- | --- |
| 模型、Prompt、检查和初始 base commit | 相同 | 相同 |
| 同一配对重复中的 `projectId` | 相同 | 相同 |
| parentless checkpoint 交接 | stage 之间保留当前 tree | stage 之间保留当前 tree |
| 每个 stage 的工作树 | 仅含一个 commit 的全新 checkout | 仅含一个 commit 的全新 checkout |
| RepoMind 数据目录 | 每个 stage 全新目录 | 所有 stage 复用同一目录 |
| transfer stage 的预期召回 | 应为 0 | 可以注入前序 L1/L2/L3 |

runner 会交替执行实验臂：奇数次重复先运行 isolated，偶数次重复先运行 shared。
这可以降低模型服务状态或机器负载随时间变化产生的偏差，但不能完全消除它。

## 单个 stage 的生命周期

每个 stage 按以下顺序执行：

1. 初始化空 Git 仓库，仅 fetch manifest 指定的 `baseCommit`；后续 stage 也仅 fetch
   前一 stage 的 checkpoint commit。
2. detached checkout 后确认工作树干净，并写入同一配对 episode 使用的 RepoMind
   project marker。
3. Host 启动 RepoMind Session，在 OpenCode 启动之前检索并按预算渲染 L3、L2、L1。
4. OpenCode 使用 stage prompt 执行任务；Agent 不允许自行调用 RepoMind 生命周期工具。
5. Host 执行 public checks 和仓库外的 hidden checks，作为权威检查。
6. Host 根据 Agent 事件流和检查结果关闭 Session。成功提交后自动维护 L2/L3 并刷新
   L4 Candidate；L4 仍然必须人工审批。
7. runner 将当前 tree 写成无 parent 的实验 checkpoint。下一 stage 只把这个 root
   snapshot fetch 到全新仓库，不复用前一工作树，也不继承其祖先历史。

hidden check 失败可以是合法的任务结果。它可能导致本次 Host Session 不以成功状态
提交，并跳过派生层维护，但这本身不代表实验基础设施损坏。hidden 命令和输出不会作为
RepoMind Evidence 持久化，因此失败的 hidden verifier 不会把答案教给下一阶段；
public check Evidence 可以持久化。为了诊断，检查详情仍保存在本地评估报告中。

Git checkpoint 和 RepoMind commit 是两个不同概念。checkpoint 决定下一 stage 看到的
代码状态；RepoMind commit 决定本 stage 的 Evidence 是否足够可信，可以成为记忆。
将两者分开，既保留真实仓库的演进，又不会把验证失败的信息提升为高质量记忆。
失败 stage 仍会产生 checkpoint；如果 sequence 超过两个 stage，后续任务可能继承其代码
修改，但不会继承由该失败结果产生的可信记忆。

## 为什么使用全新 snapshot 和 checkpoint

如果复用同一个工作树，记忆迁移会与未跟踪文件、工具缓存、编辑器状态和其他进程残留
混在一起。仅含一个 commit 的全新仓库让 stage checkout 边界可观察，并阻止普通 Git
历史把 producer-only 事实带入 consumer。

但如果每个 stage 都从最初 commit 开始，也不符合真实开发过程。软件会在用户 Session
之间持续演进，因此 stage `N + 1` 会看到同一实验臂中 stage `N` 产生的 tree。
checkpoint 没有 parent：correctness-only 事实不能经祖先历史泄漏，而 efficiency 任务必须在
当前 tree 中保留独立恢复路径。套件中每个 producer 的唯一允许变更都是删除一个固定文件，
因此通过 producer 检查的两个实验臂会以相同的预期 tree 变化进入 consumer。

## 随项目提供的 6 条 sequence 套件

`benchmarks/cross-session-agent-suite` 提供了一个无第三方依赖的小型 Node.js 仓库，
以及 6 条彼此独立、每条包含两个 stage 的 sequence：

| 分组 | Sequence | 被测知识 | 主要解释 |
| --- | --- | --- | --- |
| correctness | `corr-release-command` | 最后批准的 release 命令及执行顺序 | hidden 正确率 |
| correctness | `corr-stale-endpoint` | 当前生产路由与两个过期路由 | hidden 正确率 |
| correctness | `corr-error-contract` | 异常类型、code、cause 与正常行为 | hidden 正确率 |
| efficiency | `eff-dependency-boundary` | 内置依赖边界与 digest 输出约定 | 正确率相同时的耗时、Token、读取量 |
| efficiency | `eff-delivery-failure` | 两个失败并发方案及正确重试语义 | 正确率相同时的耗时、Token、读取量 |
| efficiency | `eff-gateway-history` | 分散在运行配置和 telemetry 证据中的 Nimbus retry header 契约 | 正确率相同时的耗时、Token、读取量 |

correctness 组的事实只出现在 producer 用户消息和最终交接中，不进入基础 Git 仓库或
consumer prompt。这模拟用户只在前一个 Session 说明过一次生产约束的真实场景。
efficiency 组的事实可从 parentless 当前 tree 中保留的间接证据恢复：

- digest 行为需要联结兼容向量与 package 的零依赖边界；
- delivery 行为需要追踪当前 worker 及其不可修改的 caller-contract 测试如何区分 duplicate，
  以及失败后如何安排同 ID 重试；
- Nimbus 行为需要联结运行时 policy/边界与 telemetry reader 的 wire header 名称和转换。

isolated Agent 无需读取 sibling run、output artifact、hidden verifier 或 Git 祖先历史即可完成
调查；shared Host 则可直接提供 producer 的精确交接，省去重复调查。

每个 producer 只删除指定 marker 或 review 记录。每个 consumer 都要执行真实代码或
package 修改，并由仓库外、只读的 hidden verifier 验证；verifier 输出不会写入 Memory
Evidence。

生成器会创建真实 Git 仓库和可复现的初始 commit，把 base repository 与 hidden
verifier 替换成绝对路径写入以下四个 manifest，并拒绝覆盖任何已有目录：

- `manifest.json`：包含全部 6 条 sequence，也是兼容旧命令的默认路径；
- `manifest.correctness.json`：只包含 3 条正确率 sequence；
- `manifest.efficiency.json`：只包含 3 条效率 sequence；
- `manifest.cross-agent.json`：包含 2 条 Claude/OpenCode 双向迁移 sequence，每个
  stage 都显式指定 runner 与 model。

生成器支持 `--opencode-model <id>` 和 `--claude-model <id>`。两者的默认值分别为
`cliproxyapi/gpt-5.6-luna` 与 `gpt-5.6-luna`。所选值会直接写入
`manifest.cross-agent.json`，因此归档 manifest 会保留每个 Agent Host 使用的准确模型。

扩展前的 `manifest.json` 只包含 Nimbus sequence。文件路径保持兼容，但含义已经迁移为
完整套件；需要原先单一用途的实验风格时，应选择 `manifest.efficiency.json`。

先运行不调用模型的模板校验：

```powershell
npm.cmd run bench:cross-session-agent-fixtures
```

校验器会确认：

- fixture 生成与 Git 初始化成功；
- 在不同目录生成时，初始 commit ID 一致；
- 工作树干净，`HEAD` 与 manifest 中的 `baseCommit` 一致；
- manifest 中的路径占位符已替换成绝对路径，模型占位符已替换成所选模型 ID；
- hidden verifier 位于 Agent 仓库外部；
- 根目录 Vitest 不会错误收集模板中的 Node smoke test；
- correctness 事实没有泄漏到基础仓库或 consumer prompt；
- 每个 efficiency consumer prompt 都不包含待恢复契约，而 producer 单文件删除后，
  不可变的代码/配置证据仍保留在当前 tree；
- 所有 public checks 在基线仓库通过；
- 每个 hidden check 在未解基线失败，并在各自独立的两阶段 known-positive clone 中通过；
- producer 和 consumer 的修改分别与其精确 allowlist 一致；
- 第二次使用同一路径时，生成器明确拒绝覆盖。

仓库中的 `tests/cross-session-eval.test.ts` 还会使用本地测试 adapter 执行确定性的跨
Agent 模拟端到端用例。它能证明 stage 分发、模型选择、checkpoint 迁移、shared/isolated
数据库拓扑、报告和 acceptance 连线正确，但不会调用真实 Claude 或 OpenCode provider。
因此，该模拟结果不能替代真实混合 Agent 调用，也不能证明模型层面的效果提升。

## 使用 Luna 执行 120 次正式实验

前置条件是 Node.js 22.5 或更高版本、Git、已经 build 的 RepoMind，以及已经配置好
`cliproxyapi/gpt-5.6-luna` 访问能力的 OpenCode。

```powershell
npm.cmd install
npm.cmd run build
opencode.cmd --version

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$suite = "D:\data\code\project\repomind-test\cross-session-suite-$stamp"
$results = Join-Path $suite "results-luna-r5"

node .\benchmarks\cross-session-agent-suite\create.mjs $suite

node .\dist\cli\index.js eval `
  --agent-cross-session `
  --manifest (Join-Path $suite "manifest.json") `
  --runner opencode `
  --model cliproxyapi/gpt-5.6-luna `
  --repeat 5 `
  --max-memories 5 `
  --context-budget 12000 `
  --timeout 600000 `
  --output $results `
  --strict `
  --require-acceptance `
  --json
```

默认 manifest 包含 6 条 sequence。两个实验臂、两个 stage、5 次重复会真实启动
`6 x 2 x 2 x 5 = 120` 次 Agent，其中 producer 与 consumer 各 60 次。runner 按顺序
执行，因此应预留数小时并完整保留结果目录。

这里的 120 表示实验 stage 数。Host 只会对“模型和仓库尚未产生任何活动”的基础设施
故障最多尝试 3 次：input/output Token、工具、命令和 RepoMind 调用都必须为 0，Git
快照必须不变，并且输出必须明确命中 TLS、连接重置、网络超时、HTTP 429 或 HTTP 5xx。
abort、signal、Host timeout、业务失败和 verifier 失败都不会重试。`summary.json` 会分别
记录 stage 数、process attempt 数、重试数、发生重试的 stage 数和耗尽重试的 stage 数；
所有重试耗时仍计入效率指标，每次 attempt 的脱敏原始证据保存在对应 artifact 目录。

如果只运行一个 60 次调用的分组，把 `manifest.json` 替换为
`manifest.correctness.json` 或 `manifest.efficiency.json`，并使用另一个空结果目录。
两份分组 manifest 用于分别解释正确率和效率；默认 manifest 用于一次命令完成 120 次实验。

## 执行 40 次正式跨 Agent 实验

跨 Agent manifest 衡量 RepoMind 知识在 Agent Host 发生切换后能否继续生效，而不只是
同一 Host 的全新 Session 是否能召回。OpenCode 与 Claude 两个可执行程序都必须能从
`PATH` 找到。使用下面的完整命令生成全新套件，并让两条 sequence 各重复 5 次：

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$suite = "D:\data\code\project\repomind-test\cross-agent-suite-$stamp"
$results = Join-Path $suite "results-cross-agent-luna-r5"

node .\benchmarks\cross-session-agent-suite\create.mjs $suite `
  --opencode-model cliproxyapi/gpt-5.6-luna `
  --claude-model gpt-5.6-luna

node .\dist\cli\index.js eval `
  --agent-cross-session `
  --manifest (Join-Path $suite "manifest.cross-agent.json") `
  --runner opencode `
  --model cliproxyapi/gpt-5.6-luna `
  --repeat 5 `
  --max-memories 5 `
  --context-budget 12000 `
  --timeout 600000 `
  --output $results `
  --strict `
  --require-acceptance `
  --json
```

两条显式方向分别是：

- `xagent-claude-to-opencode-endpoint`：Claude 记录生产 endpoint 决策，再由全新
  OpenCode Session 完成实现；
- `xagent-opencode-to-claude-parser`：OpenCode 记录 parser 错误契约，再由全新
  Claude Session 完成实现。

每个 producer 和 consumer stage 都显式声明自己的 `runner` 与 `model`，跨 Agent 结果
不依赖命令级继承。2 条 sequence、2 个实验臂、2 个 stage、5 次重复会准确启动
`2 x 2 x 2 x 5 = 40` 次真实 Agent 调用。

真实执行仍依赖已配置 endpoint、认证信息和 provider 可用性。当前对 Claude 兼容的
`gpt-5.6-luna` endpoint 探测返回了 HTTP 503，因此不能把该次探测表述为真实
Claude/OpenCode 实验结果。应在 provider 恢复后重新执行上述命令并保留完整结果目录，
再解释跨 Agent 效果。

每次正式实验都应使用新的 `$suite` 路径。fixture 生成器拒绝已有目标目录，eval runner
拒绝非空结果目录，从而避免新旧证据被混合或意外覆盖。

如果系统无法直接找到 OpenCode，可以额外指定：

```powershell
  --runner-executable C:\path\to\opencode.cmd
```

不要只保留重定向后的控制台输出而删除结果目录。`summary.json`、每次 Host 报告和
JSONL 事件才是复核实验所需的完整证据。

## Manifest 格式

生成后的示例可以直接运行。给真实仓库手工编写的最小 manifest 如下：

```json
{
  "version": 1,
  "name": "billing retry policy transfer",
  "sequences": [{
    "id": "billing-retry",
    "baseRepository": "D:\\code\\billing-service",
    "baseCommit": "4a62c4f7d926f46b1d6f6e6bc1c841abffac8f9e",
    "stages": [{
      "id": "producer",
      "prompt": "Complete the migration and preserve durable constraints in the handoff.",
      "publicChecks": [{ "command": "npm.cmd", "args": ["test"] }],
      "hiddenChecks": [{
        "command": "node",
        "args": ["D:\\eval-private\\verify-producer.mjs", "{repo}"],
        "timeoutMs": 120000
      }],
      "allowedChanges": ["src/migration.ts"]
    }, {
      "id": "consumer",
      "prompt": "Implement the follow-up behavior using current repository knowledge.",
      "publicChecks": [{ "command": "npm.cmd", "args": ["test"] }],
      "hiddenChecks": [{
        "command": "node",
        "args": ["D:\\eval-private\\verify-consumer.mjs", "{repo}"]
      }],
      "allowedChanges": ["src/retry.ts", "test/retry.test.ts"]
    }]
  }],
  "acceptance": {
    "minSharedTransferHiddenPassRate": 0.8,
    "minTransferHiddenPassRateDelta": 0.2,
    "minSharedRecallRate": 0.8,
    "maxIsolatedRecallRate": 0,
    "minSharedCommitRate": 0.8,
    "maxMeanDurationRegressionPercent": 25
  }
}
```

`baseRepository` 可以写相对于 manifest 的路径，loader 会将其解析为绝对路径。如果
归档证据时更看重来源明确性而不是可移植性，可以直接使用绝对路径。正式实验应固定完整
commit hash，不要使用会变化的 `HEAD`。

sequence 和 stage ID 必须以小写字母或数字开头，后续只能包含小写字母、数字、`.`、
`_` 或 `-`。每个 sequence 必须包含 2-20 个 stage，public 和 hidden check 数组都
不能为空。

check 必须拆成 program 与 args 数组，不能写成依赖 shell 解析的一整段命令字符串。
check 的 program 或参数中每个 `{repo}` 都会替换成当前 stage 的全新 checkout 路径。
`timeoutMs` 是单条 check 的超时，允许范围为 1-600,000 毫秒。

`allowedChanges` 是可选的。配置后，Agent 执行结束时 `git status --short` 报告的每个
路径都必须在列表内。应该加入合法的测试和生成文件，但不能为了通过 strict 而使用失去
约束力的宽泛列表。

## 为真实仓库设计迁移任务

producer 应来自真实团队希望下一次 Session 记住的事件，例如：被拒绝的实现及原因、
不明显的模块迁移、验证过的命令、生产兼容约定，或者已经被删除、埋在历史中的设计决策。

consumer 本身也应是有价值的真实任务。它应从 producer 知识中受益，但不能只是要求
Agent 复述答案。producer 的代码变化应尽量确定，使用检查和 `allowedChanges` 约束，并在
解释迁移结果之前比较两个实验臂的 checkpoint tree；不能给 shared prompt 额外提示。

public checks 用于普通仓库健康度和可见契约。hidden verifier 必须放在
`baseRepository` 外部，其路径和代码不能出现在 Agent prompt 或被跟踪文件中。
正确率迁移任务可以有意让 producer 用户消息包含被测契约，但不能在 consumer prompt 或
当前仓库中重复答案；效率任务必须让事实仍可从当前 parentless tree 中间接的代码、配置、
fixture 或 caller 证据恢复。verifier 必须只读、确定性执行，只在成功时返回 0；输出应
足以帮助人判断基础设施故障，但不应向后续 Agent 泄漏 hidden-only 细节。

花费模型调用之前，先完成以下验证：

1. 确认 base commit 干净并且可复现。
2. 在预期的 stage 状态上运行所有 public checks。
3. 证明每个 hidden verifier 在未完成状态失败，在单独准备的正确状态通过。
4. 确认 producer 能产生可提交、对后续有用的 RepoMind Evidence。
5. 预先声明 sequence 测量“保留信息带来的正确率”还是“重新发现信息的效率”。效率任务
   必须提供真实的无记忆恢复路径；正确率任务必须保证 durable fact 只由 producer 提供。
6. 先在新目录执行一次 smoke test 并检查产物，再换全新目录启动正式重复实验。

开发阶段至少重复 5 次；要得出较强的效果结论，建议重复 10 次以上并使用多个 sequence。

## Strict 与 Acceptance 的区别

`--strict` 判断实验本身是否可信。它检查缺失或重复运行、错误 commit、初始工作树不干净、
非预期文件修改、Agent 崩溃或协议违规、checkpoint 链断裂、shared/isolated 数据库拓扑
错误、上下文 telemetry 不一致、Agent 越权调用 RepoMind、检查命令无法执行，以及未关闭
的生命周期资源。hidden 断言不通过是被测结果，不是完整性错误。成功 committed 的 Session
必须具有预期的派生维护记录；未成功但已经正确关闭的 Session 可以合法跳过维护。

`--require-acceptance` 判断预先声明的产品目标是否达到。manifest 未配置 acceptance，
或任一已配置门禁失败时，该选项都会返回非零退出码。支持的门禁如下：

| Manifest 字段 | 衡量内容 |
| --- | --- |
| `minSharedTransferHiddenPassRate` | stage 1 之后 shared hidden 通过率下限 |
| `minTransferHiddenPassRateDelta` | shared 减 isolated 的 hidden 通过率差下限 |
| `minSharedRecallRate` | shared transfer stage 至少注入一条 L1/L2/L3 的比例下限 |
| `maxIsolatedRecallRate` | isolated transfer stage 出现注入记录的比例上限 |
| `minSharedCommitRate` | shared transfer stage 完成 Host Commit 并关闭 Session 的比例下限，与任务是否成功无关 |
| `maxMeanDurationRegressionPercent` | shared 相对 isolated 的 Host 生命周期平均变慢上限 |
| `maxMeanInputTokenRegressionPercent` | shared 相对 isolated 的 Agent 平均 input token 增长上限 |
| `minInputTokenPairedWinRate` | shared 使用更少 Agent input token 的配对 transfer stage 比例下限 |
| `minAgentDurationPairedWinRate` | shared Agent 执行更快的配对 transfer stage 比例下限 |
| `minComparablePairCoverageRate` | 两臂所有 public/hidden 都通过、可进入效率统计的完整 transfer pair 比例下限 |

正式实验应同时使用两个选项。仅 strict 通过，只能说明实验结构有效，不能说明 RepoMind
产生提升；仅 acceptance 通过但 strict 失败，则效果结论没有可信实验作为支撑。

correctness 与 cross-Agent manifest 都有意不设置耗时门禁：正确率不相等时不能比较效率。
correctness manifest 要求 shared 减 isolated 的 hidden 通过率差至少为 `0.3`。
efficiency manifest 要求 hidden 不退化、
comparable pair coverage 为 100%、Host 生命周期平均耗时回退不超过 10%、Agent 平均
input token 回退不超过 10%，并且 input token 和 Agent 耗时的配对胜率都至少为 `0.6`。
这些非脆弱阈值以真实 Luna R5 Nimbus 结果为依据：两个实验臂的 hidden 均为 100% 通过；
shared Agent 耗时降低 19.693%，配对 5/5 获胜；shared input token 降低 25.574%，配对
同样 5/5 获胜。10% 上限为正常运行波动留出空间，`0.6` 配对门禁仍要求多数样本产生收益。

完整 manifest 使用 `0.15` 的 hidden 差值，但不会跨 correctness 与 efficiency cohort
混合设置效率门禁；效率结论应使用 `manifest.efficiency.json`。这些是预注册的效果门禁，
不是完整性检查。在得出因果结论前，还必须确认所有 producer check 通过，并比较配对
producer checkpoint 的 tree hash；当前 strict report 不会自动把这两个条件判为完整性失败。

## 结果与 Telemetry

结果目录结构如下：

```text
results-luna-r5/
|-- artifacts/        OpenCode 事件、stderr 和 Host run 报告
|-- data/             shared episode 数据库与 isolated stage 数据库
|-- runs/             每个实验臂/stage/重复对应的全新 Git checkout
|-- summary.json      完整机器可读报告
`-- summary.md        简明的人类可读对比报告
```

`summary.json` 的 provenance 包括 RepoMind 版本与 commit、工作树 dirty 状态、Node/OS/
runner 版本、manifest SHA-256 和解析后的 sequence base commits。每个 stage run 会记录
project/data/repository 路径、requested/base/previous/checkpoint commits、初始工作树状态、
实际及非预期修改、public/hidden 结果、验证耗时、生命周期状态与各阶段耗时、维护状态、
记忆库计数、Agent 退出状态及产物路径。

Agent telemetry 包括 turn 数、input/output/reasoning/cache token、工具调用数、失败工具和
失败命令、文件读取与重复读取、越权 RepoMind 调用。上下文 telemetry 会分别记录 L1/L2/L3
的 provided、eligible、injected、truncated、omitted 数量及有序 ID，allocated/source/
rendered 字符数，总上下文与 Prompt 字符数、未使用预算，以及完整 Prompt 的 SHA-256；
summary 不保存 Prompt 正文。

transfer summary 排除 stage 1，因为它没有更早 Session 可供召回。后续 stage 会统计两个
实验臂的 recall、hidden pass 和 commit rate。paired comparison 会报告 shared 与
isolated 均值、shared 减 isolated 的差值、相对变化和近似 95% 区间。Token、耗时和文件
读取等效率指标只统计两臂全部 public/hidden 都通过的 comparable pair；报告会单独给出
eligible、excluded、total pair 和 coverage。正确率与诊断指标仍使用全部完整 pair；越低
越好的指标还会统计 shared 胜/平/负次数。注入记录数和上下文字符数属于诊断指标，即使
数值差不为 0，其配对样本也记为平局。

这些指标需要联合解读：

- shared hidden success 更高且配对差值为正，支持“正确率提升”；
- hidden success 相同，但 shared token、读取或耗时更低，支持“效率提升”；
- 发生注入但效果和效率都没变化，只能证明召回发生，不能证明 Agent 使用了记忆；
- shared 没有注入，应优先检查检索、质量门禁和 L1-L3 维护，而不是直接归因于模型能力；
- shared commit rate 低，说明 Host 生命周期没有可靠闭合，后续学习机会可能丢失，修复前不能
  宣称闭环有效；该指标不要求 public 或 hidden check 通过。

## 局限

这是受控评估，不是单次运行即可成立的因果证明。Agent 输出、模型服务负载、缓存行为和
工具选择仍具有随机性；样本很小时，近似置信区间也很弱。

isolated stage 与 shared stage 使用同一项目身份，但 isolated 不共享数据库。因此测试的
是 sequence 内学习，不包含无关项目之间或不同重复之间的迁移。Recall 只表示至少一条
记录被注入，不表示它一定相关，也不表示 Agent 遵循了它。

全新 stage 仓库消除了工作树残留，并且只 fetch parentless snapshot，因此早期 Git 祖先不是
合法恢复通道。isolated efficiency arm 应调查当前 tree 中有意保留的证据；如果证据缺失，
或 isolated 没有通过契约，该 pair 会从效率指标中排除，并降低 comparable coverage。

runner 会在两个实验臂中分别执行 producer。它会验证两条 checkpoint 链，但不会要求两个
tree hash 相同。因此，过于宽泛的 producer 任务可能在 consumer 之前引入代码状态混杂。
应优先选择变化范围窄且结果被唯一验证的 producer，或者增加独立分析，拒绝 producer tree
不等价的配对样本。

失败 stage 也会被 checkpoint，所以一次失败可能改变同一实验臂中所有后续 stage 的代码
状态。只衡量一次迁移时优先采用两阶段 sequence；使用更长 sequence 时，应预先规定如何
分析级联失败。

专用 OpenCode Host 将 `external_directory` 设置为 `deny`，因此正常受控 Agent 不能通过
OpenCode 工具读取 sibling run、output artifact、数据目录、base fixture 或 hidden verifier。
但这是 Host 工具权限边界，不是 OS 或 container sandbox。因此实验结论限定为非对抗受控
评测；如果 hidden 测试需要抵抗对抗性进程，应使用隔离的操作系统账号或容器。

最后，`allowedChanges`、检查和 acceptance 阈值都包含实验设计者的假设。每次正式运行前
都应重新评审，归档生成后的 manifest 和完整结果目录，并同时报告负面或中性结果。
