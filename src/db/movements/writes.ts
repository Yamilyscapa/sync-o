import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  MovementReasonSchema,
  MovementWithProductRowSchema,
  type MovementReason,
  type MovementWithProductRow,
  type WriteError,
} from "./schema.js";

const ProductLookupSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
});

export type RecordMovementInput = {
  organizationId: string;
  userId: string;
  sku: string;
  delta: number;
  reason: MovementReason;
  note: string | null;
  relatedMovementId: string | null;
};

export type RecordMovementResult =
  | { ok: true; row: MovementWithProductRow }
  | { ok: false; error: WriteError };

function classifyPgError(message: string): WriteError {
  if (message.includes("negative_stock"))
    return { kind: "negative_stock", message };
  if (message.includes("cross_org"))
    return { kind: "cross_org", message };
  if (message.includes("product_not_found"))
    return { kind: "product_not_found", sku: "" };
  return { kind: "unknown", message };
}

export async function recordMovement(
  supabase: SupabaseClient,
  input: RecordMovementInput,
): Promise<RecordMovementResult> {
  // Validate reason at boundary (defensive — also Zod-validated in tool).
  MovementReasonSchema.parse(input.reason);

  // Resolve sku -> product within org. Use products table (not view) for id.
  const lookup = await supabase
    .from("products")
    .select("id, sku, name")
    .eq("organization_id", input.organizationId)
    .eq("sku", input.sku)
    .maybeSingle();

  if (lookup.error) {
    return { ok: false, error: { kind: "unknown", message: lookup.error.message } };
  }
  if (!lookup.data) {
    return { ok: false, error: { kind: "product_not_found", sku: input.sku } };
  }
  const product = ProductLookupSchema.parse(lookup.data);

  const insert = await supabase
    .from("stock_movements")
    .insert({
      organization_id: input.organizationId,
      product_id: product.id,
      delta: input.delta,
      reason: input.reason,
      note: input.note,
      related_movement_id: input.relatedMovementId,
      created_by: input.userId,
    })
    .select(
      "id, organization_id, product_id, delta, reason, note, related_movement_id, created_by, created_at",
    )
    .single();

  if (insert.error) {
    const err = classifyPgError(insert.error.message);
    if (err.kind === "product_not_found") err.sku = input.sku;
    return { ok: false, error: err };
  }

  const merged = {
    ...insert.data,
    sku: product.sku,
    name: product.name,
  };
  return { ok: true, row: MovementWithProductRowSchema.parse(merged) };
}
