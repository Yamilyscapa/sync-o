import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  ProductSupplierSchema,
  SupplierPatchSchema,
  SupplierSchema,
  SupplierWriteInputSchema,
  type ProductSupplier,
  type Supplier,
  type SupplierPatch,
  type SupplierWriteError,
  type SupplierWriteInput,
} from "./schema.js";

const SUPPLIER_COLS =
  "id, organization_id, name, legal_name, tax_id, contact_name, contact_email, contact_phone, default_lead_time_days, payment_terms_days, currency, notes, is_active, created_at, updated_at";

const LINK_COLS =
  "product_id, supplier_id, supplier_sku, last_unit_cost_cents, last_purchased_at, lead_time_days, min_order_qty, is_preferred, is_active, notes, created_at, updated_at";

function classifySupplierPgError(message: string): SupplierWriteError {
  if (message.includes("suppliers_org_name_unique"))
    return { kind: "duplicate_name", name: "" };
  if (message.includes("cross_org"))
    return { kind: "cross_org", message };
  if (
    message.includes("violates foreign key constraint") &&
    message.includes("stock_movements")
  )
    return { kind: "supplier_in_use", message };
  if (
    message.includes("violates foreign key constraint") &&
    message.includes("product_suppliers")
  )
    return { kind: "supplier_in_use", message };
  return { kind: "unknown", message };
}

type SupplierResult =
  | { ok: true; row: Supplier }
  | { ok: false; error: SupplierWriteError };

export async function createSupplier(
  supabase: SupabaseClient,
  organizationId: string,
  input: SupplierWriteInput,
): Promise<SupplierResult> {
  const parsed = SupplierWriteInputSchema.parse(input);
  const { data, error } = await supabase
    .from("suppliers")
    .insert({ organization_id: organizationId, ...parsed })
    .select(SUPPLIER_COLS)
    .single();
  if (error) {
    const err = classifySupplierPgError(error.message);
    if (err.kind === "duplicate_name") err.name = parsed.name;
    return { ok: false, error: err };
  }
  return { ok: true, row: SupplierSchema.parse(data) };
}

export async function updateSupplier(
  supabase: SupabaseClient,
  organizationId: string,
  supplierId: string,
  patch: SupplierPatch,
): Promise<SupplierResult> {
  const parsed = SupplierPatchSchema.parse(patch);
  if (Object.keys(parsed).length === 0) {
    return { ok: false, error: { kind: "unknown", message: "empty patch" } };
  }
  const { data, error } = await supabase
    .from("suppliers")
    .update(parsed)
    .eq("organization_id", organizationId)
    .eq("id", supplierId)
    .select(SUPPLIER_COLS)
    .maybeSingle();
  if (error) {
    const err = classifySupplierPgError(error.message);
    if (err.kind === "duplicate_name" && parsed.name) err.name = parsed.name;
    return { ok: false, error: err };
  }
  if (!data) return { ok: false, error: { kind: "not_found", supplierId } };
  return { ok: true, row: SupplierSchema.parse(data) };
}

export async function deactivateSupplier(
  supabase: SupabaseClient,
  organizationId: string,
  supplierId: string,
): Promise<SupplierResult> {
  return updateSupplier(supabase, organizationId, supplierId, { is_active: false });
}

export async function deleteSupplier(
  supabase: SupabaseClient,
  organizationId: string,
  supplierId: string,
): Promise<{ ok: true } | { ok: false; error: SupplierWriteError }> {
  const { error, count } = await supabase
    .from("suppliers")
    .delete({ count: "exact" })
    .eq("organization_id", organizationId)
    .eq("id", supplierId);
  if (error) return { ok: false, error: classifySupplierPgError(error.message) };
  if (count === 0) return { ok: false, error: { kind: "not_found", supplierId } };
  return { ok: true };
}

export type LinkInput = {
  sku: string;
  supplierId: string;
  supplierSku?: string | null;
  leadTimeDays?: number | null;
  minOrderQty?: number | null;
  isPreferred?: boolean;
  notes?: string | null;
};

const ProductIdLookupSchema = z.object({ id: z.string() });

async function resolveProductId(
  supabase: SupabaseClient,
  organizationId: string,
  sku: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("products")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("sku", sku)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return ProductIdLookupSchema.parse(data).id;
}

type LinkResult =
  | { ok: true; row: ProductSupplier }
  | { ok: false; error: SupplierWriteError };

export async function linkProductSupplier(
  supabase: SupabaseClient,
  organizationId: string,
  input: LinkInput,
): Promise<LinkResult> {
  const productId = await resolveProductId(supabase, organizationId, input.sku);
  if (!productId) return { ok: false, error: { kind: "product_not_found", sku: input.sku } };

  if (input.isPreferred) {
    await unsetPreferred(supabase, productId);
  }

  const { data, error } = await supabase
    .from("product_suppliers")
    .insert({
      product_id: productId,
      supplier_id: input.supplierId,
      supplier_sku: input.supplierSku ?? null,
      lead_time_days: input.leadTimeDays ?? null,
      min_order_qty: input.minOrderQty ?? null,
      is_preferred: input.isPreferred ?? false,
      notes: input.notes ?? null,
    })
    .select(LINK_COLS)
    .single();
  if (error) {
    if (error.message.includes("duplicate key") && error.message.includes("product_suppliers_pkey")) {
      return { ok: false, error: { kind: "link_exists", message: error.message } };
    }
    if (error.message.includes("cross_org")) {
      return { ok: false, error: { kind: "cross_org", message: error.message } };
    }
    return { ok: false, error: { kind: "unknown", message: error.message } };
  }
  return { ok: true, row: ProductSupplierSchema.parse(data) };
}

export async function unlinkProductSupplier(
  supabase: SupabaseClient,
  organizationId: string,
  sku: string,
  supplierId: string,
): Promise<{ ok: true } | { ok: false; error: SupplierWriteError }> {
  const productId = await resolveProductId(supabase, organizationId, sku);
  if (!productId) return { ok: false, error: { kind: "product_not_found", sku } };

  const { error, count } = await supabase
    .from("product_suppliers")
    .delete({ count: "exact" })
    .eq("product_id", productId)
    .eq("supplier_id", supplierId);
  if (error) return { ok: false, error: classifySupplierPgError(error.message) };
  if (count === 0) return { ok: false, error: { kind: "not_found", supplierId } };
  return { ok: true };
}

async function unsetPreferred(supabase: SupabaseClient, productId: string): Promise<void> {
  const { error } = await supabase
    .from("product_suppliers")
    .update({ is_preferred: false })
    .eq("product_id", productId)
    .eq("is_preferred", true);
  if (error) throw new Error(error.message);
}

export async function setPreferredSupplier(
  supabase: SupabaseClient,
  organizationId: string,
  sku: string,
  supplierId: string,
): Promise<LinkResult> {
  const productId = await resolveProductId(supabase, organizationId, sku);
  if (!productId) return { ok: false, error: { kind: "product_not_found", sku } };

  // Two-statement: unset any prior preferred for this product, then set new.
  // Partial unique index guards against concurrent writers.
  await unsetPreferred(supabase, productId);

  const { data, error } = await supabase
    .from("product_suppliers")
    .update({ is_preferred: true })
    .eq("product_id", productId)
    .eq("supplier_id", supplierId)
    .select(LINK_COLS)
    .maybeSingle();
  if (error) return { ok: false, error: { kind: "unknown", message: error.message } };
  if (!data) return { ok: false, error: { kind: "not_found", supplierId } };
  return { ok: true, row: ProductSupplierSchema.parse(data) };
}
