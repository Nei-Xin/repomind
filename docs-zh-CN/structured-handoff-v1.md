# 结构化交接 v1：设计与验收

状态：**阶段 1、2 已实现；首批真实验收已执行，语义完整性门槛未通过，消费者对照未启动**。日期：2026-10-03。

可选输入、确定性校验、Evidence 审计和标题选择已接入显式提交路径。
OpenCode Host 已接入可选输出协议、失败回退、持久化报告和逐次提示词审计。
首版目标是可靠取得 Agent 明确标注的交接约束，避免依赖英文交接标题的同义词列表。
不以减少 token 为首版验收目标。

## 现状与需要解决的问题

第三批独立留出测试的 12 个真实阶段全部通过，但四组正文、标题和实际注入内容
变化均为 0/4。它验证了旧格式兼容性，没有验证新规则的泛化收益。此前十份已知
样本的回归有效，也不能替代未知任务验证，详见 [摘要实验记录](solution-summary-quality.md)。

当前代码路径：

| 位置 | 当前行为 | 对方案的约束 |
| --- | --- | --- |
| `src/domain/types.ts` / `CommitSessionInput` | summary、decisions、tests、commands、remainingWork | 增加可选字段，不能改旧字段含义 |
| `src/cli/commit-input.ts`、`src/mcp/server.ts` | CLI 和 MCP 分别定义提交 schema | 两入口和直接 core 调用都需校验 |
| `src/integrations/agent-host/types.ts` / `AgentOutcome` | summary、commands、trace、可选 handoff capture | 采集器记录完整性和围栏范围；Core 重验 |
| `src/integrations/opencode/lifecycle.ts` | 最后文本事件提取摘要；移除 NUL，限制 12,000 UTF-16 code units | 必须在有损清理前检测协议；截断不能冒充完整结构 |
| `src/integrations/claude/events.ts` | 从 terminal result 等取得摘要，亦有清理和长度限制 | 首版保留现状，后续单独适配 |
| `src/integrations/agent-host/run.ts` | 独立质量评估、Host 验证、提交、报告 | handoff 不能决定 success，也不能声明自己已验证 |
| `src/core.ts` / `commitSession` | 原始摘要 Evidence、请求哈希、记忆生成、命令去重 | 新字段纳入幂等请求；不迁移旧记录 |
| `src/activity/store.ts` | 交互式结束任务使用 repository-outcome 策略 | 结构化数据不能绕过只读任务的 solution 门槛 |
| `src/activity/context.ts`、`src/integrations/opencode/context.ts` | 最终渲染、预算与召回审计 | 审计必须对应真正注入的内容 |

后续核心规则统一已让 Host 的 `commitHostLifecycle` 与交互式路径都使用
repository-outcome 策略：成功任务需有实际文件变更或可信通过测试的持久化证据，
才生成 solution。Host 观察到的 tests 在 commands 中保留工具来源，也参加门槛
判断；未知退出码不写入命令 Evidence。显式 CLI/MCP 提交仍保持默认主动提交策略。
本文件下方首批真实验收使用的是统一前的冻结 runtime，历史结果不重算。

## 选择与首版范围

| 方案 | 代价与限制 | 结论 |
| --- | --- | --- |
| 继续增加自然语言正则 | 已知样本有效，但新表达不断出现 | 作为旧格式兼容路径保留 |
| 额外调用模型重写摘要 | 增加调用、成本和新的事实改写风险 | 不作为首版依赖 |
| Agent 输出可选结构，Core 校验，验证由采集器提供 | 需要协议支持；仍须检查约束是否标注完整 | 采用，先按可选能力接入 |

首版只做：字段取得与校验、来源审计、明确约束优先的标题、完整原始正文。
约束和剩余工作不额外生成 decision/requirement 记忆。渲染时不再复制一遍全部
结构字段，不改变搜索权重、置信度、命令去重、会话状态或文件关联来源。
完整结构已进入 Evidence 元数据和启用协议的 Host 报告，供审计和后续结构化展示使用。

