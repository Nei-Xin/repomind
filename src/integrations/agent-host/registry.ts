import { RepoMindError } from "../../errors.js";
import {
  createClaudeHostAdapter,
} from "../claude/adapter.js";
import {
  createOpenCodeHostAdapter,
} from "../opencode/adapter.js";
import type { AgentHostAdapter, AgentProcessExecutor } from "./types.js";

export const REGISTERED_AGENT_HOST_IDS = ["opencode", "claude"] as const;
export type RegisteredAgentHostId = typeof REGISTERED_AGENT_HOST_IDS[number];

export interface AgentHostAdapterFactoryOptions {
  executable?: string;
  execute?: AgentProcessExecutor;
  trustedIsolatedCheckout?: boolean;
}

export function isRegisteredAgentHostId(value: string): value is RegisteredAgentHostId {
  return (REGISTERED_AGENT_HOST_IDS as readonly string[]).includes(value);
}

export function createAgentHostAdapter(
  id: RegisteredAgentHostId,
  options?: AgentHostAdapterFactoryOptions,
): AgentHostAdapter<RegisteredAgentHostId>;
export function createAgentHostAdapter(
  id: string,
  options?: AgentHostAdapterFactoryOptions,
): AgentHostAdapter;
export function createAgentHostAdapter(
  id: string,
  options: AgentHostAdapterFactoryOptions = {},
): AgentHostAdapter {
  const common = {
    ...(options.executable === undefined ? {} : { executable: options.executable }),
    ...(options.execute === undefined ? {} : { execute: options.execute }),
  };
  if (id === "opencode") return createOpenCodeHostAdapter(common);
  if (id === "claude") return createClaudeHostAdapter({
    ...common,
    ...(options.trustedIsolatedCheckout === undefined
      ? {}
      : { trustedIsolatedCheckout: options.trustedIsolatedCheckout }),
  });
  throw new RepoMindError("INVALID_INPUT", `Unsupported Agent host adapter ${id}`);
}
