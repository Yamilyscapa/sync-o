import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  MovementReasonSchema,
  MovementWithProductRowSchema,
  type MovementReason,
  type MovementWithProductRow,
} from "./schema.js";

// Supabase returns the joined products as a nested object (or array). Normalize.
const RawJoinedRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  product_id: z.string(),
  delta: z.coerce.number(),
  reason: MovementReasonSchema,
  note: z.string().nullable(),
  related_movement_id: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
  products: z
    .union([
      z.object({ sku: z.string(), name: z.string() }),
      z.array(z.object({ sku: z.string(), name: z.string() })),
    ])
    .nullable(),
});

function flatten(row: z.infer<typeof RawJoinedRowSchema>): MovementWithProductRow {
  const prod = Array.isArray(row.products) ? row.products[0] : row.products;
  return MovementWithProductRowSchema.parse({
    id: row.id,
    organization_id: row.organization_id,
    product_id: row.product_id,
    delta: row.delta,
    reason: row.reason,
    note: row.note,
    related_movement_id: row.related_movement_id,
    created_by: row.created_by,
    created_at: row.created_at,
    sku: prod?.sku ?? "",
    name: prod?.name ?? "",
  });
}

export async function listMovements(
  supabase: SupabaseClient,
  organizationId: string,
  opts: {
    limit?: number;
    reason?: MovementReason;
    sinceIso?: string;
  } = {},
): Promise<MovementWithProductRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  let q = supabase
    .from("stock_movements")
    .select(
      "id, organization_id, product_id, delta, reason, note, related_movement_id, created_by, created_at, products(sku, name)",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (opts.reason) q = q.eq("reason", opts.reason);
  if (opts.sinceIso) q = q.gte("created_at", opts.sinceIso);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return z.array(RawJoinedRowSchema).parse(data ?? []).map(flatten);
}

export async function getMovementById(
  supabase: SupabaseClient,
  organizationId: string,
  movementId: string,
): Promise<MovementWithProductRow | null> {
  const { data, error } = await supabase
    .from("stock_movements")
    .select(
      "id, organization_id, product_id, delta, reason, note, related_movement_id, created_by, created_at, products(sku, name)",
    )
    .eq("organization_id", organizationId)
    .eq("id", movementId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  return flatten(RawJoinedRowSchema.parse(data));
}

export async function isMovementReversed(
  supabase: SupabaseClient,
  organizationId: string,
  movementId: string,
): Promise<{ reversed: boolean; reversalId: string | null }> {
  const { data, error } = await supabase
    .from("stock_movements")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("related_movement_id", movementId)
    .eq("reason", "reversal")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return { reversed: false, reversalId: null };
  const parsed = z.object({ id: z.string() }).parse(data);
  return { reversed: true, reversalId: parsed.id };
}

export async function getMovementsBySku(
  supabase: SupabaseClient,
  organizationId: string,
  sku: string,
  limit = 20,
): Promise<MovementWithProductRow[]> {
  const cappedLimit = Math.min(Math.max(limit, 1), 100);

  const productLookup = await supabase
    .from("products")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("sku", sku)
    .maybeSingle();
  if (productLookup.error) throw new Error(productLookup.error.message);
  if (!productLookup.data) return [];
  const productId = z.object({ id: z.string() }).parse(productLookup.data).id;

  const { data, error } = await supabase
    .from("stock_movements")
    .select(
      "id, organization_id, product_id, delta, reason, note, related_movement_id, created_by, created_at, products(sku, name)",
    )
    .eq("organization_id", organizationId)
    .eq("product_id", productId)
    .order("created_at", { ascending: false })
    .limit(cappedLimit);

  if (error) throw new Error(error.message);
  return z.array(RawJoinedRowSchema).parse(data ?? []).map(flatten);
}
