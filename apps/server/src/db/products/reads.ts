import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const ProductStockRowSchema = z.object({
  sku: z.string(),
  name: z.string(),
  quantity: z.coerce.number(),
  warehouse_id: z.string().optional(),
  warehouse_code: z.string().optional(),
  warehouse_name: z.string().optional(),
  min_stock: z.coerce.number().optional(),
});
export type ProductStockRow = z.infer<typeof ProductStockRowSchema>;

export const ProductListRowSchema = z.object({
  sku: z.string(),
  name: z.string(),
  quantity: z.coerce.number(),
  price_cents: z.coerce.number().nullable(),
  currency: z.string(),
  is_active: z.boolean(),
});
export type ProductListRow = z.infer<typeof ProductListRowSchema>;

// Aggregated stock total across all warehouses.
export async function getStockBySku(
  supabase: SupabaseClient,
  organizationId: string,
  sku: string,
): Promise<ProductStockRow | null> {
  const { data, error } = await supabase
    .from("products_searchable")
    .select("sku, name, quantity")
    .eq("organization_id", organizationId)
    .eq("sku", sku)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  return ProductStockRowSchema.parse(data);
}

// Per-warehouse stock breakdown for one product (only warehouses with rows).
export async function getStockBreakdownBySku(
  supabase: SupabaseClient,
  organizationId: string,
  sku: string,
): Promise<ProductStockRow[]> {
  const { data, error } = await supabase
    .from("products_warehouse_stock")
    .select("sku, name, quantity, warehouse_id, warehouse_code, warehouse_name, min_stock")
    .eq("organization_id", organizationId)
    .eq("sku", sku)
    .gt("quantity", 0)
    .order("warehouse_code", { ascending: true });
  if (error) throw new Error(error.message);
  return z.array(ProductStockRowSchema).parse(data ?? []);
}

export async function getStockBySkuAndWarehouse(
  supabase: SupabaseClient,
  organizationId: string,
  sku: string,
  warehouseId: string,
): Promise<ProductStockRow | null> {
  const { data, error } = await supabase
    .from("products_warehouse_stock")
    .select("sku, name, quantity, warehouse_id, warehouse_code, warehouse_name, min_stock")
    .eq("organization_id", organizationId)
    .eq("sku", sku)
    .eq("warehouse_id", warehouseId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return ProductStockRowSchema.parse(data);
}

export async function listProducts(
  supabase: SupabaseClient,
  organizationId: string,
  opts: { limit?: number; cursor?: string; activeOnly?: boolean } = {},
): Promise<ProductListRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  let q = supabase
    .from("products_searchable")
    .select("sku, name, quantity, price_cents, currency, is_active")
    .eq("organization_id", organizationId)
    .order("sku", { ascending: true })
    .limit(limit);

  if (opts.activeOnly) q = q.eq("is_active", true);
  if (opts.cursor) q = q.gt("sku", opts.cursor);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return z.array(ProductListRowSchema).parse(data ?? []);
}

export async function listStock(
  supabase: SupabaseClient,
  organizationId: string,
  opts: {
    limit?: number;
    cursor?: string;
    order?: "asc" | "desc";
    warehouseId?: string;
  } = {},
): Promise<ProductStockRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const ascending = (opts.order ?? "desc") === "asc";

  if (opts.warehouseId) {
    let q = supabase
      .from("products_warehouse_stock")
      .select("sku, name, quantity, warehouse_id, warehouse_code, warehouse_name, min_stock")
      .eq("organization_id", organizationId)
      .eq("warehouse_id", opts.warehouseId)
      .order("quantity", { ascending })
      .order("sku", { ascending: true })
      .limit(limit);
    if (opts.cursor) q = q.gt("sku", opts.cursor);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return z.array(ProductStockRowSchema).parse(data ?? []);
  }

  let q = supabase
    .from("products_searchable")
    .select("sku, name, quantity")
    .eq("organization_id", organizationId)
    .order("quantity", { ascending })
    .order("sku", { ascending: true })
    .limit(limit);

  if (opts.cursor) q = q.gt("sku", opts.cursor);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return z.array(ProductStockRowSchema).parse(data ?? []);
}

