/**
 * mem:help — 返回支持的命令列表及示例
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";

const HELP_TEXT = `**支持的 mem: 命令：**

| 命令 | 说明 |
|------|------|
| \`mem:sync\` | 刷新本次会话的全部资产注入（Skill / 记忆 / Knowledge / Task & Agent 描述） |
| \`mem:create-skill [提示词]\` | 把本次对话归档为 Skill，后台异步提取 |
| \`mem:help\` | 显示本帮助 |

**示例：**
\`\`\`
mem:sync
mem:create-skill 重点总结数据库迁移步骤和踩坑
mem:help
\`\`\`

标准格式为 \`mem:<command>\`，冒号后不加空格。命令名大小写不敏感。`;

export function getHelpText(): string {
  return HELP_TEXT;
}

export async function executeHelp(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const response = buildMemResponse(HELP_TEXT, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });
  return {
    success: true,
    messageText: HELP_TEXT,
    response,
  };
}
