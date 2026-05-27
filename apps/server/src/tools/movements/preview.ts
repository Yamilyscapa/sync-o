import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import { getMovementById } from "../../db/movements/reads.js";
import { MovementReasonSchema } from "../../db/movements/schema.js";
import {
  getProductSupplierLink,
  getSupplierById,
} from "../../db/suppliers/reads.js";
import { getWarehouseById } from "../../db/warehouses/reads.js";
import { getSupabaseFromContext } from "../../supabase.js";

const RecordStockMovementArgsSchema = z.object({
  sku: z.string(),
  warehouseId: z.string(),
  delta: z.number(),
  reason: MovementReasonSchema,
  note: z.string().nullable().optional(),
  relatedMovementId: z.string().nullable().optional(),
  supplierId: z.string().nullable().optional(),
  unitCostCents: z.number().int().nullable().optional(),
  unitPriceCents: z.number().int().nullable().optional(),
});

const CreateWarehouseArgsSchema = z.object({
  name: z.string(),
  code: z.string(),
  location: z.string().nullable().optional(),
});

const UpdateWarehouseArgsSchema = z.object({
  warehouseId: z.string(),
  name: z.string().nullable().optional(),
  code: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
});

const DeactivateWarehouseArgsSchema = z.object({
  warehouseId: z.string(),
});

const TransferStockArgsSchema = z.object({
  sku: z.string(),
  fromWarehouseId: z.string(),
  toWarehouseId: z.string(),
  quantity: z.number(),
  note: z.string().nullable().optional(),
});

const SetReorderPointArgsSchema = z.object({
  sku: z.string(),
  warehouseId: z.string(),
  minStock: z.number(),
});

const BulkInitializeStockArgsSchema = z.object({
  warehouseId: z.string(),
  items: z.array(
    z.object({
      sku: z.string(),
      quantity: z.number(),
      unitCostCents: z.number().int(),
      supplierId: z.string(),
      note: z.string().nullable().optional(),
    }),
  ),
});

const ReverseStockMovementArgsSchema = z.object({
  movementId: z.string(),
  note: z.string().nullable(),
});

