/**
 * Turn 序号计数 —— 宿主侧无状态推导。
 *
 * 一个 trace = 一个 turn（一次用户输入）。一个 turn 内的工具循环会产生多次 upstream
 * 请求，它们必须算出**相同**的 turn 序号，才能在 Langfuse 中归并到同一个 trace。
 *
 * 由于宿主侧没有逐请求的持久状态（turn 计数器在私有模块内部，不对外
 * 暴露逐 turn 序号），这里直接从 `messages` 历史推导：统计消息序列里"人类输入轮次"的
 * 数量。规则与私有模块的 turn 检测逻辑对齐：
 *   - Anthropic：user 消息含非 <system-reminder> 的 text block 即为人类输入；
 *     纯 tool_result / 纯 system-reminder 是工具循环延续。
 *   - OpenAI：role=user 且含非 <system-reminder> 文本为人类输入；role=tool 是工具循环。
 *
 * 因此：一个 turn 的首次请求与其后续工具循环请求，因为"人类轮次数"相同，turnSeq 一致。
 * 下一个 turn 的请求会多出一条人类输入 → turnSeq +1 → 新 trace。
 *
 * 注意：依赖客户端发送完整历史（Claude Code / CodeBuddy 均如此）。若客户端截断历史，
 * turnSeq 可能偏移，但同一 turn 内仍保持一致（只是绝对值漂移），不影响"同 turn 归一 trace"。
 */

/** 判断单条 user 消息内容是否为人类输入（非工具循环延续）。 */
function isHumanUserContent(content: unknown): boolean {
  if (typeof content === "string") {
    return !content.startsWith("<system-reminder>");
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b && typeof b === "object" && b.type === "text") {
        const text = (b.text as string) ?? "";
        if (!text.startsWith("<system-reminder>")) return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * 统计 messages 中"人类输入轮次"的数量，作为当前 turn 序号。
 *
 * 返回值 ≥ 1（至少当前这一轮）；空消息或无人类输入时返回 0。
 */
export function countHumanTurns(messages: unknown[], protocol: "openai" | "anthropic"): number {
  let count = 0;
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m?.role !== "user") continue;
    // OpenAI 的工具响应是 role=tool（不会进入这里）；user 消息按内容判断。
    if (protocol === "openai" || protocol === "anthropic") {
      if (isHumanUserContent(m.content)) count += 1;
    }
  }
  return count;
}
