import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  ConversationSchema,
  type Conversation,
  type ConversationRole,
  type PendingApprovalEntry,
} from "./schema.js";

const CONVERSATION_COLS =
  "id, organization_id, user_id, title, summary, summary_through_seq, status, pending_state, pending_approvals, last_message_at, created_at, updated_at";

const TITLE_MAX_CHARS = 60;

function deriveTitle(firstUserInput: string): string {
  const trimmed = firstUserInput.trim().replace(/\s+/g, " ");
  if (trimmed.length <= TITLE_MAX_CHARS) return trimmed;
  return trimmed.slice(0, TITLE_MAX_CHARS - 1).trimEnd() + "…";
}

export async function createConversation(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    userId: string;
    firstUserInput: string;
  },
): Promise<Conversation> {
  const { data, error } = await supabase
    .from("conversations")
    .insert({
      organization_id: params.organizationId,
      user_id: params.userId,
      title: deriveTitle(params.firstUserInput),
    })
    .select(CONVERSATION_COLS)
    .single();
  if (error) throw new Error(error.message);
  return ConversationSchema.parse(data);
}

export type AppendMessageInput = {
  role: ConversationRole;
  payload: unknown;
};

export async function appendMessages(
  supabase: SupabaseClient,
  conversationId: string,
  items: AppendMessageInput[],
): Promise<void> {
  if (items.length === 0) return;
  const rows = items.map((it) => ({
    conversation_id: conversationId,
    role: it.role,
    payload: it.payload,
  }));
  const { error } = await supabase.from("conversation_messages").insert(rows);
  if (error) throw new Error(error.message);
  // Touch last_message_at; updated_at handled by trigger.
  const touch = await supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);
  if (touch.error) throw new Error(touch.error.message);
}

export async function setPendingState(
  supabase: SupabaseClient,
  conversationId: string,
  serializedState: string,
  approvals: PendingApprovalEntry[],
): Promise<void> {
  const { error } = await supabase
    .from("conversations")
    .update({
      status: "awaiting_approval",
      pending_state: serializedState,
      pending_approvals: approvals,
    })
    .eq("id", conversationId);
  if (error) throw new Error(error.message);
}

export async function clearPendingState(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<void> {
  const { error } = await supabase
    .from("conversations")
    .update({
      status: "active",
      pending_state: null,
      pending_approvals: null,
    })
    .eq("id", conversationId);
  if (error) throw new Error(error.message);
}

export const SetSummaryInputSchema = z.object({
  summary: z.string().min(1).max(1000),
  throughSeq: z.number().int().nonnegative(),
});
export type SetSummaryInput = z.infer<typeof SetSummaryInputSchema>;

export async function setSummary(
  supabase: SupabaseClient,
  conversationId: string,
  input: SetSummaryInput,
): Promise<void> {
  const parsed = SetSummaryInputSchema.parse(input);
  const { error } = await supabase
    .from("conversations")
    .update({
      summary: parsed.summary,
      summary_through_seq: parsed.throughSeq,
    })
    .eq("id", conversationId);
  if (error) throw new Error(error.message);
}
