import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  MovementInsertedRowSchema,
  MovementReasonSchema,
  flattenInsertedMovement,
  type MovementReason,
  type MovementWithProductRow,
  type WriteError,
} from "./schema.js";

const ProductLookupSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  price_cents: z.coerce.number().int().nullable(),
});

const MOVEMENT_INSERT_SELECT =
  "id, organization_id, product_id, warehouse_id, delta, reason, note, related_movement_id, supplier_id, unit_cost_cents, unit_price_cents, total_cost_cents, total_revenue_cents, created_by, created_at, suppliers(name), warehouses(code, name)";

export type RecordMovementInput = {
  organizationId: string;
  userId: string;
  sku: string;
  warehouseId: string;
  delta: number;
  reason: MovementReason;
  note: string | null;
  relatedMovementId: string | null;
  supplierId?: string | null;
  unitCostCents?: number | null;
  unitPriceCents?: number | null;
};

export type RecordMovementResult =
  | { ok: true; row: MovementWithProductRow }
  | { ok: false; error: WriteError };

function classifyPgError(message: string): WriteError {
  if (message.includes("negative_stock"))
    return { kind: "negative_stock", message };
  if (message.includes("cross_org") && message.includes("warehouse"))
    return { kind: "cross_org", message };
  if (message.includes("cross_org"))
    return { kind: "cross_org", message };
  if (message.includes("product_not_found"))
    return { kind: "product_not_found", sku: "" };
  if (message.includes("supplier_not_found"))
    return { kind: "supplier_not_found", supplierId: "" };
  if (message.includes("warehouse_not_found"))
    return { kind: "warehouse_not_found", warehouseId: "" };
  if (message.includes("stock_movements_cost_required"))
    return { kind: "cost_required", sku: "" };
  if (message.includes("stock_movements_price_required"))
    return { kind: "price_required", sku: "" };
  if (message.includes("stock_movements_supplier_reason_scope"))
    return { kind: "supplier_required", sku: "" };
  return { kind: "unknown", message };
}

async function defaultSalePrice(
  supabase: SupabaseClient,
  organizationId: string,
  productId: string,
  fallback: number | null,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("product_last_sale_price")
    .select("unit_price_cents")
    .eq("organization_id", organizationId)
    .eq("product_id", productId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) {
    const parsed = z
      .object({ unit_price_cents: z.coerce.number().int().nullable() })
      .parse(data);
    if (parsed.unit_price_cents != null) return parsed.unit_price_cents;
  }
  return fallback;
}

