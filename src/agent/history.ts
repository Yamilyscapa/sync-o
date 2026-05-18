import type { AgentInputItem } from "@openai/agents";
import type { ConversationMessage, ConversationRole } from "../db/conversations/schema.js";

export const HISTORY_WINDOW_ITEMS = 40;
export const HISTORY_TOKEN_BUDGET_CHARS = 24_000;

type ItemRecord = { seq: number; item: AgentInputItem };

type RawItem = {
  type?: string;
  role?: string;
  callId?: string | null;
};

function asRaw(item: unknown): RawItem {
  return (item ?? {}) as RawItem;
}

export function roleFromItem(item: AgentInputItem): ConversationRole {
  const raw = asRaw(item);
  if (raw.type === "function_call" || raw.type === "function_call_result") return "tool";
  if (raw.type === "tool_search_call" || raw.type === "tool_search_output") return "tool";
  if (raw.type === "computer_call" || raw.type === "computer_call_result") return "tool";
  if (raw.type === "shell_call" || raw.type === "shell_call_result") return "tool";
  if (raw.type === "apply_patch_call" || raw.type === "apply_patch_call_result") return "tool";
  if (raw.type === "hosted_tool_call") return "tool";
  if (raw.type === "reasoning") return "assistant";
  if (raw.role === "user") return "user";
  if (raw.role === "assistant") return "assistant";
  if (raw.role === "system") return "system";
  return "assistant";
}

function approxChars(item: AgentInputItem): number {
  return JSON.stringify(item).length;
}

function callIdOf(item: AgentInputItem): string | null {
  const raw = asRaw(item);
  return raw.callId ?? null;
}

function isFunctionCall(item: AgentInputItem): boolean {
  return asRaw(item).type === "function_call";
}

function isFunctionCallResult(item: AgentInputItem): boolean {
  return asRaw(item).type === "function_call_result";
}

export type WindowSelection = {
  window: AgentInputItem[];
  droppedItems: AgentInputItem[];
  droppedThroughSeq: number | null;
};

/**
 * Greedy newest→oldest window. Enforces both item count and char-budget caps,
 * then expands to keep every function_call ↔ function_call_result pair intact
 * (model rejects orphaned tool turns).
 */
export function selectWindow(messages: ItemRecord[]): WindowSelection {
  if (messages.length === 0) {
    return { window: [], droppedItems: [], droppedThroughSeq: null };
  }

  const includedIdx = new Set<number>();
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const next = approxChars(messages[i]!.item);
    if (includedIdx.size >= HISTORY_WINDOW_ITEMS) break;
    if (chars + next > HISTORY_TOKEN_BUDGET_CHARS && includedIdx.size > 0) break;
    includedIdx.add(i);
    chars += next;
  }

  // Pair-safety: ensure every function_call has its result and vice versa.
  const callIdToCallIdx = new Map<string, number>();
  const callIdToResultIdx = new Map<string, number>();
  messages.forEach((m, i) => {
    const cid = callIdOf(m.item);
    if (!cid) return;
    if (isFunctionCall(m.item)) callIdToCallIdx.set(cid, i);
    else if (isFunctionCallResult(m.item)) callIdToResultIdx.set(cid, i);
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (const i of [...includedIdx]) {
      const item = messages[i]!.item;
      const cid = callIdOf(item);
      if (!cid) continue;
      if (isFunctionCall(item)) {
        const r = callIdToResultIdx.get(cid);
        if (r !== undefined && !includedIdx.has(r)) {
          includedIdx.add(r);
          changed = true;
        }
      } else if (isFunctionCallResult(item)) {
        const c = callIdToCallIdx.get(cid);
        if (c !== undefined && !includedIdx.has(c)) {
          includedIdx.add(c);
          changed = true;
        }
      }
    }
  }

  const sortedIncluded = [...includedIdx].sort((a, b) => a - b);
  const window = sortedIncluded.map((i) => messages[i]!.item);
  const dropped: ItemRecord[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!includedIdx.has(i)) dropped.push(messages[i]!);
  }
  const droppedThroughSeq =
    dropped.length === 0 ? null : Math.max(...dropped.map((d) => d.seq));
  return {
    window,
    droppedItems: dropped.map((d) => d.item),
    droppedThroughSeq,
  };
}

export function buildUserMessageItem(text: string): AgentInputItem {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  } as AgentInputItem;
}

export function messagesToRecords(rows: ConversationMessage[]): ItemRecord[] {
  return rows.map((r) => ({ seq: r.seq, item: r.payload as AgentInputItem }));
}
