import { Agent, run, RunState } from "@openai/agents";
import type { RunToolApprovalItem } from "@openai/agents";
import { buildSystemPrompt, DEFAULT_LOCALE, type Locale } from "./prompts/system.js";
import { tools } from "./tools/index.js";
import { buildApprovalPreview } from "./tools/movements/preview.js";

/**
 * Agent context is restricted to SERIALIZABLE values only. The Supabase
 * client is non-serializable (cyclic refs) and would break HITL state
 * persistence; resolve it inside tools via `getSupabaseFromContext(ctx)`.
 */
export type AgentContext = {
  userId: string;
  organizationId?: string;
  locale?: Locale;
  jwt?: string;
  useServiceRole?: boolean;
};

export type PendingApproval = {
  toolName: string;
  arguments: string | undefined;
  preview: string;
};

export type AgentRunOutput =
  | { kind: "final"; output: string | undefined }
  | { kind: "awaiting_approval"; serializedState: string; approvals: PendingApproval[] };

export const buildAgent = (locale: Locale = DEFAULT_LOCALE) =>
  new Agent<AgentContext>({
    name: "sync-o",
    instructions: buildSystemPrompt(locale),
    model: "gpt-5-mini",
    modelSettings: {
      // Extend OpenAI's prompt-prefix cache from the default ~5-10 min to 24h.
      // System prompt + tool definitions are stable across turns and across
      // users; extending retention slashes input-token cost on cache hits
      // (cached input is ~90% cheaper than fresh input for gpt-5-mini).
      promptCacheRetention: "24h",
    },
    tools,
  });

async function toOutput(
  result: {
    interruptions?: RunToolApprovalItem[];
    finalOutput?: unknown;
    state: { toString(): string };
  },
  context: AgentContext,
): Promise<AgentRunOutput> {
  const interruptions = result.interruptions ?? [];
  if (interruptions.length === 0) {
    return { kind: "final", output: result.finalOutput as string | undefined };
  }
  const approvals: PendingApproval[] = await Promise.all(
    interruptions.map(async (item: RunToolApprovalItem) => {
      const toolName = item.name ?? "unknown_tool";
      const args = item.arguments;
      return {
        toolName,
        arguments: args,
        preview: await buildApprovalPreview(toolName, args, context),
      };
    }),
  );
  return {
    kind: "awaiting_approval",
    serializedState: result.state.toString(),
    approvals,
  };
}

export const runAgent = async (
  input: string,
  context: AgentContext,
): Promise<AgentRunOutput> => {
  const agent = buildAgent(context.locale ?? DEFAULT_LOCALE);
  const result = await run(agent, input, { context });
  return toOutput(result, context);
};

export type ApprovalDecision = {
  toolName: string;
  approved: boolean;
  rejectionMessage?: string;
};

export const resumeAgent = async (
  serializedState: string,
  decisions: ApprovalDecision[],
  context: AgentContext,
): Promise<AgentRunOutput> => {
  const agent = buildAgent(context.locale ?? DEFAULT_LOCALE);
  const state = await RunState.fromString(agent, serializedState);

  // Match each interruption to its decision by tool name (FIFO when duplicates).
  const pending = state.getInterruptions();
  const queueByName = new Map<string, ApprovalDecision[]>();
  for (const d of decisions) {
    const arr = queueByName.get(d.toolName) ?? [];
    arr.push(d);
    queueByName.set(d.toolName, arr);
  }

  for (const item of pending) {
    const name = item.name ?? "unknown_tool";
    const queue = queueByName.get(name);
    const decision = queue?.shift();
    if (!decision) {
      state.reject(item, { message: "No approval provided; rejecting by default." });
      continue;
    }
    if (decision.approved) state.approve(item);
    else state.reject(item, { message: decision.rejectionMessage });
  }

  const result = await run(agent, state, { context });
  return toOutput(result, context);
};
