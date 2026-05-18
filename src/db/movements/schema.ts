import { z } from "zod";

export const MovementReasonSchema = z.enum([
  "intake",
  "sale",
  "adjustment",
  "loss",
  "transfer",
  "reversal",
  "initial",
]);
export type MovementReason = z.infer<typeof MovementReasonSchema>;

export const MovementRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  product_id: z.string(),
  delta: z.coerce.number(),
  reason: MovementReasonSchema,
  note: z.string().nullable(),
  related_movement_id: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
});
export type MovementRow = z.infer<typeof MovementRowSchema>;

export const MovementWithProductRowSchema = MovementRowSchema.extend({
  sku: z.string(),
  name: z.string(),
});
export type MovementWithProductRow = z.infer<typeof MovementWithProductRowSchema>;

export type WriteError =
  | { kind: "product_not_found"; sku: string }
  | { kind: "negative_stock"; message: string }
  | { kind: "cross_org"; message: string }
  | { kind: "unknown"; message: string };
