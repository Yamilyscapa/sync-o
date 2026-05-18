import { Agent, run, RunState } from "@openai/agents";
import type { AgentInputItem, RunResult, RunToolApprovalItem } from "@openai/agents";
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

// ! Debug harness: bypasses RLS via service-role client. Remove before production.
const ctx: AgentContext = {
  userId: "6ee2e332-c8cc-4dec-b353-7cc511376dc3",
  organizationId: "65a88725-aa99-4e0f-b079-cab78725b87b",
  useServiceRole: true,
};

// Single-turn = string. Multi-turn = string[] (subsequent strings are user replies
// threaded as conversation history, used to exercise clarification flows).
const prompts: Array<string | string[]> = [
  "What is the stock of IND-001?",
  "Ingresaron 50 tornillos al almacén.",
  "Vendí 3 taladros.",
  // Ambiguous outflow — agent should ask first; harness replies "dale" → uses default `sale`.
  ["Saca 10 tornillos.", "Dale, registralo."],
  // Ambiguous outflow where the user supplies the reason on follow-up.
  ["Quita 5 tornillos del inventario.", "Es por merma."],
  "Muestra el historial de IND-001.",
  "Ajusta el stock de aceite de oliva: el conteo físico dio 55.",
  "¿Qué movimientos hubo recientemente?",
  // Reversal flow: register wrong intake, then undo it.
  ["Ingresaron 200 tornillos al almacén.", "Espera, fue un error. Deshaz ese último ingreso."],
  // User says "borra" — agent must redirect to reversal (append-only ledger).
  ["Ingresaron 7 tornillos.", "Borra ese último ingreso, fue equivocado."],
  // Distinguish reversal from correction: legitimate sale followed by a new sale, not a reversal.
  ["Vendí 2 tornillos.", "Ah no, fueron 4 los que vendí, registra los 2 que faltan."],
  // Idempotency: double reversal must fail with "ya fue reversado".
  ["Vendí 1 tornillo.", "Reversa ese movimiento.", "Reversa otra vez ese movimiento."],
];

async function drainApprovals(
  agent: Agent<AgentContext, any>,
  resultIn: RunResult<AgentContext, Agent<AgentContext, any>>,
): Promise<RunResult<AgentContext, Agent<AgentContext, any>>> {
  let result = resultIn;
  let safety = 5;
  while ((result.interruptions?.length ?? 0) > 0 && safety-- > 0) {
    for (const item of result.interruptions ?? []) {
      const name = item.name ?? "unknown_tool";
      const preview = await buildApprovalPreview(name, item.arguments, ctx);
      console.log(`  [approval needed] ${preview}`);
      result.state.approve(item);
    }
    console.log("  [harness auto-approving]");
    result = await run(agent, result.state, { context: ctx });
  }
  return result;
}

async function runConversation(turns: string[]) {
  const agent = buildAgent(ctx.locale ?? DEFAULT_LOCALE);
  console.log(`U: ${turns[0]}`);
  let result = await run(agent, turns[0], { context: ctx });
  result = await drainApprovals(agent, result);

  for (let i = 1; i < turns.length; i++) {
    if (result.finalOutput) console.log(`A: ${result.finalOutput}`);
    console.log(`U: ${turns[i]}`);
    const history = result.history;
    const next: AgentInputItem[] = [
      ...history,
      { type: "message", role: "user", content: turns[i] },
    ];
    result = await run(agent, next, { context: ctx });
    result = await drainApprovals(agent, result);
  }

  console.log(`A: ${result.finalOutput ?? "(no final output)"}\n`);
}

for (const p of prompts) {
  await runConversation(Array.isArray(p) ? p : [p]);
}