## 输入协议

`CommitSessionInput` 增加 `handoff?: StructuredHandoffV1`：

```ts
interface StructuredHandoffV1 {
  version: 1;
  constraints: string[];
  remainingWork: string[];
}
```

JSON 形状见 [schema](structured-handoff-v1/schema.json)，可检查样例见
[examples](structured-handoff-v1/examples.json)。运行时使用共享 Zod schema 和语义校验器；
JSON Schema 表达形状，完整段落来源和总长度等限制仍由语义校验器检查。

- 两个数组必须提供；空数组表示没有标注该类内容，不证明没有约束或没有剩余工作。
- 每类最多 16 项；每项为非空白字符串，最多 2,000 Unicode code points；两类合计
  最多 4,000 code points。JSON schema 管单项形状，合计限制由语义校验器负责。
- 各项必须逐字等于原始自然语言摘要中的一个**完整、唯一的非空段落**。段落由
  一个或多个仅含空格/Tab 的空行分隔；保留段内所有字符、标点、换行、Markdown、
  警告和条件，不做 trim、大小写折叠或 Unicode normalization 后的模糊匹配。
  开头/结尾空行是分隔符；段落自身的缩进或行末空格属于原文。
- 完整段落可包含多行列表。不得只截取句子的一半或去掉同段的 Warning/条件前缀。
  每段只能出现一次，不能同时属于两类；同类项必须按原文出现顺序排列。
- 显式输入出现 NUL 字符时也拒绝结构化使用，避免后续清理改变段落来源。
- Core 计算段落的 `[start, end)` UTF-16 偏移，Agent 不填写位置。跨段依赖的语义
  完整性无法由逐字匹配证明，仍属于人工/行为验收；完整原文始终保留。
- 拒绝未知版本、未知字段。Agent 不得提供 `verification`、`verified`、`status`、
  `evidenceIds`、置信度或相关文件等权威性字段。

只有选取来源的结构化声明，没有新的事实权威。协议校验通过不等于约束正确或
已经实现。对“后续必须实现”仍按未完成约束保留。

### 与既有字段的关系

`summary` 继续必填；其 Evidence 内容不由 handoff 重写。`decisions` 保持原有
显式决策入口，不从 constraints 自动复制。`tests`、`commands` 保持原有来源机制。
若同一请求同时提供旧 `remainingWork` 和新 `handoff.remainingWork`，两数组必须
逐字、顺序相同，否则显式提交报 INVALID_INPUT；不静默挑选一个覆盖另一个。
旧字段单独使用时保持原行为。

CLI 字段使用 `handoff.remainingWork`；MCP 外层仍使用 `session_id` 等既有名字，
新增 handoff 子对象直接复用同一 schema（子对象内保持 `remainingWork`）。将此
不一致明确写进入口文档，避免暗中出现两种 handoff 格式。

## 验证结果属于系统输出

完整交接审计包含三个部分：constraints、verification、remainingWork。只有前后
两部分由 Agent 标注；中间部分由 Core/Host 从本次持久化命令 Evidence 组装。

```ts
// 内部生成；不接受来自模型、CLI 或 MCP 的 verification 对象。
interface HandoffVerificationItem {
  evidenceId: string;
  command: string;
  exitCode: number;
  source: "caller-reported" | "tool-observed" | "host-verified";
}
```

保留每次结果与顺序，不把“先失败后通过”简化成从未失败，不添加一个容易误解的
`verified: true` 总开关。同名命令多次执行仍引用各自 Evidence，命令记忆复验沿用
当前机制。未知退出码留在既有 L0/trace，不伪造为通过。没有命令证据时输出空数组。
人工声明的 `tests` 仍标记 caller-reported；只在自然语言里写“测试通过”不会生成
verification 项，也不会生成 verified-command。
显式输入没有跨数组时间戳：审计按 tests 数组顺序后接 commands 数组顺序，
不声称这是两类命令之间的真实执行时间顺序。