export async function listLowStock(
  supabase: SupabaseClient,
  organizationId: string,
  threshold: number,
  opts: { limit?: number; warehouseId?: string } = {},
): Promise<ProductStockRow[]> {
  const cappedLimit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  if (opts.warehouseId) {
    const { data, error } = await supabase
      .from("products_warehouse_stock")
      .select("sku, name, quantity, warehouse_id, warehouse_code, warehouse_name, min_stock")
      .eq("organization_id", organizationId)
      .eq("warehouse_id", opts.warehouseId)
      .lte("quantity", threshold)
      .order("quantity", { ascending: true })
      .order("sku", { ascending: true })
      .limit(cappedLimit);
    if (error) throw new Error(error.message);
    return z.array(ProductStockRowSchema).parse(data ?? []);
  }

  const { data, error } = await supabase
    .from("products_searchable")
    .select("sku, name, quantity")
    .eq("organization_id", organizationId)
    .lte("quantity", threshold)
    .order("quantity", { ascending: true })
    .order("sku", { ascending: true })
    .limit(cappedLimit);

  if (error) throw new Error(error.message);
  return z.array(ProductStockRowSchema).parse(data ?? []);
}

// Per-pair reorder mode: returns rows where quantity <= min_stock and
// min_stock > 0 (skip pairs with no threshold set). Warehouse-scoped.
export async function listBelowReorder(
  supabase: SupabaseClient,
  organizationId: string,
  opts: { limit?: number; warehouseId?: string } = {},
): Promise<ProductStockRow[]> {
  const cappedLimit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  let q = supabase
    .from("products_warehouse_stock")
    .select("sku, name, quantity, warehouse_id, warehouse_code, warehouse_name, min_stock")
    .eq("organization_id", organizationId)
    .gt("min_stock", 0)
    // PostgREST cannot compare two columns directly; rely on client filter
    // after fetch when warehouseId is unset. For warehouseId-scoped reads
    // PostgREST also can't, so we filter client-side either way.
    .order("quantity", { ascending: true })
    .order("sku", { ascending: true })
    .limit(cappedLimit * 4);
  if (opts.warehouseId) q = q.eq("warehouse_id", opts.warehouseId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = z.array(ProductStockRowSchema).parse(data ?? []);
  return rows
    .filter((r) => r.min_stock != null && r.quantity <= r.min_stock)
    .slice(0, cappedLimit);
}

export type SetReorderPointResult =
  | { ok: true; row: ProductStockRow }
  | {
      ok: false;
      error:
        | { kind: "product_not_found"; sku: string }
        | { kind: "warehouse_not_found"; warehouseId: string }
        | { kind: "cross_org"; message: string }
        | { kind: "unknown"; message: string };
    };

// Upsert (product_id, warehouse_id) row with min_stock. Creates a zero-qty
// stock row if none exists yet — required because product_stock rows are
// lazily created on first movement.
export async function setReorderPoint(
  supabase: SupabaseClient,
  organizationId: string,
  sku: string,
  warehouseId: string,
  minStock: number,
): Promise<SetReorderPointResult> {
  const product = await supabase
    .from("products")
    .select("id, organization_id")
    .eq("organization_id", organizationId)
    .eq("sku", sku)
    .maybeSingle();
  if (product.error) return { ok: false, error: { kind: "unknown", message: product.error.message } };
  if (!product.data) return { ok: false, error: { kind: "product_not_found", sku } };
  const productRow = z
    .object({ id: z.string(), organization_id: z.string() })
    .parse(product.data);

  const wh = await supabase
    .from("warehouses")
    .select("id, organization_id")
    .eq("organization_id", organizationId)
    .eq("id", warehouseId)
    .maybeSingle();
  if (wh.error) return { ok: false, error: { kind: "unknown", message: wh.error.message } };
  if (!wh.data) return { ok: false, error: { kind: "warehouse_not_found", warehouseId } };

  const { error } = await supabase
    .from("product_stock")
    .upsert(
      { product_id: productRow.id, warehouse_id: warehouseId, min_stock: minStock },
      { onConflict: "product_id,warehouse_id" },
    );
  if (error) {
    if (error.message.includes("cross_org"))
      return { ok: false, error: { kind: "cross_org", message: error.message } };
    return { ok: false, error: { kind: "unknown", message: error.message } };
  }

  const refreshed = await supabase
    .from("products_warehouse_stock")
    .select("sku, name, quantity, warehouse_id, warehouse_code, warehouse_name, min_stock")
    .eq("organization_id", organizationId)
    .eq("sku", sku)
    .eq("warehouse_id", warehouseId)
    .maybeSingle();
  if (refreshed.error) return { ok: false, error: { kind: "unknown", message: refreshed.error.message } };
  if (!refreshed.data) return { ok: false, error: { kind: "unknown", message: "post-upsert read returned null" } };
  return { ok: true, row: ProductStockRowSchema.parse(refreshed.data) };
}
