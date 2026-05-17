import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const ProductStockRowSchema = z.object({
  sku: z.string(),
  name: z.string(),
  quantity: z.coerce.number(),
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
  opts: { limit?: number; cursor?: string; order?: "asc" | "desc" } = {},
): Promise<ProductStockRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const ascending = (opts.order ?? "desc") === "asc";
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
  limit = 20,
): Promise<ProductStockRow[]> {
  const cappedLimit = Math.min(Math.max(limit, 1), 100);
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