Host 隐藏检查可能只用于质量判定而未作为可注入 Evidence 保存；不能在此投影中
泄漏隐藏检查内容。质量报告仍保留原来的 authoritativeVerification，二者不混用。

## 存储、标题和幂等性

使用现有 `agent_summary` Evidence 的 metadata_json 保存新审计对象，不增加
EvidenceKind、不要求数据库表迁移；保留现有 remainingWork 元数据键：

```text
handoffAudit: {
  protocolVersion, disposition: accepted | absent | rejected,
  reasonCodes, summarySha256, producer: explicit-input | opencode-host,
  rawHandoff, constraints: [{text, start, end}],
  remainingWork: [{text, start, end}], verification: [...],
  titleSource: structured-constraint | legacy-summary,
  solution: {memoryId, disposition, titleApplied}
}
```

此处字段为内部投影，不是 Agent 输入 schema。对自动协议错误只保存有界且经过
现有脱敏流程的诊断；不要在错误消息重复整段模型输出。完整提交事务负责 Evidence
和记忆的原子性；显式无效输入应在任何写入前失败。MCP/CLI/Core 共用一个校验器。
阶段 1 只在显式提供且通过校验时写 accepted 审计；旧输入不新增 absent 元数据，
拒绝输入不写任何记录。Host 开启协议时也记录 absent/rejected；关闭时不新增交接元数据。

既有 Secret 脱敏继续生效：summarySha256 和 UTF-16 位置对应实际保存的脱敏后
agent_summary，rawHandoff 也受脱敏保护。先校验原文，再在脱敏后重新定位；如果
脱敏导致原本不同的段落合并或段落边界改变，报 `redacted-source-mismatch`，
不保存错误位置。没有 Secret 时 Evidence 逐字保留原文。

accepted 分支：solution 正文使用完整自然语言原文，**不再调用布局重排**。
标题优先使用第一条约束全文，仅当它为单行、以句末标点 `.?!。！？` 结束且长度
不超过现有标题上限 160 UTF-16 code units。不得删掉前缀、截成首句或跳到后面
更短的约束；不符合则沿用当前自由文本标题函数。无约束时也走该标题回退。
这意味着长列表仍可能保留一般性标题：首版明确接受这一限制，而不假装普遍解决。
单行检测包括 CR/LF 和 Unicode 行/段分隔符。标题仍遵循存储层的脱敏及首尾空白
清理；新存 solution 正文保留首尾空白。第一条约束的校验和选择不会跳过条件前缀。

titleSource 描述候选标题的来源，不能单独证明标题被写入。solution.disposition
区分 `stored`、`deduplicated`、`skipped-retired`、`not-eligible`；只有本次新存记忆
且使用结构约束时 titleApplied 为 true。既有内容指纹去重可能复用旧标题及旧正文
格式，不重写旧记录；已失效/被替代的记录不恢复，也不关联这次新 Evidence。

absent/rejected 自动分支继续使用现有正文整理和标题逻辑。partial/failed 会话、
solutionPolicy、实际文件变更和通过测试的判定全部沿用调用路径的既有行为。
标注一个不存在的源文件不会建立文件关联。

请求哈希必须包含**原始提交字段** handoff，先进行语义校验，不把规范化后内容
冒充原请求。相同 key/请求返回原 receipt；相同 key 但结构标注改变应冲突。旧输入
不得补写 `handoff: undefined`、空对象或新默认字段来改变旧哈希。读取旧 receipt
不得借机重算标题、增加 Evidence 或升级验证来源。

## OpenCode Host 可选传输

`--structured-handoff` 默认关闭，仅支持 OpenCode Host；不支持的 adapter 在启动
进程或创建会话前报能力错误。该 CLI 开关只适用于 `run`，其他命令会拒绝。
CLI/MCP 显式提交的可选字段不要求启用这个 Host 开关。
不新增结束阶段模型调用，不依赖 Agent 在仓库写 sidecar 文件，也不让它调用记忆工具。

