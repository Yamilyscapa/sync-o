import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  ProductSupplierSchema,
  ProductSupplierWithNamesSchema,
  SupplierSchema,
  type ProductSupplier,
  type ProductSupplierWithNames,
  type Supplier,
} from "./schema.js";

export async function listSuppliers(
  supabase: SupabaseClient,
  organizationId: string,
  opts: { limit?: number; cursor?: string; activeOnly?: boolean } = {},
): Promise<Supplier[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  let q = supabase
    .from("suppliers")
    .select(
      "id, organization_id, name, legal_name, tax_id, contact_name, contact_email, contact_phone, default_lead_time_days, payment_terms_days, currency, notes, is_active, created_at, updated_at",
    )
    .eq("organization_id", organizationId)
    .order("name", { ascending: true })
    .limit(limit);

  if (opts.activeOnly) q = q.eq("is_active", true);
  if (opts.cursor) q = q.gt("name", opts.cursor);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return z.array(SupplierSchema).parse(data ?? []);
}

export async function getSupplierById(
  supabase: SupabaseClient,
  organizationId: string,
  supplierId: string,
): Promise<Supplier | null> {
  const { data, error } = await supabase
    .from("suppliers")
    .select(
      "id, organization_id, name, legal_name, tax_id, contact_name, contact_email, contact_phone, default_lead_time_days, payment_terms_days, currency, notes, is_active, created_at, updated_at",
    )
    .eq("organization_id", organizationId)
    .eq("id", supplierId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return SupplierSchema.parse(data);
}

export const SupplierCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  is_active: z.boolean(),
});
export type SupplierCandidate = z.infer<typeof SupplierCandidateSchema>;

export const ResolveSupplierResultSchema = z.object({
  candidates: z.array(SupplierCandidateSchema),
  ambiguous: z.boolean(),
});
export type ResolveSupplierResult = z.infer<typeof ResolveSupplierResultSchema>;

// Simple resolver: exact name match (case-insensitive) wins; otherwise return
// all ILIKE matches as candidates. Supplier counts are small per org so no
// trigram RPC needed yet. Ambiguous = no exact match and 2+ ILIKE hits.
export async function resolveSupplier(
  supabase: SupabaseClient,
  organizationId: string,
  query: string,
  limit = 5,
): Promise<ResolveSupplierResult> {
  const q = query.trim();
  if (!q) return { candidates: [], ambiguous: false };

  const exact = await supabase
    .from("suppliers")
    .select("id, name, is_active")
    .eq("organization_id", organizationId)
    .ilike("name", q)
    .limit(1);
  if (exact.error) throw new Error(exact.error.message);
  const exactRows = z.array(SupplierCandidateSchema).parse(exact.data ?? []);
  if (exactRows.length === 1) {
    return { candidates: exactRows, ambiguous: false };
  }

  const fuzzy = await supabase
    .from("suppliers")
    .select("id, name, is_active")
    .eq("organization_id", organizationId)
    .ilike("name", `%${q}%`)
    .order("name", { ascending: true })
    .limit(limit);
  if (fuzzy.error) throw new Error(fuzzy.error.message);

  const candidates = z.array(SupplierCandidateSchema).parse(fuzzy.data ?? []);
  return {
    candidates,
    ambiguous: candidates.length > 1,
  };
}

export async function listProductSuppliers(
  supabase: SupabaseClient,
  organizationId: string,
  sku: string,
): Promise<ProductSupplierWithNames[]> {
  const lookup = await supabase
    .from("products")
    .select("id, sku, name")
    .eq("organization_id", organizationId)
    .eq("sku", sku)
    .maybeSingle();
  if (lookup.error) throw new Error(lookup.error.message);
  if (!lookup.data) return [];
  const product = z
    .object({ id: z.string(), sku: z.string(), name: z.string() })
    .parse(lookup.data);

  const { data, error } = await supabase
    .from("product_suppliers")
    .select(
      "product_id, supplier_id, supplier_sku, last_unit_cost_cents, last_purchased_at, lead_time_days, min_order_qty, is_preferred, is_active, notes, created_at, updated_at, suppliers(name)",
    )
    .eq("product_id", product.id);
  if (error) throw new Error(error.message);

  const RawSchema = ProductSupplierSchema.extend({
    suppliers: z
      .union([z.object({ name: z.string() }), z.array(z.object({ name: z.string() }))])
      .nullable(),
  });
  const rows = z.array(RawSchema).parse(data ?? []);
  return rows.map((r) => {
    const s = Array.isArray(r.suppliers) ? r.suppliers[0] : r.suppliers;
    return ProductSupplierWithNamesSchema.parse({
      ...r,
      product_sku: product.sku,
      product_name: product.name,
      supplier_name: s?.name ?? "",
    });
  });
}

export async function listSupplierProducts(
  supabase: SupabaseClient,
  organizationId: string,
  supplierId: string,
): Promise<ProductSupplierWithNames[]> {
  const supplier = await getSupplierById(supabase, organizationId, supplierId);
  if (!supplier) return [];

  const { data, error } = await supabase
    .from("product_suppliers")
    .select(
      "product_id, supplier_id, supplier_sku, last_unit_cost_cents, last_purchased_at, lead_time_days, min_order_qty, is_preferred, is_active, notes, created_at, updated_at, products(sku, name)",
    )
    .eq("supplier_id", supplierId);
  if (error) throw new Error(error.message);

  const RawSchema = ProductSupplierSchema.extend({
    products: z
      .union([
        z.object({ sku: z.string(), name: z.string() }),
        z.array(z.object({ sku: z.string(), name: z.string() })),
      ])
      .nullable(),
  });
  const rows = z.array(RawSchema).parse(data ?? []);
  return rows.map((r) => {
    const p = Array.isArray(r.products) ? r.products[0] : r.products;
    return ProductSupplierWithNamesSchema.parse({
      ...r,
      product_sku: p?.sku ?? "",
      product_name: p?.name ?? "",
      supplier_name: supplier.name,
    });
  });
}

export async function getProductSupplierLink(
  supabase: SupabaseClient,
  productId: string,
  supplierId: string,
): Promise<ProductSupplier | null> {
  const { data, error } = await supabase
    .from("product_suppliers")
    .select(
      "product_id, supplier_id, supplier_sku, last_unit_cost_cents, last_purchased_at, lead_time_days, min_order_qty, is_preferred, is_active, notes, created_at, updated_at",
    )
    .eq("product_id", productId)
    .eq("supplier_id", supplierId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return ProductSupplierSchema.parse(data);
}