const CreateSupplierArgsSchema = z.object({
  name: z.string(),
  legal_name: z.string().nullable().optional(),
  tax_id: z.string().nullable().optional(),
  contact_name: z.string().nullable().optional(),
  contact_email: z.string().nullable().optional(),
  contact_phone: z.string().nullable().optional(),
  default_lead_time_days: z.number().nullable().optional(),
  payment_terms_days: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const UpdateSupplierArgsSchema = z.object({
  supplierId: z.string(),
}).passthrough();

const DeactivateSupplierArgsSchema = z.object({
  supplierId: z.string(),
});

const LinkProductSupplierArgsSchema = z.object({
  sku: z.string(),
  supplierId: z.string(),
  supplierSku: z.string().nullable().optional(),
  leadTimeDays: z.number().nullable().optional(),
  minOrderQty: z.number().nullable().optional(),
  isPreferred: z.boolean(),
  notes: z.string().nullable().optional(),
});

const UnlinkProductSupplierArgsSchema = z.object({
  sku: z.string(),
  supplierId: z.string(),
});

const SetPreferredSupplierArgsSchema = z.object({
  sku: z.string(),
  supplierId: z.string(),
});

const REASON_ES: Record<z.infer<typeof MovementReasonSchema>, string> = {
  intake: "entrada",
  sale: "venta",
  adjustment: "ajuste",
  loss: "merma",
  transfer: "traslado",
  reversal: "reversa",
  initial: "carga inicial",
};

function safeParse(rawArgs: string | undefined): unknown {
  if (!rawArgs) return undefined;
  try {
    return JSON.parse(rawArgs);
  } catch {
    return undefined;
  }
}

function formatMxn(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function shortDate(iso: string): string {
  return iso.replace("T", " ").slice(0, 10);
}

/**
 * Build a Spanish (es-MX) approval preview string for a HITL tool call.
 * Async so branches can perform DB lookups (e.g. resolving a movementId
 * into a human-readable description for reversals, or fetching a
 * supplier snapshot for cost/price provenance).
 */
export async function buildApprovalPreview(
  toolName: string,
  rawArgs: string | undefined,
  ctx: AgentContext,
): Promise<string> {
  if (!rawArgs) return `Confirma la operación: ${toolName}`;
  const parsed = safeParse(rawArgs);
  if (parsed === undefined) {
    return `Confirma la operación: ${toolName} (args ilegibles)`;
  }

  if (toolName === "recordStockMovement") {
    return previewRecordStockMovement(parsed, ctx);
  }
  if (toolName === "reverseStockMovement") {
    return previewReverseStockMovement(parsed, ctx);
  }
  if (toolName === "createSupplier") {
    return previewCreateSupplier(parsed);
  }
  if (toolName === "updateSupplier") {
    return previewUpdateSupplier(parsed, ctx);
  }
  if (toolName === "deactivateSupplier") {
    return previewDeactivateSupplier(parsed, ctx);
  }
  if (toolName === "linkProductSupplier") {
    return previewLinkProductSupplier(parsed, ctx);
  }
  if (toolName === "unlinkProductSupplier") {
    return previewUnlinkProductSupplier(parsed, ctx);
  }
  if (toolName === "setPreferredSupplier") {
    return previewSetPreferredSupplier(parsed, ctx);
  }
  if (toolName === "createWarehouse") {
    return previewCreateWarehouse(parsed);
  }
  if (toolName === "updateWarehouse") {
    return previewUpdateWarehouse(parsed, ctx);
  }
  if (toolName === "deactivateWarehouse") {
    return previewDeactivateWarehouse(parsed, ctx);
  }
  if (toolName === "bulkInitializeStock") {
    return previewBulkInitializeStock(parsed, ctx);
  }
  if (toolName === "transferStock") {
    return previewTransferStock(parsed, ctx);
  }
  if (toolName === "setReorderPoint") {
    return previewSetReorderPoint(parsed, ctx);
  }

  return `Confirma la operación: ${toolName} con args ${rawArgs}`;
}

async function previewTransferStock(
  parsed: unknown,
  ctx: AgentContext,
): Promise<string> {
  const result = TransferStockArgsSchema.safeParse(parsed);
  if (!result.success || !ctx.organizationId) {
    return `Confirma traslado (parámetros inválidos)`;
  }
  const { sku, fromWarehouseId, toWarehouseId, quantity, note } = result.data;
  const supabase = getSupabaseFromContext(ctx);
  let fromLabel = fromWarehouseId;
  let toLabel = toWarehouseId;
  try {
    const [src, dst] = await Promise.all([
      getWarehouseById(supabase, ctx.organizationId, fromWarehouseId),
      getWarehouseById(supabase, ctx.organizationId, toWarehouseId),
    ]);
    if (src) fromLabel = `${src.name} (${src.code})`;
    if (dst) toLabel = `${dst.name} (${dst.code})`;
  } catch {
    // best-effort
  }
  const noteSuffix = note ? ` Nota: "${note}".` : "";
  return `¿Confirmas trasladar ${quantity} unidades de ${sku} de la bodega **${fromLabel}** a **${toLabel}**? Se registrarán dos movimientos en una sola operación.${noteSuffix}`;
}

async function previewSetReorderPoint(
  parsed: unknown,
  ctx: AgentContext,
): Promise<string> {
  const result = SetReorderPointArgsSchema.safeParse(parsed);
  if (!result.success || !ctx.organizationId) {
    return `Confirma punto de reorden (parámetros inválidos)`;
  }
  const { sku, warehouseId, minStock } = result.data;
  let bodega = warehouseId;
  try {
    const w = await getWarehouseById(
      getSupabaseFromContext(ctx),
      ctx.organizationId,
      warehouseId,
    );
    if (w) bodega = `${w.name} (${w.code})`;
  } catch {
    // ignore
  }
  if (minStock === 0) {
    return `¿Confirmas eliminar el punto de reorden de **${sku}** en la bodega **${bodega}**?`;
  }
  return `¿Confirmas establecer el punto de reorden de **${sku}** en la bodega **${bodega}** a **${minStock} unidades**? Cuando la existencia caiga a ese nivel o menos, listLowStock (modo reorden) la incluirá.`;
}

async function previewRecordStockMovement(
  parsed: unknown,
  ctx: AgentContext,
): Promise<string> {
  const result = RecordStockMovementArgsSchema.safeParse(parsed);
  if (!result.success || !ctx.organizationId) {
    return `Confirma registro de movimiento (parámetros inválidos)`;
  }
  const { sku, warehouseId, delta, reason, note, supplierId, unitCostCents, unitPriceCents } =
    result.data;
  const sign = delta > 0 ? "+" : "";
  const reasonEs = REASON_ES[reason];
  const noteSuffix = note ? `, nota: "${note}"` : "";

  const supabase = getSupabaseFromContext(ctx);

  let warehouseLabel = "";
  try {
    const w = await getWarehouseById(supabase, ctx.organizationId, warehouseId);
    if (w) warehouseLabel = ` en bodega **${w.name}** (${w.code})`;
  } catch {
    // best-effort
  }

  let supplierLabel = "";
  if (supplierId) {
    try {
      const s = await getSupplierById(supabase, ctx.organizationId, supplierId);
      if (s) supplierLabel = ` del proveedor **${s.name}**`;
    } catch {
      // best-effort; fall through
    }
  }

  let costLine = "";
  let priceLine = "";

  if (reason === "intake" || reason === "initial") {
    const qty = Math.abs(delta);
    let effectiveCost = unitCostCents ?? null;
    let provenance = "costo nuevo";
    if (effectiveCost == null && supplierId) {
      try {
        const lookupSupabase = supabase;
        const productIdRes = await lookupSupabase
          .from("products")
          .select("id")
          .eq("organization_id", ctx.organizationId)
          .eq("sku", sku)
          .maybeSingle();
        if (productIdRes.data) {
          const productId = (productIdRes.data as { id: string }).id;
          const link = await getProductSupplierLink(lookupSupabase, productId, supplierId);
          if (link?.last_unit_cost_cents != null) {
            effectiveCost = link.last_unit_cost_cents;
            provenance = link.last_purchased_at
              ? `mismo costo que la última compra del ${shortDate(link.last_purchased_at)}`
              : "mismo costo que la última compra";
          }
        }
      } catch {
        // ignore lookup failure; preview still renders without provenance
      }
    }
    const total = effectiveCost != null ? effectiveCost * qty : null;
    costLine = ` a **${formatMxn(effectiveCost)}/u** (${provenance}). Total **${formatMxn(total)}**.`;
  }

  if (reason === "sale") {
    const qty = Math.abs(delta);
    let effectivePrice = unitPriceCents ?? null;
    let provenance = "precio nuevo";
    if (effectivePrice == null) {
      try {
        const prod = await supabase
          .from("products")
          .select("id, price_cents")
          .eq("organization_id", ctx.organizationId)
          .eq("sku", sku)
          .maybeSingle();
        if (prod.data) {
          const prodRow = prod.data as { id: string; price_cents: number | null };
          const lastSale = await supabase
            .from("product_last_sale_price")
            .select("unit_price_cents, last_sold_at")
            .eq("organization_id", ctx.organizationId)
            .eq("product_id", prodRow.id)
            .maybeSingle();
          const ls = lastSale.data as
            | { unit_price_cents: number | null; last_sold_at: string | null }
            | null;
          if (ls?.unit_price_cents != null) {
            effectivePrice = ls.unit_price_cents;
            provenance = ls.last_sold_at
              ? `mismo precio que la última venta del ${shortDate(ls.last_sold_at)}`
              : "mismo precio que la última venta";
          } else if (prodRow.price_cents != null) {
            effectivePrice = prodRow.price_cents;
            provenance = "precio de catálogo";
          }
        }
      } catch {
        // ignore
      }
    }
    const total = effectivePrice != null ? effectivePrice * qty : null;
    priceLine = ` a **${formatMxn(effectivePrice)}/u** (${provenance}). Total **${formatMxn(total)}**.`;
  }

  const economics = costLine || priceLine;
  return `¿Confirmas registrar un movimiento de ${sign}${delta} unidades de ${sku}${warehouseLabel}${supplierLabel} (${reasonEs})${economics}${noteSuffix}?`;
}

function previewCreateWarehouse(parsed: unknown): string {
  const result = CreateWarehouseArgsSchema.safeParse(parsed);
  if (!result.success) return `Confirma crear bodega (parámetros inválidos)`;
  const a = result.data;
  const loc = a.location ? ` — ubicación: ${a.location}` : "";
  return `¿Confirmas crear la bodega **${a.name}** con código **${a.code.toUpperCase()}**${loc}?`;
}

async function previewUpdateWarehouse(
  parsed: unknown,
  ctx: AgentContext,
): Promise<string> {
  const result = UpdateWarehouseArgsSchema.safeParse(parsed);
  if (!result.success || !ctx.organizationId) {
    return `Confirma actualizar bodega (parámetros inválidos)`;
  }
  const { warehouseId } = result.data;
  let name = warehouseId;
  try {
    const w = await getWarehouseById(
      getSupabaseFromContext(ctx),
      ctx.organizationId,
      warehouseId,
    );
    if (w) name = `${w.name} (${w.code})`;
  } catch {
    // ignore
  }
  const changes: string[] = [];
  if (result.data.name != null) changes.push(`nombre → ${result.data.name}`);
  if (result.data.code != null) changes.push(`código → ${result.data.code.toUpperCase()}`);
  if (result.data.location != null) changes.push(`ubicación → ${result.data.location}`);
  const detail = changes.length > 0 ? ` Cambios: ${changes.join("; ")}.` : "";
  return `¿Confirmas actualizar la bodega **${name}**?${detail}`;
}

async function previewDeactivateWarehouse(
  parsed: unknown,
  ctx: AgentContext,
): Promise<string> {
  const result = DeactivateWarehouseArgsSchema.safeParse(parsed);
  if (!result.success || !ctx.organizationId) {
    return `Confirma desactivar bodega (parámetros inválidos)`;
  }
  const { warehouseId } = result.data;
  let name = warehouseId;
  try {
    const w = await getWarehouseById(
      getSupabaseFromContext(ctx),
      ctx.organizationId,
      warehouseId,
    );
    if (w) name = `${w.name} (${w.code})`;
  } catch {
    // ignore
  }
  return `¿Confirmas desactivar la bodega **${name}**? El historial se conserva; quedará oculta de listados por defecto.`;
}

async function previewBulkInitializeStock(
  parsed: unknown,
  ctx: AgentContext,
): Promise<string> {
  const result = BulkInitializeStockArgsSchema.safeParse(parsed);
  if (!result.success || !ctx.organizationId) {
    return `Confirma carga inicial (parámetros inválidos)`;
  }
  const { warehouseId, items } = result.data;
  let name = warehouseId;
  try {
    const w = await getWarehouseById(
      getSupabaseFromContext(ctx),
      ctx.organizationId,
      warehouseId,
    );
    if (w) name = `${w.name} (${w.code})`;
  } catch {
    // ignore
  }
  const totalUnits = items.reduce((sum, i) => sum + i.quantity, 0);
  const totalCost = items.reduce((sum, i) => sum + i.quantity * i.unitCostCents, 0);
  const lines = items
    .slice(0, 5)
    .map(
      (i) =>
        `- ${i.sku}: ${i.quantity} u. a ${formatMxn(i.unitCostCents)}/u`,
    )
    .join("\n");
  const tail = items.length > 5 ? `\n…y ${items.length - 5} más` : "";
  return `¿Confirmas carga inicial en la bodega **${name}** con ${items.length} producto(s), total ${totalUnits} unidades por ${formatMxn(
    totalCost,
  )}?\n${lines}${tail}`;
}

async function previewReverseStockMovement(
  parsed: unknown,
  ctx: AgentContext,
): Promise<string> {
  const result = ReverseStockMovementArgsSchema.safeParse(parsed);
  if (!result.success || !ctx.organizationId) {
    return `Confirma reversar movimiento (parámetros inválidos)`;
  }
  const { movementId, note } = result.data;
  try {
    const supabase = getSupabaseFromContext(ctx);
    const original = await getMovementById(supabase, ctx.organizationId, movementId);
    if (!original) {
      return `No encontré el movimiento ${movementId} en esta organización. Si confirmas, la operación fallará.`;
    }
    const sign = original.delta > 0 ? "+" : "";
    const reasonEs = REASON_ES[original.reason];
    const compensating = original.delta > 0 ? `${-original.delta}` : `+${-original.delta}`;
    const when = original.created_at.replace("T", " ").slice(0, 16);
    const noteSuffix = note ? ` Nota: "${note}".` : "";
    return `¿Confirmas reversar el movimiento de ${original.sku} (${original.name}) de ${sign}${original.delta} unidades (${reasonEs}) registrado el ${when}? Quedará anulado con una contra-entrada de ${compensating}.${noteSuffix}`;
  } catch (e) {
    return `Confirma reversar movimiento ${movementId} (no pude leer detalles: ${(e as Error).message}).`;
  }
}

function previewCreateSupplier(parsed: unknown): string {
  const result = CreateSupplierArgsSchema.safeParse(parsed);
  if (!result.success) return `Confirma crear proveedor (parámetros inválidos)`;
  const a = result.data;
  const parts: string[] = [];
  if (a.tax_id) parts.push(`RFC ${a.tax_id}`);
  if (a.contact_name) parts.push(`contacto ${a.contact_name}`);
  if (a.default_lead_time_days != null) parts.push(`lead time ${a.default_lead_time_days} días`);
  if (a.payment_terms_days != null) parts.push(`neto ${a.payment_terms_days} días`);
  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `¿Confirmas crear el proveedor **${a.name}**${detail}?`;
}

async function previewUpdateSupplier(
  parsed: unknown,
  ctx: AgentContext,
): Promise<string> {
  const result = UpdateSupplierArgsSchema.safeParse(parsed);
  if (!result.success || !ctx.organizationId) {
    return `Confirma actualizar proveedor (parámetros inválidos)`;
  }
  const supplierId = (result.data as { supplierId: string }).supplierId;
  let name = supplierId;
  try {
    const s = await getSupplierById(
      getSupabaseFromContext(ctx),
      ctx.organizationId,
      supplierId,
    );
    if (s) name = s.name;
  } catch {
    // ignore
  }
  const data = result.data as Record<string, unknown>;
  const changes: string[] = [];
  for (const k of [
    "name",
    "legal_name",
    "tax_id",
    "contact_name",
    "contact_email",
    "contact_phone",
    "default_lead_time_days",
    "payment_terms_days",
    "currency",
    "notes",
  ]) {
    const v = data[k];
    if (v != null) changes.push(`${k} → ${v}`);
  }
  const detail = changes.length > 0 ? ` Cambios: ${changes.join("; ")}.` : "";
  return `¿Confirmas actualizar el proveedor **${name}**?${detail}`;
}

async function previewDeactivateSupplier(
  parsed: unknown,
  ctx: AgentContext,
): Promise<string> {
  const result = DeactivateSupplierArgsSchema.safeParse(parsed);
  if (!result.success || !ctx.organizationId) {
    return `Confirma desactivar proveedor (parámetros inválidos)`;
  }
  const { supplierId } = result.data;
  let name = supplierId;
  try {
    const s = await getSupplierById(
      getSupabaseFromContext(ctx),
      ctx.organizationId,
      supplierId,
    );
    if (s) name = s.name;
  } catch {
    // ignore
  }
  return `¿Confirmas desactivar el proveedor **${name}**? El historial se conserva; quedará oculto de listados por defecto.`;
}

async function previewLinkProductSupplier(
  parsed: unknown,
  ctx: AgentContext,
): Promise<string> {
  const result = LinkProductSupplierArgsSchema.safeParse(parsed);
  if (!result.success || !ctx.organizationId) {
    return `Confirma vincular producto y proveedor (parámetros inválidos)`;
  }
  const a = result.data;
  let supplierName = a.supplierId;
  try {
    const s = await getSupplierById(
      getSupabaseFromContext(ctx),
      ctx.organizationId,
      a.supplierId,
    );
    if (s) supplierName = s.name;
  } catch {
    // ignore
  }
  const parts: string[] = [];
  if (a.supplierSku) parts.push(`SKU del proveedor: ${a.supplierSku}`);
  if (a.leadTimeDays != null) parts.push(`lead time ${a.leadTimeDays} días`);
  if (a.minOrderQty != null) parts.push(`MOQ ${a.minOrderQty}`);
  if (a.isPreferred) parts.push("preferido");
  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `¿Confirmas vincular **${a.sku}** con el proveedor **${supplierName}**${detail}?`;
}

async function previewUnlinkProductSupplier(
  parsed: unknown,
  ctx: AgentContext,
): Promise<string> {
  const result = UnlinkProductSupplierArgsSchema.safeParse(parsed);
  if (!result.success || !ctx.organizationId) {
    return `Confirma desvincular producto y proveedor (parámetros inválidos)`;
  }
  const { sku, supplierId } = result.data;
  let supplierName = supplierId;
  try {
    const s = await getSupplierById(
      getSupabaseFromContext(ctx),
      ctx.organizationId,
      supplierId,
    );
    if (s) supplierName = s.name;
  } catch {
    // ignore
  }
  return `¿Confirmas desvincular **${sku}** del proveedor **${supplierName}**? El historial de movimientos se conserva.`;
}

async function previewSetPreferredSupplier(
  parsed: unknown,
  ctx: AgentContext,
): Promise<string> {
  const result = SetPreferredSupplierArgsSchema.safeParse(parsed);
  if (!result.success || !ctx.organizationId) {
    return `Confirma marcar proveedor preferido (parámetros inválidos)`;
  }
  const { sku, supplierId } = result.data;
  let supplierName = supplierId;
  try {
    const s = await getSupplierById(
      getSupabaseFromContext(ctx),
      ctx.organizationId,
      supplierId,
    );
    if (s) supplierName = s.name;
  } catch {
    // ignore
  }
  return `¿Confirmas marcar **${supplierName}** como proveedor preferido de **${sku}**? Esto desmarca al proveedor preferido anterior (si lo había).`;
}
