import { z } from "zod";

export const PendingApprovalSchema = z.object({
  toolName: z.string(),
  arguments: z.string().optional(),
  preview: z.string(),
});
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;

export const AgentRunOutputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("final"),
    conversationId: z.string(),
    output: z.string().optional(),
  }),
  z.object({
    kind: z.literal("awaiting_approval"),
    conversationId: z.string(),
    serializedState: z.string(),
    approvals: z.array(PendingApprovalSchema),
  }),
]);
export type AgentRunOutput = z.infer<typeof AgentRunOutputSchema>;

export const ApprovalDecisionSchema = z.object({
  toolName: z.string(),
  approved: z.boolean(),
  rejectionMessage: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const AgentRunInputSchema = z.object({
  input: z.string().min(1),
  organizationId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
});
export type AgentRunInput = z.infer<typeof AgentRunInputSchema>;

export const AgentResumeInputSchema = z.object({
  serializedState: z.string().optional(),
  conversationId: z.string().uuid().optional(),
  decisions: z.array(ApprovalDecisionSchema),
});
export type AgentResumeInput = z.infer<typeof AgentResumeInputSchema>;

export const ConversationSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  updated_at: z.string(),
  created_at: z.string(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationMessageSchema = z.object({
  seq: z.number(),
  role: z.string(),
  payload: z.unknown(),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const ConversationDetailSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  pending_approvals: z.array(PendingApprovalSchema).nullable().optional(),
  messages: z.array(ConversationMessageSchema),
});
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;

export const OrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const SessionSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string().nullable().optional(),
  }),
  organizations: z.array(OrganizationSchema),
});
export type Session = z.infer<typeof SessionSchema>;

export type StreamEvent =
  | { type: "token"; delta: string }
  | { type: "tool_call"; toolName: string; arguments?: string }
  | { type: "tool_result"; toolName: string; output?: string }
  | { type: "approval_required"; approvals: PendingApproval[]; serializedState: string; conversationId: string }
  | { type: "done"; result: AgentRunOutput }
  | { type: "error"; message: string };

export type StreamHandlers = {
  onToken?: (delta: string) => void;
  onToolCall?: (toolName: string, args?: string) => void;
  onToolResult?: (toolName: string, output?: string) => void;
  onApprovalRequired?: (
    approvals: PendingApproval[],
    serializedState: string,
    conversationId: string,
  ) => void;
  onDone?: (result: AgentRunOutput) => void;
  onError?: (message: string) => void;
};
