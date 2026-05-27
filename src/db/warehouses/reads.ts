import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  WarehouseCandidateSchema,
  WarehouseSchema,
  type Warehouse,
  type WarehouseCandidate,
} from "./schema.js";

const WAREHOUSE_COLS =
  "id, organization_id, name, code, location, is_active, created_at, updated_at";

export async function listWarehouses(
  supabase: SupabaseClient,
  organizationId: string,
  opts: { limit?: number; cursor?: string; activeOnly?: boolean } = {},
): Promise<Warehouse[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  let q = supabase
    .from("warehouses")
    .select(WAREHOUSE_COLS)
    .eq("organization_id", organizationId)
    .order("name", { ascending: true })
    .limit(limit);

  if (opts.activeOnly) q = q.eq("is_active", true);
  if (opts.cursor) q = q.gt("name", opts.cursor);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return z.array(WarehouseSchema).parse(data ?? []);
}

export async function getWarehouseById(
  supabase: SupabaseClient,
  organizationId: string,
  warehouseId: string,
): Promise<Warehouse | null> {
  const { data, error } = await supabase
    .from("warehouses")
    .select(WAREHOUSE_COLS)
    .eq("organization_id", organizationId)
    .eq("id", warehouseId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return WarehouseSchema.parse(data);
}

export async function getWarehouseByCode(
  supabase: SupabaseClient,
  organizationId: string,
  code: string,
): Promise<Warehouse | null> {
  const { data, error } = await supabase
    .from("warehouses")
    .select(WAREHOUSE_COLS)
    .eq("organization_id", organizationId)
    .eq("code", code.toUpperCase())
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return WarehouseSchema.parse(data);
}

export const WarehouseSaturationRowSchema = z.object({
  warehouse_id: z.string(),
  warehouse_code: z.string(),
  warehouse_name: z.string(),
  is_active: z.boolean(),
  sku_count: z.coerce.number().int(),
  total_units: z.coerce.number(),
  estimated_value_cents: z.coerce.number().int(),
});
export type WarehouseSaturationRow = z.infer<typeof WarehouseSaturationRowSchema>;

export async function getWarehouseSaturation(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<WarehouseSaturationRow[]> {
  const { data, error } = await supabase.rpc("warehouse_saturation", {
    p_org: organizationId,
  });
  if (error) throw new Error(error.message);
  return z.array(WarehouseSaturationRowSchema).parse(data ?? []);
}

export const ResolveWarehouseResultSchema = z.object({
  candidates: z.array(WarehouseCandidateSchema),
  ambiguous: z.boolean(),
});
export type ResolveWarehouseResult = z.infer<typeof ResolveWarehouseResultSchema>;

// Resolver order: exact code (uppercase) → exact name ILIKE → fuzzy ILIKE on
// name+code. ambiguous = no single exact hit and 2+ candidates.
export async function resolveWarehouse(
  supabase: SupabaseClient,
  organizationId: string,
  query: string,
  limit = 5,
): Promise<ResolveWarehouseResult> {
  const q = query.trim();
  if (!q) return { candidates: [], ambiguous: false };

  if (/^[A-Z0-9-]{2,16}$/i.test(q)) {
    const codeMatch = await supabase
      .from("warehouses")
      .select("id, name, code, is_active")
      .eq("organization_id", organizationId)
      .eq("code", q.toUpperCase())
      .limit(1);
    if (codeMatch.error) throw new Error(codeMatch.error.message);
    const codeRows = z.array(WarehouseCandidateSchema).parse(codeMatch.data ?? []);
    if (codeRows.length === 1) {
      return { candidates: codeRows, ambiguous: false };
    }
  }

  const exact = await supabase
    .from("warehouses")
    .select("id, name, code, is_active")
    .eq("organization_id", organizationId)
    .ilike("name", q)
    .limit(1);
  if (exact.error) throw new Error(exact.error.message);
  const exactRows = z.array(WarehouseCandidateSchema).parse(exact.data ?? []);
  if (exactRows.length === 1) {
    return { candidates: exactRows, ambiguous: false };
  }

  const fuzzy = await supabase
    .from("warehouses")
    .select("id, name, code, is_active")
    .eq("organization_id", organizationId)
    .or(`name.ilike.%${q}%,code.ilike.%${q}%`)
    .order("name", { ascending: true })
    .limit(limit);
  if (fuzzy.error) throw new Error(fuzzy.error.message);

  const candidates = z.array(WarehouseCandidateSchema).parse(fuzzy.data ?? []);
  return {
    candidates,
    ambiguous: candidates.length > 1,
  };
}
