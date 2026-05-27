import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MovementInsertedRowSchema,
  flattenInsertedMovement,
  type MovementWithProductRow,
  type WriteError,
} from "./schema.js";
import { getMovementById, isMovementReversed } from "./reads.js";

export type ReverseMovementInput = {
  organizationId: string;
  userId: string;
  movementId: string;
  note: string | null;
};

export type ReverseMovementResult =
  | {
      ok: true;
      reversal: MovementWithProductRow;
      original: MovementWithProductRow;
    }
  | { ok: false; error: WriteError };

function classifyReversalError(message: string, movementId: string): WriteError {
  if (message.includes("reversal_target_missing"))
    return { kind: "reversal_target_missing", movementId };
  if (message.includes("reversal_of_reversal"))
    return { kind: "reversal_of_reversal", movementId };
  if (message.includes("reversal_delta_mismatch"))
    return { kind: "reversal_delta_mismatch", message };
  if (message.includes("negative_stock"))
    return { kind: "negative_stock", message };
  if (message.includes("cross_org"))
    return { kind: "cross_org", message };
  // Postgres unique-violation surfaces as a generic message; match index name.
  if (message.includes("stock_movements_reversal_unique"))
    return { kind: "already_reversed", movementId, reversalId: null };
  return { kind: "unknown", message };
}

export async function reverseMovement(
  supabase: SupabaseClient,
  input: ReverseMovementInput,
): Promise<ReverseMovementResult> {
  const original = await getMovementById(
    supabase,
    input.organizationId,
    input.movementId,
  );
  if (!original) {
    return {
      ok: false,
      error: { kind: "reversal_target_missing", movementId: input.movementId },
    };
  }

  if (original.reason === "reversal") {
    return {
      ok: false,
      error: { kind: "reversal_of_reversal", movementId: input.movementId },
    };
  }

  const prior = await isMovementReversed(
    supabase,
    input.organizationId,
    input.movementId,
  );
  if (prior.reversed) {
    return {
      ok: false,
      error: {
        kind: "already_reversed",
        movementId: input.movementId,
        reversalId: prior.reversalId,
      },
    };
  }

  const insert = await supabase
    .from("stock_movements")
    .insert({
      organization_id: input.organizationId,
      product_id: original.product_id,
      // Trigger will overwrite warehouse_id with the original's; we pass the
      // same value explicitly to satisfy the NOT NULL constraint pre-trigger.
      warehouse_id: original.warehouse_id,
      delta: -original.delta,
      reason: "reversal",
      note: input.note,
      related_movement_id: original.id,
      created_by: input.userId,
    })
    .select(
      "id, organization_id, product_id, warehouse_id, delta, reason, note, related_movement_id, supplier_id, unit_cost_cents, unit_price_cents, total_cost_cents, total_revenue_cents, created_by, created_at, suppliers(name), warehouses(code, name)",
    )
    .single();

  if (insert.error) {
    return {
      ok: false,
      error: classifyReversalError(insert.error.message, input.movementId),
    };
  }

  const parsed = MovementInsertedRowSchema.parse(insert.data);
  const reversal = flattenInsertedMovement(parsed, {
    sku: original.sku,
    name: original.name,
    supplier_name_fallback: original.supplier_name,
    warehouse_code_fallback: original.warehouse_code,
    warehouse_name_fallback: original.warehouse_name,
  });

  return { ok: true, reversal, original };
}