```sh
repomind run --runner opencode --task "完成当前任务并交接约束与剩余工作" --structured-handoff
```

Host 开启时，在可信的运行指令中要求模型正常完成任务，并在最终自然语言交接后
输出且只输出一个结尾块：

````text
Completed the review closeout.

Require count to be an integer from 1 through 128 inclusive.

Implementation remains a separate follow-up.

```repomind-handoff
{"version":1,"constraints":["Require count to be an integer from 1 through 128 inclusive."],"remainingWork":["Implementation remains a separate follow-up."]}
```
````

模型应使用可独立引用的完整段落；字段是段落的逐字引用，不要求任何特定英文
段落标题。解析器只看 adapter 已确认的最终回答，不从工具输出、仓库文件、
思考事件、较早回复或 L1 引用里搜索。只接受一个顶层、未缩进且以回答结束的
`repomind-handoff` 围栏，后面只许有空白；用围栏状态机区分示例中嵌套的代码。
JSON 对象重复 key 亦拒绝，不能仅靠 JSON.parse 的“最后一个值覆盖”。
当前终端判定要求最终 step 只有一个非空 text 事件，紧邻 reason=stop 的终端
step_finish，且事件流无错误或畸形行。多个 text 分段的最终回答也保守回退为
`unconfirmed-final-answer`；不拼接不确定的片段。围栏必须使用精确的三反引号，
开行为 ` ```repomind-handoff`（去掉此处用于展示的前导空格），闭行为三反引号。

Host 提交中的 summary 保留**整个最终回答，包括协议块**，保证 agent_summary
Evidence 不悄悄删改。Host 内部单独携带协议围栏的范围，Core 重新验证范围和原文；
只在 accepted 时将围栏前的 prose 用作 solution 正文及段落匹配源。围栏分隔前的
空行从 prose 中剥离，但不修改段落内部内容。显式 API 直接在 summary 外传 handoff，
summary 就是 prose，不解析其中的围栏。匹配绝不能在 JSON 自身中找到“来源”。

现有 12,000 code-unit 摘要上限及 NUL 清理不能被新协议绕过。在有损处理前检测
长度/NUL/输出截断；若发生任何这些情况，拒绝结构化使用并记录原因，summary
仍按既有有界规则保存。不能声称保存了无限长原始 stdout，原始事件工件沿用原策略。
协议块自身上限 8,000 code units，超限回退。未知版本、缺失/多个块、JSON 错误、
段落不匹配也回退；不会单凭可选协议失败将成功任务改为 partial 或额外重试模型。

Host 报告的可选 `handoff` 记录 requested、persisted、summaryEvidenceId 及 audit。
`audit.disposition` 区分 accepted/absent/rejected，`reasonCodes` 记录回退原因，
`titleSource` 表示候选标题来源，`solution.titleApplied` 表示本次是否实际新存该标题。
协议接受与任务成功分别判定：partial/failed 也能有 accepted 审计，但不会因此生成
solution。abandoned 报告为 persisted=false、summaryEvidenceId=null；提交失败则
不返回声称已持久化的交接报告。

续跑只采用最后一次尝试的协议，不混合早期尝试的标注；
命令与状态仍沿用现有重试规则。新增可信提示必须在 promptSha256 计算前拼入，
并计入 promptChars；不能在审计后由 adapter 偷加提示或在 resume 中丢掉该要求。
`attempts[].prompt.{sha256,chars}` 分别审计每次 fresh/resume 的实际提示词，
`context.promptSha256/promptChars` 对应初始完整提示词。协议指令处于记忆引用
边界之外，不占 L1/L2/L3 的 contextBudgetChars，但计入完整 promptChars。
未知退出码只留在 trace/运行工件及质量判断中，不写入命令 Evidence 或
verification；后续核心规则统一后，此规则与结构化开关无关。隐藏验证检查不进入
交接验证投影。

以下为报告字段摘录（ID 和哈希省略；完整 audit 还含原文标注和验证引用）：

```json
{
  "handoff": {
    "requested": true,
    "persisted": true,
    "summaryEvidenceId": "evd_...",
    "audit": {
      "disposition": "accepted",
      "reasonCodes": [],
      "titleSource": "structured-constraint",
      "solution": { "memoryId": "mem_...", "disposition": "stored", "titleApplied": true }
    }
  }
}
```

## 召回与兼容边界

结构化首版不扩展 MemoryResult，不需要额外查询 Evidence 才能渲染 L1。新的标题
和完整正文通过原有接口注入，警告和引用边界照常保留。原有召回 ID、字符数、
顺序、截断与哈希继续以最终渲染为准。未完整注入的记录不能宣称完整交接成功；
真实评估将这类样本保留但从“完整交接收益”子集中排除。

只保存在 Evidence 中的结构字段不代表模型看过。Host 报告中的协议接受率、标题
采用率、实际注入变化率必须分别统计。旧调用、旧数据库、旧模型自由文本与旧
receipt 均继续可用。回滚关闭 Host 开关即可停止请求新协议，已存记忆不批量改写。

## 验收集与实施顺序

详见 [验收清单](structured-handoff-v1/acceptance.md)。实现阶段必须先完成无模型
回归，再冻结任务与规则进行真实 OpenCode 验证，不从小样本 token 波动推断收益。

1. **Core 与显式入口**：共享 schema/语义校验、可选字段、Evidence 投影、标题、
   幂等性；CLI/MCP 和 core 直接调用全部覆盖，先不改变 Host 默认行为。
2. **OpenCode Host**：实现可选输出协议、报告原因、重试/截断行为与 prompt 审计；
   扩展 AgentOutcome、commitHostLifecycle 的内部传递，旧 adapter 返回值仍有效。
3. **冻结后验收**：先验证真实 producer 能输出被接受的结构、约束未丢失，再验证
   两个消费者版本看到同一 prose 时的实际标题处理差异，分别记录协议成本与行为。

阶段 1、2 已修改显式提交和 Host 运行时代码。首批阶段 3 已运行四次真实交接，
结构接受 4/4，但语义完整性只能确认 3/4，故未启动消费者对照。首版验收后再决定是否
将正文按结构重排或接入 Claude/交互式路径；这些变化不隐含在本设计中。

14 个设计样例已纳入运行时校验回归。新增测试覆盖 Core 持久化/回滚、CLI JSON 输入、
跨进程提交、真实 MCP 协议调用和最终召回审计。具体覆盖及未完成范围见验收清单；
新增 Host 测试覆盖事件采集、进程入口、Core 持久化、报告与召回；这些无模型测试
不代表真实 OpenCode 已可靠输出协议，或未知自然语言任务已通过真实验收。

### 首批真实验收发现

2026-10-03 使用 OpenCode 1.18.32 / `sub2api/gpt-6-luna`，冻结闭区间合并与 URL
单段编码两个新任务，各两次。四次均成功完成协调任务，协议被接受；其中一次将
“空输入返回新的空数组”写成 `support empty, negative, and zero endpoints`，
未清楚保留该边界行为。逐段原文校验无法证明 Agent 的 prose 完整覆盖仓库合同。

四份第一条 constraints 都以操作回顾开头，结构标题实际采用 1/4，但具体行为约束
标题仍为 0/4。这属于标注分类与表达问题，不是存储丢失。本批未修改冻结的协议，
也未重跑替换样本；按既定门槛停止于第一道门，不宣称消费者或 token 收益。
完整证据：`test-repomind-test/structured-handoff-real-20261003/RESULT.md`，
逐条核对见同目录 `HANDOFF-REVIEW.md`。核对由 Codex 完成，不声称独立人工审核。
