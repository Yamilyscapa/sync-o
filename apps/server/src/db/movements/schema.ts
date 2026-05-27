import { z } from "zod";

export const MovementReasonSchema = z.enum([
  "intake",
  "sale",
  "adjustment",
  "loss",
  "transfer",
  "reversal",
  "initial",
]);
export type MovementReason = z.infer<typeof MovementReasonSchema>;

export const MovementRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  product_id: z.string(),
  warehouse_id: z.string(),
  delta: z.coerce.number(),
  reason: MovementReasonSchema,
  note: z.string().nullable(),
  related_movement_id: z.string().nullable(),
  supplier_id: z.string().nullable(),
  unit_cost_cents: z.coerce.number().int().nullable(),
  unit_price_cents: z.coerce.number().int().nullable(),
  total_cost_cents: z.coerce.number().int().nullable(),
  total_revenue_cents: z.coerce.number().int().nullable(),
  created_by: z.string(),
  created_at: z.string(),
});
export type MovementRow = z.infer<typeof MovementRowSchema>;

export const MovementWithProductRowSchema = MovementRowSchema.extend({
  sku: z.string(),
  name: z.string(),
  supplier_name: z.string().nullable(),
  warehouse_code: z.string().nullable(),
  warehouse_name: z.string().nullable(),
});
export type MovementWithProductRow = z.infer<typeof MovementWithProductRowSchema>;

// PostgREST returns a `belongs-to` join as either an object or a single-element
// array depending on the row's FK cardinality; both forms are valid.
const SupplierJoinSchema = z
  .union([z.object({ name: z.string() }), z.array(z.object({ name: z.string() }))])
  .nullable();

const WarehouseJoinSchema = z
  .union([
    z.object({ code: z.string(), name: z.string() }),
    z.array(z.object({ code: z.string(), name: z.string() })),
  ])
  .nullable();

// Shape returned by `insert(...).select("<cols>, suppliers(name), warehouses(code,name)").single()`
// — movement row + join slots, no product join. Parse insert.data through this
// to avoid casting the PostgREST response.
export const MovementInsertedRowSchema = MovementRowSchema.extend({
  suppliers: SupplierJoinSchema,
  warehouses: WarehouseJoinSchema,
});

export function flattenInsertedMovement(
  row: z.infer<typeof MovementInsertedRowSchema>,
  product: {
    sku: string;
    name: string;
    supplier_name_fallback?: string | null;
    warehouse_code_fallback?: string | null;
    warehouse_name_fallback?: string | null;
  },
): MovementWithProductRow {
  const sup = Array.isArray(row.suppliers) ? row.suppliers[0] : row.suppliers;
  const wh = Array.isArray(row.warehouses) ? row.warehouses[0] : row.warehouses;
  const { suppliers: _s, warehouses: _w, ...rest } = row;
  return MovementWithProductRowSchema.parse({
    ...rest,
    sku: product.sku,
    name: product.name,
    supplier_name: sup?.name ?? product.supplier_name_fallback ?? null,
    warehouse_code: wh?.code ?? product.warehouse_code_fallback ?? null,
    warehouse_name: wh?.name ?? product.warehouse_name_fallback ?? null,
  });
}

export type WriteError =
  | { kind: "product_not_found"; sku: string }
  | { kind: "negative_stock"; message: string }
  | { kind: "cross_org"; message: string }
  | { kind: "reversal_target_missing"; movementId: string }
  | { kind: "already_reversed"; movementId: string; reversalId: string | null }
  | { kind: "reversal_of_reversal"; movementId: string }
  | { kind: "reversal_delta_mismatch"; message: string }
  | { kind: "price_required"; sku: string }
  | { kind: "cost_required"; sku: string }
  | { kind: "supplier_required"; sku: string }
  | { kind: "supplier_not_found"; supplierId: string }
  | { kind: "warehouse_required"; sku: string }
  | { kind: "warehouse_not_found"; warehouseId: string }
  | { kind: "unknown"; message: string };
