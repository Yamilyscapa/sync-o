import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const ProductStockRowSchema = z.object({
  sku: z.string(),
  name: z.string(),
  quantity: z.coerce.number(),
});
export type ProductStockRow = z.infer<typeof ProductStockRowSchema>;

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