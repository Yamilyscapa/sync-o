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
    model: "gpt-4o-mini",
    tools,
  });

function toOutput(result: {
  interruptions?: RunToolApprovalItem[];
  finalOutput?: unknown;
  state: { toString(): string };
}): AgentRunOutput {
  const interruptions = result.interruptions ?? [];
  if (interruptions.length === 0) {
    return { kind: "final", output: result.finalOutput as string | undefined };
  }
  const approvals: PendingApproval[] = interruptions.map((item: RunToolApprovalItem) => {
    const toolName = item.name ?? "unknown_tool";
    const args = item.arguments;
    return {
      toolName,
      arguments: args,
      preview: buildApprovalPreview(toolName, args),
    };
  });
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
  return toOutput(result);
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
  return toOutput(result);
};

// ! Debug harness: bypasses RLS via service-role client. Remove before production.
const ctx: AgentContext = {
  userId: "6ee2e332-c8cc-4dec-b353-7cc511376dc3",
  organizationId: "65a88725-aa99-4e0f-b079-cab78725b87b",
  useServiceRole: true,
};

const prompts = [
  "What is the stock of IND-001?",
  "Ingresaron 50 tornillos al almacén.",
  "Vendí 3 taladros.",
  "Muestra el historial de IND-001.",
  "Ajusta el stock de aceite de oliva: el conteo físico dio 55.",
  "Saca 1000 tornillos.",
  "¿Qué movimientos hubo recientemente?",
];

async function runHarness(input: string) {
  console.log(`Q: ${input}`);
  let res = await runAgent(input, ctx);
  let safety = 5;
  while (res.kind === "awaiting_approval" && safety-- > 0) {
    for (const a of res.approvals) {
      console.log(`  [approval needed] ${a.preview}`);
    }
    const decisions: ApprovalDecision[] = res.approvals.map((a) => ({
      toolName: a.toolName,
      approved: true, // harness auto-approves
    }));
    console.log("  [harness auto-approving]");
    res = await resumeAgent(res.serializedState, decisions, ctx);
  }
  if (res.kind === "final") console.log(`A: ${res.output}\n`);
  else console.log(`A: (still awaiting approval after retries)\n`);
}

for (const p of prompts) {
  await runHarness(p);
}
