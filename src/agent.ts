import { Agent, run, RunState } from "@openai/agents";
import type { AgentInputItem, RunToolApprovalItem } from "@openai/agents";
import { buildSystemPrompt, DEFAULT_LOCALE, type Locale } from "./prompts/system.js";
import { tools } from "./tools/index.js";
import { buildApprovalPreview } from "./tools/movements/preview.js";
import { supabase } from "./supabase.js";
import {
  loadConversationForAgent,
} from "./db/conversations/reads.js";
import {
  appendMessages,
  clearPendingState,
  createConversation,
  setPendingState,
  setSummary,
  type AppendMessageInput,
} from "./db/conversations/writes.js";
import {
  buildUserMessageItem,
  messagesToRecords,
  roleFromItem,
  selectWindow,
} from "./agent/history.js";
import { summarizeForConversation } from "./agent/summary.js";

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
  conversationId?: string;
};

export type PendingApproval = {
  toolName: string;
  arguments: string | undefined;
  preview: string;
};

export type AgentRunOutput =
  | { kind: "final"; conversationId: string; output: string | undefined }
  | {
      kind: "awaiting_approval";
      conversationId: string;
      serializedState: string;
      approvals: PendingApproval[];
    };

export const buildAgent = (locale: Locale = DEFAULT_LOCALE) =>
  new Agent<AgentContext>({
    name: "sync-o",
    instructions: buildSystemPrompt(locale),
    model: "gpt-5-mini",
    modelSettings: {
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
  conversationId: string,
  context: AgentContext,
): Promise<AgentRunOutput> {
  const interruptions = result.interruptions ?? [];
  if (interruptions.length === 0) {
    return { kind: "final", conversationId, output: result.finalOutput as string | undefined };
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
    conversationId,
    serializedState: result.state.toString(),
    approvals,
  };
}

function toAppendInputs(items: AgentInputItem[]): AppendMessageInput[] {
  return items.map((item) => ({ role: roleFromItem(item), payload: item }));
}

async function maybeRegenSummary(
  conversationId: string,
  locale: Locale,
  allItemRecords: { seq: number; item: AgentInputItem }[],
  priorSummary: string | null,
  priorSummaryThroughSeq: number | null,
): Promise<void> {
  const { droppedItems, droppedThroughSeq } = selectWindow(allItemRecords);
  if (droppedThroughSeq === null) return;
  if (priorSummaryThroughSeq !== null && droppedThroughSeq <= priorSummaryThroughSeq) return;
  // Only feed the items newly dropped (past the prior boundary) to the summarizer;
  // the prior summary already encodes everything <= priorSummaryThroughSeq.
  const newlyDropped = droppedItems.filter((_, idx) => {
    const seq = allItemRecords.find((r) => r.item === droppedItems[idx])?.seq;
    return seq !== undefined && (priorSummaryThroughSeq === null || seq > priorSummaryThroughSeq);
  });
  try {
    const next = await summarizeForConversation(newlyDropped, priorSummary, locale);
    await setSummary(supabase, conversationId, {
      summary: next,
      throughSeq: droppedThroughSeq,
    });
  } catch (e) {
    console.error(`[summary] failed for ${conversationId}:`, e);
  }
}

export const runAgent = async (
  input: string,
  context: AgentContext,
): Promise<AgentRunOutput> => {
  const locale = context.locale ?? DEFAULT_LOCALE;
  const agent = buildAgent(locale);

  let conversationId = context.conversationId;
  let priorRecords: { seq: number; item: AgentInputItem }[] = [];
  let priorSummary: string | null = null;
  let priorSummaryThroughSeq: number | null = null;

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
    if (!loaded) {
      throw new Error(`conversation ${conversationId} not found`);
    }
    priorRecords = messagesToRecords(loaded.messages);
    priorSummary = loaded.conversation.summary;
    priorSummaryThroughSeq = loaded.conversation.summary_through_seq;
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
  const result = await run(agent, items, { context: effectiveContext });

  // Persist new user input + everything the agent produced this turn.
  const agentNewItems = (result.history as AgentInputItem[]).slice(items.length);
  await appendMessages(
    supabase,
    conversationId,
    toAppendInputs([newUserItem, ...agentNewItems]),
  );

  const output = await toOutput(result, conversationId, effectiveContext);

  if (output.kind === "awaiting_approval") {
    await setPendingState(
      supabase,
      conversationId,
      output.serializedState,
      output.approvals,
    );
  } else {
    // If we were previously pending (resumed from awaiting_approval), clear.
    // No-op if already 'active'; cheap idempotent update.
    await clearPendingState(supabase, conversationId);
    const allRecords = [
      ...priorRecords,
      ...[newUserItem, ...agentNewItems].map((item, i) => ({
        seq: (priorRecords.at(-1)?.seq ?? 0) + i + 1,
        item,
      })),
    ];
    void maybeRegenSummary(
      conversationId,
      locale,
      allRecords,
      priorSummary,
      priorSummaryThroughSeq,
    );
  }

  return output;
};

export type ApprovalDecision = {
  toolName: string;
  approved: boolean;
  rejectionMessage?: string;
};

export const resumeAgent = async (
  serializedStateOrNull: string | null,
  decisions: ApprovalDecision[],
  context: AgentContext,
): Promise<AgentRunOutput> => {
  const locale = context.locale ?? DEFAULT_LOCALE;
  const agent = buildAgent(locale);

  let serializedState = serializedStateOrNull;
  let conversationId = context.conversationId;
  let priorRecords: { seq: number; item: AgentInputItem }[] = [];
  let priorSummary: string | null = null;
  let priorSummaryThroughSeq: number | null = null;

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
    priorSummary = loaded.conversation.summary;
    priorSummaryThroughSeq = loaded.conversation.summary_through_seq;
  } else if (conversationId) {
    const loaded = await loadConversationForAgent(supabase, conversationId);
    if (loaded) {
      priorRecords = messagesToRecords(loaded.messages);
      priorSummary = loaded.conversation.summary;
      priorSummaryThroughSeq = loaded.conversation.summary_through_seq;
    }
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
  const result = await run(agent, state, { context: effectiveContext });

  // Persist anything in result.history past what is already in DB.
  if (conversationId) {
    const dbCount = priorRecords.length;
    const history = result.history as AgentInputItem[];
    const newItems = history.slice(dbCount);
    if (newItems.length > 0) {
      await appendMessages(supabase, conversationId, toAppendInputs(newItems));
    }
  }

  const output = await toOutput(
    result,
    conversationId ?? "",
    effectiveContext,
  );

  if (conversationId) {
    if (output.kind === "awaiting_approval") {
      await setPendingState(
        supabase,
        conversationId,
        output.serializedState,
        output.approvals,
      );
    } else {
      await clearPendingState(supabase, conversationId);
      const history = result.history as AgentInputItem[];
      const allRecords = history.map((item, i) => ({
        seq:
          i < priorRecords.length
            ? priorRecords[i]!.seq
            : (priorRecords.at(-1)?.seq ?? 0) + (i - priorRecords.length) + 1,
        item,
      }));
      void maybeRegenSummary(
        conversationId,
        locale,
        allRecords,
        priorSummary,
        priorSummaryThroughSeq,
      );
    }
  }

  return output;
};
