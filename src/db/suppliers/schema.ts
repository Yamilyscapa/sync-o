import { z } from "zod";

export const SupplierSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  name: z.string(),
  legal_name: z.string().nullable(),
  tax_id: z.string().nullable(),
  contact_name: z.string().nullable(),
  contact_email: z.string().nullable(),
  contact_phone: z.string().nullable(),
  default_lead_time_days: z.coerce.number().int().nullable(),
  payment_terms_days: z.coerce.number().int().nullable(),
  currency: z.string(),
  notes: z.string().nullable(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Supplier = z.infer<typeof SupplierSchema>;

export const SupplierWriteInputSchema = z.object({
  name: z.string().min(1),
  legal_name: z.string().nullable().optional(),
  tax_id: z.string().nullable().optional(),
  contact_name: z.string().nullable().optional(),
  contact_email: z.string().email().nullable().optional(),
  contact_phone: z.string().nullable().optional(),
  default_lead_time_days: z.number().int().min(0).nullable().optional(),
  payment_terms_days: z.number().int().min(0).nullable().optional(),
  currency: z.string().optional(),
  notes: z.string().nullable().optional(),
});
export type SupplierWriteInput = z.infer<typeof SupplierWriteInputSchema>;

export const SupplierPatchSchema = SupplierWriteInputSchema.partial().extend({
  is_active: z.boolean().optional(),
});
export type SupplierPatch = z.infer<typeof SupplierPatchSchema>;

export const ProductSupplierSchema = z.object({
  product_id: z.string(),
  supplier_id: z.string(),
  supplier_sku: z.string().nullable(),
  last_unit_cost_cents: z.coerce.number().int().nullable(),
  last_purchased_at: z.string().nullable(),
  lead_time_days: z.coerce.number().int().nullable(),
  min_order_qty: z.coerce.number().nullable(),
  is_preferred: z.boolean(),
  is_active: z.boolean(),
  notes: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ProductSupplier = z.infer<typeof ProductSupplierSchema>;

export const ProductSupplierWithNamesSchema = ProductSupplierSchema.extend({
  product_sku: z.string(),
  product_name: z.string(),
  supplier_name: z.string(),
});
export type ProductSupplierWithNames = z.infer<typeof ProductSupplierWithNamesSchema>;

export type SupplierWriteError =
  | { kind: "duplicate_name"; name: string }
  | { kind: "cross_org"; message: string }
  | { kind: "supplier_in_use"; message: string }
  | { kind: "not_found"; supplierId: string }
  | { kind: "product_not_found"; sku: string }
  | { kind: "link_exists"; message: string }
  | { kind: "unknown"; message: string };
