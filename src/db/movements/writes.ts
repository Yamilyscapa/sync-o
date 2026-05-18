import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  MovementInsertedRowSchema,
  MovementReasonSchema,
  flattenInsertedMovement,
  type MovementReason,
  type MovementWithProductRow,
  type WriteError,
} from "./schema.js";

const ProductLookupSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  price_cents: z.coerce.number().int().nullable(),
});

export type RecordMovementInput = {
  organizationId: string;
  userId: string;
  sku: string;
  delta: number;
  reason: MovementReason;
  note: string | null;
  relatedMovementId: string | null;
  supplierId?: string | null;
  unitCostCents?: number | null;
  unitPriceCents?: number | null;
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
  if (message.includes("supplier_not_found"))
    return { kind: "supplier_not_found", supplierId: "" };
  if (message.includes("stock_movements_cost_required"))
    return { kind: "cost_required", sku: "" };
  if (message.includes("stock_movements_price_required"))
    return { kind: "price_required", sku: "" };
  if (message.includes("stock_movements_supplier_reason_scope"))
    return { kind: "supplier_required", sku: "" };
  return { kind: "unknown", message };
}

// Resolve unit_price_cents default for sales: most-recent sale price from the
// view, then catalog price. Returns null if no default available.
async function defaultSalePrice(
  supabase: SupabaseClient,
  organizationId: string,
  productId: string,
  fallback: number | null,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("product_last_sale_price")
    .select("unit_price_cents")
    .eq("organization_id", organizationId)
    .eq("product_id", productId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) {
    const parsed = z
      .object({ unit_price_cents: z.coerce.number().int().nullable() })
      .parse(data);
    if (parsed.unit_price_cents != null) return parsed.unit_price_cents;
  }
  return fallback;
}

// Resolve unit_cost_cents default for intakes: last_unit_cost_cents from
// product_suppliers snapshot for this (product, supplier). Null if absent.
async function defaultIntakeCost(
  supabase: SupabaseClient,
  productId: string,
  supplierId: string,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("product_suppliers")
    .select("last_unit_cost_cents")
    .eq("product_id", productId)
    .eq("supplier_id", supplierId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const parsed = z
    .object({ last_unit_cost_cents: z.coerce.number().int().nullable() })
    .parse(data);
  return parsed.last_unit_cost_cents;
}

export async function recordMovement(
  supabase: SupabaseClient,
  input: RecordMovementInput,
): Promise<RecordMovementResult> {
  MovementReasonSchema.parse(input.reason);

  const lookup = await supabase
    .from("products")
    .select("id, sku, name, price_cents")
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

  let supplierId = input.supplierId ?? null;
  let unitCostCents = input.unitCostCents ?? null;
  let unitPriceCents = input.unitPriceCents ?? null;

  // Default resolution. Reversal skips: trigger inherits from original.
  if (input.reason !== "reversal") {
    if (input.reason === "sale") {
      if (unitPriceCents == null) {
        unitPriceCents = await defaultSalePrice(
          supabase,
          input.organizationId,
          product.id,
          product.price_cents,
        );
        if (unitPriceCents == null) {
          return { ok: false, error: { kind: "price_required", sku: input.sku } };
        }
      }
    }

    if (input.reason === "intake" || input.reason === "initial") {
      if (supplierId == null) {
        return { ok: false, error: { kind: "supplier_required", sku: input.sku } };
      }
      if (unitCostCents == null) {
        // 'initial' bootstraps; no snapshot lookup, must be supplied.
        if (input.reason === "initial") {
          return { ok: false, error: { kind: "cost_required", sku: input.sku } };
        }
        unitCostCents = await defaultIntakeCost(supabase, product.id, supplierId);
        if (unitCostCents == null) {
          return { ok: false, error: { kind: "cost_required", sku: input.sku } };
        }
      }
    }
  }

  const insert = await supabase
    .from("stock_movements")
    .insert({
      organization_id: input.organizationId,
      product_id: product.id,
      delta: input.delta,
      reason: input.reason,
      note: input.note,
      related_movement_id: input.relatedMovementId,
      supplier_id: supplierId,
      unit_cost_cents: unitCostCents,
      unit_price_cents: unitPriceCents,
      created_by: input.userId,
    })
    .select(
      "id, organization_id, product_id, delta, reason, note, related_movement_id, supplier_id, unit_cost_cents, unit_price_cents, total_cost_cents, total_revenue_cents, created_by, created_at, suppliers(name)",
    )
    .single();

  if (insert.error) {
    const err = classifyPgError(insert.error.message);
    if (err.kind === "product_not_found") err.sku = input.sku;
    if (err.kind === "supplier_not_found") err.supplierId = supplierId ?? "";
    if (err.kind === "cost_required" || err.kind === "price_required" || err.kind === "supplier_required") {
      err.sku = input.sku;
    }
    return { ok: false, error: err };
  }

  const parsed = MovementInsertedRowSchema.parse(insert.data);
  const row = flattenInsertedMovement(parsed, product);
  return { ok: true, row };
}