async function defaultIntakeCost(
  supabase: SupabaseClient,
  productId: string,
  supplierId: string,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("product_suppliers")
    .select("last_unit_cost_cents")
    .eq("product_id", productId)
    .eq("supplier_id", supplierId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const parsed = z
    .object({ last_unit_cost_cents: z.coerce.number().int().nullable() })
    .parse(data);
  return parsed.last_unit_cost_cents;
}

export async function recordMovement(
  supabase: SupabaseClient,
  input: RecordMovementInput,
): Promise<RecordMovementResult> {
  MovementReasonSchema.parse(input.reason);

  const lookup = await supabase
    .from("products")
    .select("id, sku, name, price_cents")
    .eq("organization_id", input.organizationId)
    .eq("sku", input.sku)
    .maybeSingle();

  if (lookup.error) {
    return { ok: false, error: { kind: "unknown", message: lookup.error.message } };
  }
  if (!lookup.data) {
    return { ok: false, error: { kind: "product_not_found", sku: input.sku } };
  }
  const product = ProductLookupSchema.parse(lookup.data);

  let supplierId = input.supplierId ?? null;
  let unitCostCents = input.unitCostCents ?? null;
  let unitPriceCents = input.unitPriceCents ?? null;

  if (input.reason !== "reversal") {
    if (input.reason === "sale") {
      if (unitPriceCents == null) {
        unitPriceCents = await defaultSalePrice(
          supabase,
          input.organizationId,
          product.id,
          product.price_cents,
        );
        if (unitPriceCents == null) {
          return { ok: false, error: { kind: "price_required", sku: input.sku } };
        }
      }
    }

    if (input.reason === "intake" || input.reason === "initial") {
      if (supplierId == null) {
        return { ok: false, error: { kind: "supplier_required", sku: input.sku } };
      }
      if (unitCostCents == null) {
        if (input.reason === "initial") {
          return { ok: false, error: { kind: "cost_required", sku: input.sku } };
        }
        unitCostCents = await defaultIntakeCost(supabase, product.id, supplierId);
        if (unitCostCents == null) {
          return { ok: false, error: { kind: "cost_required", sku: input.sku } };
        }
      }
    }
  }

  const insert = await supabase
    .from("stock_movements")
    .insert({
      organization_id: input.organizationId,
      product_id: product.id,
      warehouse_id: input.warehouseId,
      delta: input.delta,
      reason: input.reason,
      note: input.note,
      related_movement_id: input.relatedMovementId,
      supplier_id: supplierId,
      unit_cost_cents: unitCostCents,
      unit_price_cents: unitPriceCents,
      created_by: input.userId,
    })
    .select(MOVEMENT_INSERT_SELECT)
    .single();

  if (insert.error) {
    const err = classifyPgError(insert.error.message);
    if (err.kind === "product_not_found") err.sku = input.sku;
    if (err.kind === "supplier_not_found") err.supplierId = supplierId ?? "";
    if (err.kind === "warehouse_not_found") err.warehouseId = input.warehouseId;
    if (err.kind === "cost_required" || err.kind === "price_required" || err.kind === "supplier_required") {
      err.sku = input.sku;
    }
    return { ok: false, error: err };
  }

  const parsed = MovementInsertedRowSchema.parse(insert.data);
  const row = flattenInsertedMovement(parsed, product);
  return { ok: true, row };
}

export type TransferStockInput = {
  organizationId: string;
  userId: string;
  sku: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  quantity: number;
  note: string | null;
};

export type TransferStockResult =
  | {
      ok: true;
      out: MovementWithProductRow;
      in: MovementWithProductRow;
    }
  | { ok: false; error: WriteError };

// Atomic two-leg transfer. Posts two reason='transfer' movements in a single
// PostgREST batch — transactional, so the destination credit rolls back if
// the source debit fails (e.g. negative_stock at origin).
export async function transferStock(
  supabase: SupabaseClient,
  input: TransferStockInput,
): Promise<TransferStockResult> {
  if (input.quantity <= 0) {
    return { ok: false, error: { kind: "unknown", message: "quantity must be positive" } };
  }
  if (input.fromWarehouseId === input.toWarehouseId) {
    return { ok: false, error: { kind: "unknown", message: "origen y destino deben ser distintos" } };
  }

  const lookup = await supabase
    .from("products")
    .select("id, sku, name, price_cents")
    .eq("organization_id", input.organizationId)
    .eq("sku", input.sku)
    .maybeSingle();
  if (lookup.error) {
    return { ok: false, error: { kind: "unknown", message: lookup.error.message } };
  }
  if (!lookup.data) {
    return { ok: false, error: { kind: "product_not_found", sku: input.sku } };
  }
  const product = ProductLookupSchema.parse(lookup.data);

  const rows = [
    {
      organization_id: input.organizationId,
      product_id: product.id,
      warehouse_id: input.fromWarehouseId,
      delta: -input.quantity,
      reason: "transfer" as MovementReason,
      note: input.note,
      related_movement_id: null,
      supplier_id: null,
      unit_cost_cents: null,
      unit_price_cents: null,
      created_by: input.userId,
    },
    {
      organization_id: input.organizationId,
      product_id: product.id,
      warehouse_id: input.toWarehouseId,
      delta: input.quantity,
      reason: "transfer" as MovementReason,
      note: input.note,
      related_movement_id: null,
      supplier_id: null,
      unit_cost_cents: null,
      unit_price_cents: null,
      created_by: input.userId,
    },
  ];

  const insert = await supabase
    .from("stock_movements")
    .insert(rows)
    .select(MOVEMENT_INSERT_SELECT);

  if (insert.error) {
    const err = classifyPgError(insert.error.message);
    if (err.kind === "warehouse_not_found") err.warehouseId = input.fromWarehouseId;
    if (err.kind === "product_not_found") err.sku = input.sku;
    return { ok: false, error: err };
  }

  const parsed = z.array(MovementInsertedRowSchema).parse(insert.data ?? []);
  if (parsed.length !== 2) {
    return {
      ok: false,
      error: { kind: "unknown", message: `expected 2 rows, got ${parsed.length}` },
    };
  }
  const out = flattenInsertedMovement(parsed[0]!, product);
  const credit = flattenInsertedMovement(parsed[1]!, product);
  return { ok: true, out, in: credit };
}

export type BulkInitializeStockItem = {
  sku: string;
  quantity: number;
  unitCostCents: number;
  supplierId: string;
  note?: string | null;
};

export type BulkInitializeResult =
  | { ok: true; count: number; rows: MovementWithProductRow[] }
  | { ok: false; error: WriteError };

// Bootstrap initial stock for a warehouse. Inserts N `initial` movements in a
// single PostgREST batch — the trigger fires per row but the request is one
// transaction, so any failure rolls all rows back.
export async function bulkInitializeStock(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string,
  warehouseId: string,
  items: BulkInitializeStockItem[],
): Promise<BulkInitializeResult> {
  if (items.length === 0) {
    return { ok: false, error: { kind: "unknown", message: "empty items list" } };
  }

  const skus = Array.from(new Set(items.map((i) => i.sku)));
  const lookup = await supabase
    .from("products")
    .select("id, sku, name, price_cents")
    .eq("organization_id", organizationId)
    .in("sku", skus);
  if (lookup.error) {
    return { ok: false, error: { kind: "unknown", message: lookup.error.message } };
  }
  const products = z.array(ProductLookupSchema).parse(lookup.data ?? []);
  const productBySku = new Map(products.map((p) => [p.sku, p]));
  for (const item of items) {
    if (!productBySku.has(item.sku)) {
      return { ok: false, error: { kind: "product_not_found", sku: item.sku } };
    }
  }

  const rows = items.map((item) => {
    const product = productBySku.get(item.sku)!;
    return {
      organization_id: organizationId,
      product_id: product.id,
      warehouse_id: warehouseId,
      delta: item.quantity,
      reason: "initial" as MovementReason,
      note: item.note ?? null,
      related_movement_id: null,
      supplier_id: item.supplierId,
      unit_cost_cents: item.unitCostCents,
      unit_price_cents: null,
      created_by: userId,
    };
  });

  const insert = await supabase
    .from("stock_movements")
    .insert(rows)
    .select(MOVEMENT_INSERT_SELECT);

  if (insert.error) {
    const err = classifyPgError(insert.error.message);
    if (err.kind === "warehouse_not_found") err.warehouseId = warehouseId;
    return { ok: false, error: err };
  }

  const parsedRows = z.array(MovementInsertedRowSchema).parse(insert.data ?? []);
  const out = parsedRows.map((r) => {
    const product = products.find((p) => p.id === r.product_id);
    return flattenInsertedMovement(r, {
      sku: product?.sku ?? "",
      name: product?.name ?? "",
    });
  });
  return { ok: true, count: out.length, rows: out };
}
