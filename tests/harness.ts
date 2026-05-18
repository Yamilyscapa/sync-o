import { Agent, run } from "@openai/agents";
import type { AgentInputItem, RunResult } from "@openai/agents";
import { buildAgent, type AgentContext } from "../src/agent.js";
import { DEFAULT_LOCALE } from "../src/prompts/system.js";
import { buildApprovalPreview } from "../src/tools/movements/preview.js";

export type ApprovalAction =
  | { match: string; approve: true }
  | { match: string; approve: false; message: string };

async function drainApprovals(
  agent: Agent<AgentContext, any>,
  resultIn: RunResult<AgentContext, Agent<AgentContext, any>>,
  ctx: AgentContext,
  policy: ApprovalAction[],
): Promise<RunResult<AgentContext, Agent<AgentContext, any>>> {
  let result = resultIn;
  let safety = 5;
  while ((result.interruptions?.length ?? 0) > 0 && safety-- > 0) {
    for (const item of result.interruptions ?? []) {
      const name = item.name ?? "unknown_tool";
      const preview = await buildApprovalPreview(name, item.arguments, ctx);
      const idx = policy.findIndex((p) => p.match === name);
      const action = idx >= 0 ? policy.splice(idx, 1)[0] : undefined;
      if (action && action.approve === false) {
        console.log(`  [approval needed] ${preview}`);
        console.log(`  [harness rejecting] ${action.message}`);
        result.state.reject(item, { message: action.message });
      } else {
        console.log(`  [approval needed] ${preview}`);
        console.log("  [harness auto-approving]");
        result.state.approve(item);
      }
    }
    result = await run(agent, result.state, { context: ctx });
  }
  return result;
}

export async function runConversation(
  turns: string[],
  ctx: AgentContext,
  approvals: ApprovalAction[] = [],
) {
  const policy = [...approvals];
  const agent = buildAgent(ctx.locale ?? DEFAULT_LOCALE);
  console.log(`U: ${turns[0]}`);
  let result = await run(agent, turns[0], { context: ctx });
  result = await drainApprovals(agent, result, ctx, policy);

  for (let i = 1; i < turns.length; i++) {
    if (result.finalOutput) console.log(`A: ${result.finalOutput}`);
    console.log(`U: ${turns[i]}`);
    const history = result.history;
    const next: AgentInputItem[] = [
      ...history,
      { type: "message", role: "user", content: turns[i] },
    ];
    result = await run(agent, next, { context: ctx });
    result = await drainApprovals(agent, result, ctx, policy);
  }

  console.log(`A: ${result.finalOutput ?? "(no final output)"}\n`);
}
