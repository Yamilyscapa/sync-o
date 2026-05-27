import type { SupabaseClient } from "@supabase/supabase-js";
import {
  WarehousePatchSchema,
  WarehouseSchema,
  WarehouseWriteInputSchema,
  type Warehouse,
  type WarehousePatch,
  type WarehouseWriteError,
  type WarehouseWriteInput,
} from "./schema.js";

const WAREHOUSE_COLS =
  "id, organization_id, name, code, location, is_active, created_at, updated_at";

function classifyWarehousePgError(message: string): WarehouseWriteError {
  if (message.includes("warehouses_org_name_unique"))
    return { kind: "duplicate_name", name: "" };
  if (message.includes("warehouses_org_code_unique"))
    return { kind: "duplicate_code", code: "" };
  if (message.includes("warehouses_code_format"))
    return { kind: "invalid_code", code: "" };
  if (message.includes("cross_org"))
    return { kind: "cross_org", message };
  if (
    message.includes("violates foreign key constraint") &&
    (message.includes("stock_movements") || message.includes("product_stock"))
  )
    return { kind: "warehouse_in_use", message };
  return { kind: "unknown", message };
}

type WarehouseResult =
  | { ok: true; row: Warehouse }
  | { ok: false; error: WarehouseWriteError };

export async function createWarehouse(
  supabase: SupabaseClient,
  organizationId: string,
  input: WarehouseWriteInput,
): Promise<WarehouseResult> {
  const parsed = WarehouseWriteInputSchema.parse({
    ...input,
    code: input.code.toUpperCase(),
  });
  const { data, error } = await supabase
    .from("warehouses")
    .insert({ organization_id: organizationId, ...parsed })
    .select(WAREHOUSE_COLS)
    .single();
  if (error) {
    const err = classifyWarehousePgError(error.message);
    if (err.kind === "duplicate_name") err.name = parsed.name;
    if (err.kind === "duplicate_code") err.code = parsed.code;
    if (err.kind === "invalid_code") err.code = parsed.code;
    return { ok: false, error: err };
  }
  return { ok: true, row: WarehouseSchema.parse(data) };
}

export async function updateWarehouse(
  supabase: SupabaseClient,
  organizationId: string,
  warehouseId: string,
  patch: WarehousePatch,
): Promise<WarehouseResult> {
  const normalized = patch.code ? { ...patch, code: patch.code.toUpperCase() } : patch;
  const parsed = WarehousePatchSchema.parse(normalized);
  if (Object.keys(parsed).length === 0) {
    return { ok: false, error: { kind: "unknown", message: "empty patch" } };
  }
  const { data, error } = await supabase
    .from("warehouses")
    .update(parsed)
    .eq("organization_id", organizationId)
    .eq("id", warehouseId)
    .select(WAREHOUSE_COLS)
    .maybeSingle();
  if (error) {
    const err = classifyWarehousePgError(error.message);
    if (err.kind === "duplicate_name" && parsed.name) err.name = parsed.name;
    if (err.kind === "duplicate_code" && parsed.code) err.code = parsed.code;
    if (err.kind === "invalid_code" && parsed.code) err.code = parsed.code;
    return { ok: false, error: err };
  }
  if (!data) return { ok: false, error: { kind: "not_found", warehouseId } };
  return { ok: true, row: WarehouseSchema.parse(data) };
}

export async function deactivateWarehouse(
  supabase: SupabaseClient,
  organizationId: string,
  warehouseId: string,
): Promise<WarehouseResult> {
  return updateWarehouse(supabase, organizationId, warehouseId, { is_active: false });
}
