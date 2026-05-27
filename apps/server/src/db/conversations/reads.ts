import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  ConversationMessageSchema,
  ConversationSchema,
  ConversationSummarySchema,
  type Conversation,
  type ConversationMessage,
  type ConversationSummary,
} from "./schema.js";

const CONVERSATION_COLS =
  "id, organization_id, user_id, title, summary, summary_through_seq, status, pending_state, pending_approvals, last_message_at, created_at, updated_at";

const CONVERSATION_SUMMARY_COLS =
  "id, title, summary, status, last_message_at, created_at";

const MESSAGE_COLS =
  "id, conversation_id, seq, role, payload, created_at";

export async function listConversations(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<ConversationSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  let q = supabase
    .from("conversations")
    .select(CONVERSATION_SUMMARY_COLS)
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .order("last_message_at", { ascending: false })
    .limit(limit);
  if (opts.before) q = q.lt("last_message_at", opts.before);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return z.array(ConversationSummarySchema).parse(data ?? []);
}

export async function getConversation(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string,
  conversationId: string,
): Promise<
  | { header: Conversation; messages: ConversationMessage[] }
  | null
> {
  const headerQ = await supabase
    .from("conversations")
    .select(CONVERSATION_COLS)
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .eq("id", conversationId)
    .maybeSingle();
  if (headerQ.error) throw new Error(headerQ.error.message);
  if (!headerQ.data) return null;
  const header = ConversationSchema.parse(headerQ.data);

  const msgQ = await supabase
    .from("conversation_messages")
    .select(MESSAGE_COLS)
    .eq("conversation_id", conversationId)
    .order("seq", { ascending: true });
  if (msgQ.error) throw new Error(msgQ.error.message);
  const messages = z.array(ConversationMessageSchema).parse(msgQ.data ?? []);
  return { header, messages };
}

export type AgentHistoryLoad = {
  conversation: Conversation;
  messages: ConversationMessage[];
};

/**
 * Service-role read: returns ALL messages for the conversation. The caller
 * (agent layer) applies the bounded-window policy in `src/agent/history.ts`.
 * We read everything because window selection requires pair-safety walks on
 * function_call ↔ function_call_result and the row count per conversation is
 * bounded by application limits anyway (long threads get summarized + reset).
 */
export async function loadConversationForAgent(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<AgentHistoryLoad | null> {
  const headerQ = await supabase
    .from("conversations")
    .select(CONVERSATION_COLS)
    .eq("id", conversationId)
    .maybeSingle();
  if (headerQ.error) throw new Error(headerQ.error.message);
  if (!headerQ.data) return null;
  const conversation = ConversationSchema.parse(headerQ.data);

  const msgQ = await supabase
    .from("conversation_messages")
    .select(MESSAGE_COLS)
    .eq("conversation_id", conversationId)
    .order("seq", { ascending: true });
  if (msgQ.error) throw new Error(msgQ.error.message);
  const messages = z.array(ConversationMessageSchema).parse(msgQ.data ?? []);
  return { conversation, messages };
}
