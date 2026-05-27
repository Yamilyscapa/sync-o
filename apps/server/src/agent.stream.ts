import { run, RunState } from "@openai/agents";
import type { AgentInputItem, RunToolApprovalItem } from "@openai/agents";
import type { AgentRunOutput, StreamEvent } from "@synco/sdk";
import {
  buildAgent,
  type AgentContext,
  type ApprovalDecision,
  type PendingApproval,
} from "./agent.js";
import { DEFAULT_LOCALE } from "./prompts/system.js";
import { sanitizeAnalysisOutput } from "./agent/analysis.js";
import { buildApprovalPreview } from "./tools/movements/preview.js";
import { supabase } from "./supabase.js";
import { loadConversationForAgent } from "./db/conversations/reads.js";
import {
  appendMessages,
  clearPendingState,
  createConversation,
  setPendingState,
  type AppendMessageInput,
} from "./db/conversations/writes.js";
import {
  buildUserMessageItem,
  messagesToRecords,
  roleFromItem,
  selectWindow,
} from "./agent/history.js";

export type StreamEmit = (ev: StreamEvent) => Promise<void> | void;

function toAppendInputs(items: AgentInputItem[]): AppendMessageInput[] {
  return items.map((item) => ({ role: roleFromItem(item), payload: item }));
}

function historyUsedAnalyze(history: unknown): boolean {
  if (!Array.isArray(history)) return false;
  return history.some(
    (item) =>
      item != null &&
      typeof item === "object" &&
      (item as { type?: string }).type === "function_call" &&
      (item as { name?: string }).name === "analyze",
  );
}

async function buildApprovals(
  interruptions: RunToolApprovalItem[],
  context: AgentContext,
): Promise<PendingApproval[]> {
  return Promise.all(
    interruptions.map(async (item) => {
      const toolName = item.name ?? "unknown_tool";
      const args = item.arguments;
      return {
        toolName,
        arguments: args,
        preview: await buildApprovalPreview(toolName, args, context),
      };
    }),
  );
}

async function pumpTextStream(
  streamResult: { toTextStream: (opts?: any) => any },
  emit: StreamEmit,
): Promise<void> {
  const ts: any = streamResult.toTextStream();
  const reader = ts.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) await emit({ type: "token", delta: String(value) });
  }
}

export async function runAgentStream(
  input: string,
  context: AgentContext,
  emit: StreamEmit,
): Promise<void> {
  const locale = context.locale ?? DEFAULT_LOCALE;
  const agent = buildAgent(locale);

  let conversationId = context.conversationId;
  let priorRecords: { seq: number; item: AgentInputItem }[] = [];
  let priorSummary: string | null = null;

  if (!conversationId) {
    if (!context.organizationId) {
      throw new Error("organizationId required to start a conversation");
    }
    const created = await createConversation(supabase, {
      organizationId: context.organizationId,
      userId: context.userId,
      firstUserInput: input,
    });
    conversationId = created.id;
  } else {
    const loaded = await loadConversationForAgent(supabase, conversationId);
    if (!loaded) throw new Error(`conversation ${conversationId} not found`);
    priorRecords = messagesToRecords(loaded.messages);
    priorSummary = loaded.conversation.summary;
  }

  const { window } = selectWindow(priorRecords);
  const items: AgentInputItem[] = [];
  if (priorSummary && priorRecords.length > window.length) {
    items.push(
      buildUserMessageItem(`[Resumen de turnos anteriores]: ${priorSummary}`),
    );
  }
  items.push(...window);
  const newUserItem = buildUserMessageItem(input);
  items.push(newUserItem);

  const effectiveContext: AgentContext = { ...context, conversationId };
  const streamResult = await run(agent, items, {
    context: effectiveContext,
    stream: true,
  });

  await pumpTextStream(streamResult, emit);
  await streamResult.completed;

  const agentNewItems = (streamResult.history as AgentInputItem[]).slice(items.length);
  await appendMessages(
    supabase,
    conversationId,
    toAppendInputs([newUserItem, ...agentNewItems]),
  );

  const interruptions = streamResult.interruptions ?? [];
  if (interruptions.length > 0) {
    const approvals = await buildApprovals(interruptions, effectiveContext);
    const serializedState = streamResult.state.toString();
    await setPendingState(supabase, conversationId, serializedState, approvals);
    await emit({
      type: "approval_required",
      approvals,
      serializedState,
      conversationId,
    });
    const result: AgentRunOutput = {
      kind: "awaiting_approval",
      conversationId,
      serializedState,
      approvals,
    };
    await emit({ type: "done", result });
    return;
  }

  await clearPendingState(supabase, conversationId);
  const raw = streamResult.finalOutput as string | undefined;
  const output =
    raw && historyUsedAnalyze(streamResult.history)
      ? sanitizeAnalysisOutput(raw, locale)
      : raw;
  const result: AgentRunOutput = { kind: "final", conversationId, output };
  await emit({ type: "done", result });
}

export async function resumeAgentStream(
  serializedStateOrNull: string | null,
  decisions: ApprovalDecision[],
  context: AgentContext,
  emit: StreamEmit,
): Promise<void> {
  const locale = context.locale ?? DEFAULT_LOCALE;
  const agent = buildAgent(locale);

  let serializedState = serializedStateOrNull;
  let conversationId = context.conversationId;
  let priorRecords: { seq: number; item: AgentInputItem }[] = [];

  if (!serializedState) {
    if (!conversationId) {
      throw new Error("resume requires serializedState or conversationId");
    }
    const loaded = await loadConversationForAgent(supabase, conversationId);
    if (!loaded) throw new Error(`conversation ${conversationId} not found`);
    if (!loaded.conversation.pending_state) {
      throw new Error(`conversation ${conversationId} has no pending state`);
    }
    serializedState = loaded.conversation.pending_state;
    priorRecords = messagesToRecords(loaded.messages);
  } else if (conversationId) {
    const loaded = await loadConversationForAgent(supabase, conversationId);
    if (loaded) priorRecords = messagesToRecords(loaded.messages);
  }

  const state = await RunState.fromString(agent, serializedState);

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

  const effectiveContext: AgentContext = { ...context, conversationId };
  const streamResult = await run(agent, state, {
    context: effectiveContext,
    stream: true,
  });

  await pumpTextStream(streamResult, emit);
  await streamResult.completed;

  if (conversationId) {
    const history = streamResult.history as AgentInputItem[];
    const dbCount = priorRecords.length;
    const newItems = history.slice(dbCount);
    if (newItems.length > 0) {
      await appendMessages(supabase, conversationId, toAppendInputs(newItems));
    }
  }

  const interruptions = streamResult.interruptions ?? [];
  if (interruptions.length > 0 && conversationId) {
    const approvals = await buildApprovals(interruptions, effectiveContext);
    const newSerialized = streamResult.state.toString();
    await setPendingState(supabase, conversationId, newSerialized, approvals);
    await emit({
      type: "approval_required",
      approvals,
      serializedState: newSerialized,
      conversationId,
    });
    const result: AgentRunOutput = {
      kind: "awaiting_approval",
      conversationId,
      serializedState: newSerialized,
      approvals,
    };
    await emit({ type: "done", result });
    return;
  }

  if (conversationId) await clearPendingState(supabase, conversationId);
  const raw = streamResult.finalOutput as string | undefined;
  const output =
    raw && historyUsedAnalyze(streamResult.history)
      ? sanitizeAnalysisOutput(raw, locale)
      : raw;
  const result: AgentRunOutput = {
    kind: "final",
    conversationId: conversationId ?? "",
    output,
  };
  await emit({ type: "done", result });
}
