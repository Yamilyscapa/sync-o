import { z } from "zod";

export const ConversationStatusSchema = z.enum([
  "active",
  "awaiting_approval",
  "archived",
]);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

export const ConversationRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
  "tool",
]);
export type ConversationRole = z.infer<typeof ConversationRoleSchema>;

export const PendingApprovalEntrySchema = z.object({
  toolName: z.string(),
  arguments: z.string().optional(),
  preview: z.string(),
});
export type PendingApprovalEntry = z.infer<typeof PendingApprovalEntrySchema>;

export const ConversationSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  user_id: z.string(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  summary_through_seq: z.coerce.number().int().nullable(),
  status: ConversationStatusSchema,
  pending_state: z.string().nullable(),
  pending_approvals: z.array(PendingApprovalEntrySchema).nullable(),
  last_message_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const ConversationSummarySchema = ConversationSchema.pick({
  id: true,
  title: true,
  summary: true,
  status: true,
  last_message_at: true,
  created_at: true,
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationMessageSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  seq: z.coerce.number().int(),
  role: ConversationRoleSchema,
  payload: z.unknown(),
  created_at: z.string(),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export type ConversationError =
  | { kind: "not_found"; conversationId: string }
  | { kind: "cross_org"; message: string }
  | { kind: "not_owner"; message: string }
  | { kind: "unknown"; message: string };
